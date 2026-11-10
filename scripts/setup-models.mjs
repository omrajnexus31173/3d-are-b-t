#!/usr/bin/env node
/**
 * BHARAT-AV model & runtime fetcher.
 *
 * Downloads (into `public/`, which is git-ignored because these are large
 * binaries) everything the real-time detection pipeline needs:
 *
 *   public/models/yolo11n.onnx          YOLO11n COCO-80, ONNX (primary detector)
 *   public/vendor/ort/*                 ONNX Runtime Web (wasm, offline)
 *   public/models/nanodet/model.json    NanoDet-m TF.js (fallback detector)
 *   public/models/nanodet/nanodet.bin
 *   public/vendor/tf.min.js             TensorFlow.js UMD (fallback runtime)
 *
 * Optional pothole model (user supplied — generic COCO weights cannot detect
 * potholes, so nothing is invented here):
 *
 *   POTHOLE_MODEL_URL=https://…/pothole.onnx  node scripts/setup-models.mjs
 *   -- or place the file at public/models/pothole.onnx yourself.
 *
 * Usage:
 *   npm run setup:models            # everything
 *   npm run setup:models -- --only=yolo
 *   npm run setup:models -- --only=ort,tfjs
 *   npm run setup:models -- --force
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile, copyFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const YOLO_URL =
  process.env.YOLO_MODEL_URL ??
  'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n.onnx';
const YOLO_FALLBACK_URLS = [
  'https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.onnx',
];
const NANODET_PACKAGE = process.env.TFJS_MODEL_PACKAGE ?? '@vladmandic/human-models@3.0.4';
const TFJS_PACKAGE = process.env.TFJS_PACKAGE ?? '@tensorflow/tfjs@4.22.0';

const args = process.argv.slice(2);
const only = args
  .find((a) => a.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const force = args.includes('--force');
const shouldRun = (name) => !only || only.includes(name);

const log = (...m) => console.log('[setup:models]', ...m);
const warn = (...m) => console.warn('[setup:models]', ...m);

async function exists(p) {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(1)} ${units[i]}`;
}

async function download(url, dest, { minBytes = 1024 } = {}) {
  await mkdir(path.dirname(dest), { recursive: true });
  log(`GET ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const size = await exists(tmp);
  if (size < minBytes) {
    await rm(tmp, { force: true });
    throw new Error(`downloaded file is too small (${size} bytes)`);
  }
  await rm(dest, { force: true });
  await copyFile(tmp, dest);
  await rm(tmp, { force: true });
  return size;
}

/** Validate that a file really is a serialized ONNX model (protobuf magic 0x08). */
async function verifyOnnx(p) {
  const buf = await readFile(p);
  if (buf.byteLength < 1024) return { ok: false, reason: `too small (${buf.byteLength} B)` };
  const head = buf.subarray(0, 64).toString('utf8');
  if (head.startsWith('version https://git-lfs')) {
    return { ok: false, reason: 'Git LFS pointer, not the model' };
  }
  if (buf[0] !== 0x08) return { ok: false, reason: `unexpected magic 0x${buf[0].toString(16)}` };
  const tail = buf.subarray(-8).toString('latin1');
  return {
    ok: true,
    bytes: buf.byteLength,
    sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    tailPrintable: /[a-zA-Z]|onnx/i.test(tail),
  };
}

async function installYolo() {
  const dest = path.join(PUBLIC, 'models', 'yolo11n.onnx');
  const existing = await exists(dest);
  if (existing && !force) {
    const v = await verifyOnnx(dest);
    if (v.ok) {
      log(`YOLO11n already present (${formatBytes(existing)}, sha256:${v.sha256}…)`);
      return true;
    }
    warn(`existing yolo11n.onnx is invalid (${v.reason}) — re-downloading`);
  }
  for (const url of [YOLO_URL, ...YOLO_FALLBACK_URLS]) {
    try {
      const size = await download(url, dest, { minBytes: 1_000_000 });
      const v = await verifyOnnx(dest);
      if (!v.ok) throw new Error(`verification failed: ${v.reason}`);
      log(`✅ YOLO11n installed → ${path.relative(ROOT, dest)} (${formatBytes(size)})`);
      return true;
    } catch (err) {
      warn(`failed: ${url} — ${err.message}`);
    }
  }
  warn(
    '❌ could not download a detector model automatically.\n' +
      '   Download yolo11n.onnx (or yolov8n.onnx) manually and save it as\n' +
      `   ${path.relative(ROOT, dest)}\n` +
      '   Source: ' +
      YOLO_URL
  );
  return false;
}

async function installOrt() {
  const src = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const dst = path.join(PUBLIC, 'vendor', 'ort');
  if (!(await exists(path.join(src, 'ort.min.mjs')))) {
    warn('onnxruntime-web is not installed — run `npm install` first.');
    return false;
  }
  await mkdir(dst, { recursive: true });
  const files = (await readdir(src)).filter(
    (f) =>
      f === 'ort.min.mjs' ||
      /^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/.test(f) ||
      /^ort-wasm\.(mjs|wasm)$/.test(f)
  );
  let bytes = 0;
  for (const f of files) {
    await copyFile(path.join(src, f), path.join(dst, f));
    bytes += await exists(path.join(dst, f));
  }
  log(`✅ ONNX Runtime Web copied (${files.length} files, ${formatBytes(bytes)}) → public/vendor/ort/`);
  return true;
}

