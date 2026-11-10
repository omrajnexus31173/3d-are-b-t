/**
 * Detection worker.
 *
 * Runs in a dedicated Web Worker so that inference never blocks the React UI or
 * the existing simulation loop. The worker owns:
 *   - model download + session creation (ONNX Runtime Web, TF.js fallback)
 *   - letterboxing / normalisation of frames received as ImageBitmap
 *   - YOLO decoding, NMS and frame-space projection
 *
 * Messages are plain structured-clone objects; frames are transferred as
 * ImageBitmap to avoid copies.
 */
import { decodeYoloOutput, nonMaxSuppression, unletterboxBox } from './detector';

import type { BoundingBox } from './types';
import {
  disposeTfjsDetector,
  loadTfjsDetector,
  runTfjsDetectorFromPixels,
  warmUpTfjsDetector,
  type TfjsDetectorLoadResult,
  type NanoDetOutputTensor,
} from './tfjsDetector';

export type WorkerRequest =
  | {
      type: 'load';
      requestId: number;
      backend: 'onnxruntime-web' | 'tfjs';
      modelUrl: string;
      /** Candidate URLs probed in order (ONNX only). */
      candidates?: string[];
      inputSize: number;
      labels: string[];
      modelId: string;
      /** Optional user-supplied weights (takes precedence over modelUrl). */
      modelBytes?: ArrayBuffer;
    }
  | {
      type: 'infer';
      requestId: number;
      /**
       * Letterboxed square RGB frame produced on the main thread
       * (`inputSize * inputSize * 3` bytes, row-major, R,G,B).
       *
       * Letterboxing on the main thread keeps the worker free of OffscreenCanvas
       * readback, which is the slow/flaky path on software renderers, and lets us
       * transfer a single small buffer per frame.
       */
      pixels: ArrayBuffer;
      inputSize: number;
      scale: number;
      padX: number;
      padY: number;
      frameWidth: number;
      frameHeight: number;
      threshold: number;
      nmsIou: number;
      maxDetections: number;
      timestampMs: number;
    }
  | { type: 'reset'; requestId: number };

export interface WorkerDetection {
  box: BoundingBox;
  label: string;
  classIndex: number;
  confidence: number;
}

export type WorkerResponse =
  | {
      type: 'loaded';
      requestId: number;
      backend: 'onnxruntime-web' | 'tfjs';
      resolvedUrl: string;
      inputSize: number;
      loadMs: number;
      executionProvider: string;
      inputNames?: string[];
      outputNames?: string[];
      bytes?: number;
    }
  | { type: 'error'; requestId: number; scope: 'load' | 'infer'; message: string }
  | {
      type: 'result';
      requestId: number;
      detections: WorkerDetection[];
      inferenceMs: number;
      preprocessMs: number;
      postprocessMs: number;
      frameWidth: number;
      frameHeight: number;
      timestampMs: number;
    }
  | { type: 'reset_done'; requestId: number };

interface LoadedOnnx {
  backend: 'onnxruntime-web';
  session: import('./onnx').OnnxSession;
  inputSize: number;
  labels: string[];
}

interface LoadedTfjs {
  backend: 'tfjs';
  loaded: TfjsDetectorLoadResult;
  inputSize: number;
  labels: string[];
}

type Loaded = LoadedOnnx | LoadedTfjs;

let loaded: Loaded | null = null;

const devLog = (...args: unknown[]) => {
  if (import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.log('[detector-worker]', ...args);
  }
};

function post(message: WorkerResponse) {
  (self as unknown as Worker).postMessage(message);
}

/**
 * Convert a letterboxed RGB byte buffer into the Float32Array NCHW layout that
 * Ultralytics ONNX exports expect (channels first, 0..1 range).
 */
function rgbToNchwTensor(pixels: Uint8Array, inputSize: number): Float32Array {
  const area = inputSize * inputSize;
  const out = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    const p = i * 3;
    out[i] = pixels[p] / 255;
    out[i + area] = pixels[p + 1] / 255;
    out[i + 2 * area] = pixels[p + 2] / 255;
  }
  return out;
}

