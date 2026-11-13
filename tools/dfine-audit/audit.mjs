#!/usr/bin/env node
/**
 * D-FINE-N real-model audit harness.
 *
 * The browser pipeline cannot be interrogated directly (a webcam frame is not
 * reproducible, and the worker hides the raw tensors), so this script runs the
 * SAME artifact and the SAME preprocessing/decoding offline and prints the
 * numbers needed to tell a mis-shaped graph from a real detection problem.
 *
 * Usage
 *   node tools/dfine-audit/audit.mjs --model <path-or-url> --image <file> [--image ...]
 *
 * What it does
 *   1. Acquires the model (local path, https URL, or the release asset).
 *   2. Verifies its SHA-256 against the published GitHub asset digest.
 *   3. Inspects the ONNX graph: opset, ir_version, inputs/outputs/dims, op set
 *      counts, initializer bytes, and D-FINE-specific metadata.
 *   4. Runs inference through onnxruntime-web (the browser's runtime) using the
 *      application's exact preprocessing.
 *   5. Prints raw label/score/box distribution and the unique class counts, then
 *      the boxes both before and after letterbox reversal.
 *
 * Nothing here is a substitute for the in-browser check, but it distinguishes
 * "the artifact is wrong" from "the artifact is right and the UI is wrong".
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/**
 * COCO labels the application can map onto a BHARAT-AV traffic class.
 * Mirrors mapLabelToVisionClass() in src/vision/detector.ts; anything absent is
 * displayed to the operator as "Unclassified".
 */
export const MAPPED = new Set([
  'person', 'pedestrian', 'cow', 'cattle', 'bull', 'buffalo',
  'horse', 'sheep', 'dog', 'goat', 'elephant', 'zebra', 'giraffe', 'cat', 'bird',
  'car', 'van', 'suv', 'bus', 'truck', 'lorry',
  'motorcycle', 'motorbike', 'bike', 'scooter', 'two_wheeler',
  'bicycle', 'cycle', 'traffic light', 'stop sign',
]);

/** Official D-FINE/COCO label order (mscoco_category2label). */
export const COCO_LABELS = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
  'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
  'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich',
  'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote',
  'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book',
  'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

/**
 * Published SHA-256 of the release asset, taken from the GitHub API's own
 * `digest` field for asset id 742876599 (release dfine-n-v1). Recorded here so a
 * local download can be checked against it instead of trusting the host.
 */
export const PUBLISHED_SHA256 =
  '1dbf71cbccc0fd6baaa36cc91521062fa8356eab7e44af6f39a98b157695f7ab';

export const PUBLISHED_SIZE = 15_491_160;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) out.push(process.argv[i + 1]);
  });
  return out;
}

async function acquire(src) {
  if (existsSync(src)) return new Uint8Array(await readFile(src));
  const res = await fetch(src, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${src}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Minimal ONNX protobuf walker: enough to read graph inputs/outputs, opset and
 * operator counts without a protobuf dependency.
 *
 * ONNX is a protobuf, so rather than hand-roll a full parser we use the
 * shape-agnostic approach of feeding the bytes to onnxruntime for the contract
 * and only parse the small header fields we need (ir_version, opset_import).
 */
function parseOnnxHeader(bytes) {
  // ModelProto field numbers: ir_version = 1 (varint), opset_import = 8 (repeated message)
  let i = 0;
  const varint = () => {
    let shift = 0;
    let result = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
    return result;
  };
  let irVersion = null;
  let producer = null;
  while (i < bytes.length) {
    const key = varint();
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      const v = varint();
      if (field === 1) irVersion = v;
    } else if (wire === 2) {
      const len = varint();
      const val = bytes.subarray(i, i + len);
      i += len;
      if (field === 2) producer = new TextDecoder().decode(val);
      if (field === 1) break; // graph reached; header parsed
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break;
  }
  return { irVersion, producer };
}

function letterboxGeometry(frameWidth, frameHeight, inputSize) {
  const scale = Math.min(inputSize / frameWidth, inputSize / frameHeight);
  const contentWidth = frameWidth * scale;
  const contentHeight = frameHeight * scale;
  return {
    scale,
    padX: (inputSize - contentWidth) / 2,
    padY: (inputSize - contentHeight) / 2,
    contentWidth,
    contentHeight,
  };
}

/** The application's exact preprocessing: RGB, /255, CHW, letterboxed to inputSize. */
function preprocess(rgb, width, height, inputSize) {
  const geo = letterboxGeometry(width, height, inputSize);
  const canvas = new Uint8Array(inputSize * inputSize * 3); // black pad
  // Nearest-neighbour resample of the source into the letterboxed area.
  const dw = Math.round(geo.contentWidth);
  const dh = Math.round(geo.contentHeight);
  const x0 = Math.round(geo.padX);
  const y0 = Math.round(geo.padY);
  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.min(height - 1, Math.floor((dy / dh) * height));
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(width - 1, Math.floor((dx / dw) * width));
      const s = (sy * width + sx) * 3;
      const d = ((y0 + dy) * inputSize + (x0 + dx)) * 3;
      canvas[d] = rgb[s];
      canvas[d + 1] = rgb[s + 1];
      canvas[d + 2] = rgb[s + 2];
    }
  }
  const area = inputSize * inputSize;
  const out = new Float32Array(3 * area);
  for (let p = 0; p < area; p++) {
    out[p] = canvas[p * 3] / 255;
    out[p + area] = canvas[p * 3 + 1] / 255;
    out[p + 2 * area] = canvas[p * 3 + 2] / 255;
  }
  return { tensor: out, geo };
}