let npmTarballCache = new Map();

async function npmPack(spec) {
  if (npmTarballCache.has(spec)) return npmTarballCache.get(spec);
  const cacheDir = path.join(ROOT, '.cache-models');
  await mkdir(cacheDir, { recursive: true });
  const out = await new Promise((resolve, reject) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', spec, '--pack-destination', cacheDir],
      { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    );
  });
  const last = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const file = path.join(cacheDir, last.replace(/^.*[\\/]/, ''));
  npmTarballCache.set(spec, file);
  return file;
}

async function extractFromTarball(tarball, members, destDir) {
  await mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-xzf', tarball, '-C', destDir, ...members],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function installTfjsFallback() {
  try {
    const tarball = await npmPack(TFJS_PACKAGE);
    const staging = path.join(ROOT, '.cache-models', 'tfjs');
    await rm(staging, { recursive: true, force: true });
    await extractFromTarball(tarball, ['package/dist/tf.es2017.min.js'], staging);
    const dest = path.join(PUBLIC, 'vendor', 'tf.min.js');
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(staging, 'package', 'dist', 'tf.es2017.min.js'), dest);
    log(`✅ TensorFlow.js runtime → public/vendor/tf.min.js (${formatBytes(await exists(dest))})`);
  } catch (err) {
    warn(`TF.js fallback runtime not installed: ${err.message}`);
    return false;
  }

  try {
    const tarball = await npmPack(NANODET_PACKAGE);
    const staging = path.join(ROOT, '.cache-models', 'nanodet');
    await rm(staging, { recursive: true, force: true });
    await extractFromTarball(tarball, ['package/models/nanodet.json', 'package/models/nanodet.bin'], staging);
    const destDir = path.join(PUBLIC, 'models', 'nanodet');
    await mkdir(destDir, { recursive: true });
    // TF.js expects the weight manifest to live next to model.json with the
    // shard file named in `weightsManifest[].paths`.
    const meta = JSON.parse(await readFile(path.join(staging, 'package', 'models', 'nanodet.json'), 'utf8'));
    const shardName = meta?.weightsManifest?.[0]?.paths?.[0] ?? 'group1-shard1of1';
    meta.weightsManifest = meta.weightsManifest.map((m) => ({ ...m, paths: ['nanodet.bin'] }));
    await writeFile(path.join(destDir, 'model.json'), JSON.stringify(meta));
    await copyFile(path.join(staging, 'package', 'models', 'nanodet.bin'), path.join(destDir, 'nanodet.bin'));
    log(
      `✅ NanoDet-m fallback model → public/models/nanodet/ (model.json references "nanodet.bin", original shard "${shardName}")`
    );
    return true;
  } catch (err) {
    warn(`NanoDet fallback model not installed: ${err.message}`);
    return false;
  }
}

async function installPothole() {
  const dest = path.join(PUBLIC, 'models', 'pothole.onnx');
  const url = process.env.POTHOLE_MODEL_URL;
  if (!url) {
    if (await exists(dest)) {
      const v = await verifyOnnx(dest);
      log(`pothole model present (${v.ok ? 'valid' : v.reason})`);
      return v.ok;
    }
    log(
      'ℹ️  pothole model NOT configured (expected). Generic COCO weights cannot detect potholes.\n' +
        '   To enable it: train/obtain a pothole detector and either\n' +
        `     • place it at ${path.relative(ROOT, dest)}, or\n` +
        '     • set POTHOLE_MODEL_URL=<https url> and re-run this script, or\n' +
        '     • upload it from the UI ("Pothole model → Upload .onnx").'
    );
    return false;
  }
  try {
    const size = await download(url, dest, { minBytes: 10_000 });
    const v = await verifyOnnx(dest);
    if (!v.ok) throw new Error(v.reason);
    log(`✅ pothole model installed (${formatBytes(size)})`);
    return true;
  } catch (err) {
    warn(`❌ pothole model download failed: ${err.message}`);
    return false;
  }
}

async function main() {
  log('installing BHARAT-AV detection assets (public/ is git-ignored)');
  const results = {};
  if (shouldRun('yolo')) results.yolo = await installYolo();
  if (shouldRun('ort')) results.ort = await installOrt();
  if (shouldRun('tfjs')) results.tfjs = await installTfjsFallback();
  if (shouldRun('pothole')) results.pothole = await installPothole();
  await rm(path.join(ROOT, '.cache-models'), { recursive: true, force: true });

  log('--- summary ---');
  for (const [k, v] of Object.entries(results)) {
    log(`${v ? 'ok  ' : 'miss'} ${k}`);
  }
  if (!results.yolo) {
    warn('Detection will report "model not configured" until weights are installed.');
  }
}

main().catch((err) => {
  console.error('[setup:models] fatal:', err);
  process.exit(1);
});