async function handleLoad(msg: Extract<WorkerRequest, { type: 'load' }>) {
  const t0 = performance.now();
  try {
    if (msg.backend === 'tfjs') {
      /*
       * Backend choice, and why CPU comes first inside the Worker:
       *
       * TF.js executes lazily — a stalled WebGL kernel does not throw, it just
       * never resolves, and it keeps the TF engine busy so even a later CPU
       * attempt deadlocks. A host page that drives its own (software-rendered)
       * WebGL scene can starve the worker's GL context exactly like that.
       *
       * So: probe the CPU backend first (always available, deterministic), and
       * only opt into WebGL when explicitly requested (VITE_TFJS_BACKEND=webgl)
       * or when the CPU warm-up fails.
       */
      const requested = (import.meta.env?.VITE_TFJS_BACKEND ?? 'cpu').toLowerCase();
      const order: ('cpu' | 'webgl')[] = requested === 'webgl' ? ['webgl', 'cpu'] : ['cpu', 'webgl'];

      let lastReason = '';
      for (const backend of order) {
        let tfjs = await loadTfjsDetector(msg.modelUrl, msg.inputSize, backend);
        const provider = `tfjs:${tfjs.backend}`;
        const warm = await warmUpTfjsDetector(tfjs, backend === 'webgl' ? 15_000 : 60_000);
        devLog(`tfjs warm-up (${backend}):`, warm.ok, Math.round(warm.ms), 'ms', warm.reason ?? '');
        if (warm.ok) {
          loaded = { backend: 'tfjs', loaded: tfjs, inputSize: msg.inputSize, labels: msg.labels };
          post({
            type: 'loaded',
            requestId: msg.requestId,
            backend: 'tfjs',
            resolvedUrl: msg.modelUrl,
            inputSize: msg.inputSize,
            loadMs: performance.now() - t0,
            executionProvider: provider,
          });
          return;
        }
        lastReason = warm.reason ?? 'warm-up failed';
        // The model/tensors cannot be disposed safely if a kernel never settled.
        if (backend === order[order.length - 1]) break;
        disposeTfjsDetector(tfjs);
      }
      throw new Error(
        `TF.js backend unusable in this browser (${lastReason}). ` +
          'Set VITE_TFJS_BACKEND=webgl to force the GPU backend.'
      );
    }

    // ONNX: probe candidate URLs (primary, then alternates)
    const { createOnnxSession, describeSession } = await import('./onnx');
    const candidates = msg.modelBytes
      ? ['<in-memory model>']
      : msg.candidates?.length
      ? msg.candidates
      : [msg.modelUrl];
    let lastError: unknown = null;
    for (const url of candidates) {
      try {
        let buf: Uint8Array;
        if (msg.modelBytes) {
          buf = new Uint8Array(msg.modelBytes);
        } else {
          const res = await fetch(url);
          if (!res.ok) {
            lastError = new Error(`${url} → HTTP ${res.status}`);
            continue;
          }
          buf = new Uint8Array(await res.arrayBuffer());
        }
        // Guard against Git-LFS pointer files / HTML error pages.
        if (buf.byteLength < 1024 || buf[0] !== 0x08) {
          lastError = new Error(
            `${url} is not an ONNX model (${buf.byteLength} bytes, magic ${buf[0]})`
          );
          continue;
        }
        const session = await createOnnxSession(buf);
        loaded = {
          backend: 'onnxruntime-web',
          session,
          inputSize: msg.inputSize,
          labels: msg.labels,
        };
        const meta = describeSession(session);
        post({
          type: 'loaded',
          requestId: msg.requestId,
          backend: 'onnxruntime-web',
          resolvedUrl: url,
          inputSize: msg.inputSize,
          loadMs: performance.now() - t0,
          executionProvider: 'wasm',
          inputNames: meta.inputs,
          outputNames: meta.outputs,
          bytes: buf.byteLength,
        });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } catch (err) {
    post({
      type: 'error',
      requestId: msg.requestId,
      scope: 'load',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleInfer(msg: Extract<WorkerRequest, { type: 'infer' }>) {
  if (!loaded) {
    post({
      type: 'error',
      requestId: msg.requestId,
      scope: 'infer',
      message: 'No model loaded',
    });
    return;
  }

  const tPre = performance.now();
  try {
    const pixels = new Uint8Array(msg.pixels);
    const geometry = {
      inputSize: msg.inputSize,
      scale: msg.scale,
      padX: msg.padX,
      padY: msg.padY,
      frameWidth: msg.frameWidth,
      frameHeight: msg.frameHeight,
      contentWidth: msg.inputSize - 2 * msg.padX,
      contentHeight: msg.inputSize - 2 * msg.padY,
    };

    if (loaded.backend === 'tfjs') {
      const boxes = await runTfjsDetectorFromPixels(
        loaded.loaded,
        pixels,
        geometry,
        msg.frameWidth,
        msg.frameHeight,
        msg.threshold
      );
      const tPost = performance.now();
      // NanoDetBox uses flat x/y/width/height; normalise to the worker contract.
      const flat = boxes.map((b) => ({
        box: { x: b.x, y: b.y, width: b.width, height: b.height },
        label: b.label,
        classIndex: b.classIndex,
        confidence: b.confidence,
      }));
      const detections = nmsInFrameSpace(flat, msg.nmsIou, msg.maxDetections);
      post({
        type: 'result',
        requestId: msg.requestId,
        detections,
        inferenceMs: tPost - tPre,
        preprocessMs: 0,
        postprocessMs: performance.now() - tPost,
        frameWidth: msg.frameWidth,
        frameHeight: msg.frameHeight,
        timestampMs: msg.timestampMs,
      });
      return;
    }

    const data = rgbToNchwTensor(pixels, msg.inputSize);
    const tInfer = performance.now();
    const { ort, session, inputName, outputNames } = loaded.session;
    const tensor = new ort.Tensor('float32', data, [1, 3, msg.inputSize, msg.inputSize]);
    const outputMap = await session.run({ [inputName]: tensor });
    const tPost = performance.now();

    const raw = outputNames.map((name) => {
      const t = outputMap[name];
      return { dims: Array.from(t.dims), data: t.data as Float32Array };
    });

    const decoded = decodeYoloOutput(raw, {
      inputSize: msg.inputSize,
      labels: loaded.labels,
      threshold: msg.threshold,
    });
    const kept = nonMaxSuppression(decoded, msg.nmsIou, msg.maxDetections);
    const detections = kept.map((d) => {
      const box = unletterboxBox(d.box, geometry, msg.frameWidth, msg.frameHeight);
      return {
        box,
        label: d.label,
        classIndex: d.classIndex,
        confidence: d.confidence,
      };
    });

    post({
      type: 'result',
      requestId: msg.requestId,
      detections,
      inferenceMs: tPost - tInfer,
      preprocessMs: tInfer - tPre,
      postprocessMs: performance.now() - tPost,
      frameWidth: msg.frameWidth,
      frameHeight: msg.frameHeight,
      timestampMs: msg.timestampMs,
    });
  } catch (err) {
    post({
      type: 'error',
      requestId: msg.requestId,
      scope: 'infer',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** NMS in frame space, used by the TF.js path (already mapped to pixels). */
function nmsInFrameSpace<T extends { box: BoundingBox; classIndex: number; confidence: number }>(
  dets: T[],
  iouThreshold: number,
  limit: number
): T[] {
  const order = dets
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d.confidence - a.d.confidence || a.i - b.i);
  const kept: T[] = [];
  const suppressed = new Set<number>();
  for (const { d, i } of order) {
    if (kept.length >= limit) break;
    if (suppressed.has(i)) continue;
    kept.push(d);
    for (const other of order) {
      if (other.i === i || suppressed.has(other.i)) continue;
      if (other.d.classIndex !== d.classIndex) continue;
      const a = d.box;
      const b = other.d.box;
      const ix1 = Math.max(a.x, b.x);
      const iy1 = Math.max(a.y, b.y);
      const ix2 = Math.min(a.x + a.width, b.x + b.width);
      const iy2 = Math.min(a.y + a.height, b.y + b.height);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      const union = a.width * a.height + b.width * b.height - inter;
      if (union > 0 && inter / union > iouThreshold) suppressed.add(other.i);
    }
  }
  return kept;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'load':
      await handleLoad(msg);
      break;
    case 'infer':
      await handleInfer(msg);
      break;
    case 'reset':
      if (loaded?.backend === 'tfjs') disposeTfjsDetector(loaded.loaded);
      loaded = null;
      post({ type: 'reset_done', requestId: msg.requestId });
      break;
    default:
      break;
  }
};

// Exported only for potential unit tests of the decode pipeline.
export type { NanoDetOutputTensor };