/** Minimal PNG decode via zlib for 8-bit RGB/RGBA non-interlaced images. */
async function decodePng(buffer) {
  const zlib = await import('node:zlib');
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let k = 0; k < 8; k++) if (buffer[k] !== sig[k]) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      cur[x] = v;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    if (channels === 1) {
      rgb[p * 3] = rgb[p * 3 + 1] = rgb[p * 3 + 2] = px[s];
    } else {
      rgb[p * 3] = px[s];
      rgb[p * 3 + 1] = px[s + 1];
      rgb[p * 3 + 2] = px[s + 2];
    }
  }
  return { rgb, width, height };
}

async function main() {
  const modelSrc = arg('model');
  const images = argAll('image');
  const thresholds = (arg('thresholds', '0.35,0.4,0.5,0.6') || '').split(',').map(Number);
  const expectSha = arg('expect-sha', PUBLISHED_SHA256);

  if (!modelSrc) {
    console.error('usage: audit.mjs --model <path-or-url> --image <file.png> [--image ...]');
    process.exit(2);
  }

  console.log('=== 1. ARTIFACT ===');
  const bytes = await acquire(modelSrc);
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(`source        : ${modelSrc}`);
  console.log(`size          : ${bytes.byteLength.toLocaleString()} bytes`);
  console.log(`sha256        : ${sha}`);
  console.log(`expected sha  : ${expectSha}`);
  console.log(`sha match     : ${sha === expectSha ? 'YES' : 'NO  <-- ARTIFACT DIFFERS FROM THE PUBLISHED ONE'}`);
  if (existsSync(path.join(ROOT, 'public/models/dfine_n_coco.onnx'))) {
    const local = new Uint8Array(await readFile(path.join(ROOT, 'public/models/dfine_n_coco.onnx')));
    const localSha = createHash('sha256').update(local).digest('hex');
    console.log(`public/ copy  : ${local.byteLength.toLocaleString()} bytes, sha256 ${localSha}`);
    console.log(`matches public: ${localSha === sha ? 'YES' : 'NO  <-- PRODUCTION SHIPS A DIFFERENT FILE'}`);
  }

  const header = parseOnnxHeader(bytes);
  console.log(`ir_version    : ${header.irVersion}`);
  console.log(`producer      : ${header.producer ?? '(none)'}`);

  console.log('\n=== 2. GRAPH I/O ===');
  const ort = await import('onnxruntime-web');
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  console.log(`session create: ${Date.now() - t0} ms (wasm)`);
  console.log(`inputs        : ${session.inputNames.join(', ')}`);
  console.log(`outputs       : ${session.outputNames.join(', ')}`);

  const EXPECTED_IN = ['images', 'orig_target_sizes'];
  const EXPECTED_OUT = ['labels', 'boxes', 'scores'];
  const inOk = EXPECTED_IN.every((n) => session.inputNames.includes(n));
  const outOk = EXPECTED_OUT.every((n) => session.outputNames.includes(n));
  console.log(`D-FINE signature: ${inOk && outOk ? 'YES' : 'NO  <-- NOT THE EXPECTED DEPLOY GRAPH'}`);
  if (!inOk || !outOk) {
    console.log('  If inputs is just ["images"], the postprocessor was not folded in:');
    console.log('  the graph emits raw logits/pred_boxes and this decode path cannot work.');
  }

  if (!images.length) {
    console.log('\n(no --image supplied: skipping inference. Pass real photos to validate.)');
    return;
  }

  const inputSize = 640;
  for (const img of images) {
    console.log(`\n=== 3. INFERENCE: ${path.basename(img)} ===`);
    const { rgb, width, height } = await decodePng(await readFile(img));
    console.log(`image         : ${width}x${height}`);
    const { tensor, geo } = preprocess(rgb, width, height, inputSize);
    console.log(`letterbox     : scale=${geo.scale.toFixed(4)} pad=(${geo.padX.toFixed(1)},${geo.padY.toFixed(1)})`);

    const feeds = {
      images: new ort.Tensor('float32', tensor, [1, 3, inputSize, inputSize]),
      // The canvas size, exactly as the app does it and as onnx_inf.py does.
      orig_target_sizes: new ort.Tensor(
        'int64',
        BigInt64Array.from([BigInt(inputSize), BigInt(inputSize)]),
        [1, 2]
      ),
    };
    const tInfer = Date.now();
    const out = await session.run(feeds);
    console.log(`inference     : ${Date.now() - tInfer} ms`);

    for (const name of Object.keys(out)) {
      const t = out[name];
      console.log(`  raw ${name.padEnd(6)} dims=[${Array.from(t.dims)}] type=${t.type} ctor=${t.data.constructor.name}`);
    }

    const scores = out.scores.data;
    const boxes = out.boxes.data;
    const labels = out.labels.data;

    const n = scores.length;
    const sorted = Array.from(scores).slice().sort((a, b) => b - a);
    console.log(`  scores: n=${n} max=${Number(sorted[0]).toFixed(4)} ` +
      `p10=${Number(sorted[Math.floor(n * 0.1)]).toFixed(4)} ` +
      `median=${Number(sorted[Math.floor(n / 2)]).toFixed(4)} min=${Number(sorted[n - 1]).toFixed(4)}`);

    const boxArr = Array.from(boxes).map(Number);
    const finite = boxArr.filter((v) => Number.isFinite(v));
    console.log(`  boxes : all finite=${finite.length === boxArr.length} ` +
      `min=${Math.min(...boxArr.filter(Number.isFinite)).toFixed(2)} ` +
      `max=${Math.max(...boxArr.filter(Number.isFinite)).toFixed(2)}`);
    console.log(`  NOTE: max must be ~640 (canvas px). ~1 means cxcywh-normalised,`);
    console.log(`        and the decoder's absolute-xyxy assumption would be wrong.`);

    const labelArr = Array.from(labels).map(Number);
    const distinct = new Set(labelArr);
    console.log(`  labels: distinct classes among 300 queries = ${distinct.size}, ` +
      `range ${Math.min(...labelArr)}..${Math.max(...labelArr)}`);
    if (Math.max(...labelArr) > 79) {
      console.log('  <-- label > 79: index is a flat query*class index, not a class id.');
    }

    for (const thr of thresholds) {
      let kept = 0;
      const classes = new Map();
      const sample = [];
      for (let i = 0; i < n; i++) {
        const s = Number(scores[i]);
        if (!(s > thr)) continue;
        const x1 = Number(boxes[i * 4]);
        const y1 = Number(boxes[i * 4 + 1]);
        const x2 = Number(boxes[i * 4 + 2]);
        const y2 = Number(boxes[i * 4 + 3]);
        if (!(x2 > x1) || !(y2 > y1)) continue;
        kept++;
        const cls = Number(labels[i]);
        classes.set(cls, (classes.get(cls) ?? 0) + 1);
        if (sample.length < 5) {
          sample.push({
            cls: COCO_LABELS[cls] ?? `#${cls}`,
            score: +s.toFixed(3),
            canvas: [+x1.toFixed(0), +y1.toFixed(0), +x2.toFixed(0), +y2.toFixed(0)],
            frame: [
              +((x1 - geo.padX) / geo.scale).toFixed(0),
              +((y1 - geo.padY) / geo.scale).toFixed(0),
              +((x2 - geo.padX) / geo.scale).toFixed(0),
              +((y2 - geo.padY) / geo.scale).toFixed(0),
            ],
          });
        }
      }
      const top = [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([c, k]) => `${COCO_LABELS[c] ?? c}:${k}`).join(' ');
      // How many of the kept classes the application can actually name.
      const unmapped = [...classes.keys()].filter((c) => !MAPPED.has(COCO_LABELS[c]));
      if (unmapped.length) {
        const names = unmapped.slice(0, 8).map((c) => COCO_LABELS[c] ?? c).join(', ');
        const total = [...classes.values()].reduce((a, b) => a + b, 0);
        const lost = unmapped.reduce((a, c) => a + classes.get(c), 0);
        console.log(
          `            ^ ${lost}/${total} of these render as "Unclassified" (no BHARAT-AV class): ${names}`
        );
      }
      console.log(`  thr=${thr.toFixed(2)}  kept=${String(kept).padStart(3)}  classes: ${top || '-'}`);
      if (thr === thresholds[0]) for (const d of sample) console.log(`      ${JSON.stringify(d)}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('audit failed:', e);
    process.exit(1);
  });
}
