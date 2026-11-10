/**
 * TensorFlow.js graph-model detector — browser fallback backend.
 *
 * Why this exists
 * ---------------
 * The primary backend is ONNX Runtime Web (`onnx.ts`). Some sandboxed /
 * restricted browser environments cannot instantiate the ORT wasm runtime at
 * all; in those environments we still want *real* inference rather than a
 * dead "load model" button, so BHARAT-AV can fall back to a TF.js graph model.
 *
 * The fallback model is NanoDet-m (COCO-80) converted to TF.js. NanoDet's
 * output heads are (scores, regression) pairs for strides 8/16/32 and the
 * regression head encodes distance-to-edge distributions, which is decoded
 * here explicitly (softmax over 11 bins, as in the reference implementation).
 *
 * The model is *not* bundled: `npm run setup:models` fetches it from
 * `@vladmandic/human-models` (a public npm package that ships the converted
 * NanoDet weights). Without those files this backend reports
 * `not_configured` — it never fabricates detections.
 */

export interface TfjsGraphModel {
  execute: (
    input: unknown
  ) => unknown;
  dispose: () => void;
}

interface TfjsTensors {
  expandDims: (t: unknown, axis: number) => unknown;
  /** TF.js exposes pixel IO under `tf.browser`, not at the top level. */
  browser: {
    fromPixels: (src: CanvasImageSource | ImageData) => unknown;
  };
  image: {
    resizeBilinear: (t: unknown, size: [number, number], alignCorners: boolean) => unknown;
  };
  div: (a: unknown, b: unknown) => unknown;
  sub: (a: unknown, b: unknown) => unknown;
  transpose: (t: unknown, axes: number[]) => unknown;
  reverse: (t: unknown, axes: number[]) => unknown;
  tensor1d: (v: number[]) => { reshape: (s: number[]) => unknown };
  tensor3d: (
    values: Uint8Array | Int32Array | Float32Array,
    shape: [number, number, number],
    dtype: string
  ) => unknown;
  cast: (t: unknown, dtype: string) => unknown;
  tidy: <T>(fn: () => T) => T;
  dispose: (t: unknown) => void;
}

interface TfjsRuntime {
  loadGraphModel: (url: string) => Promise<TfjsGraphModel>;
  setBackend?: (name: string) => Promise<boolean>;
  ready?: () => Promise<void>;
  getBackend?: () => string;
  Tensor: new (data: Float32Array, shape: number[]) => unknown;
}

/** Labels emitted by the NanoDet COCO conversion (0-based, 80 classes). */
export const NANODET_COCO_LABELS: readonly string[] = [
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

export interface NanoDetOutputTensor {
  shape: readonly number[];
  data: Float32Array | number[];
}

export interface NanoDetBox {
  /** Pixel coordinates in the *source frame*. */
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  classIndex: number;
  confidence: number;
}

/** Softmax over a window of a flat array (11 regression bins). */
function softmaxExpectation(values: ArrayLike<number>, offset: number, bins: number): number {
  let max = -Infinity;
  for (let i = 0; i < bins; i++) max = Math.max(max, values[offset + i]);
  let sum = 0;
  const exps = new Array<number>(bins);
  for (let i = 0; i < bins; i++) {
    const v = Math.exp(values[offset + i] - max);
    exps[i] = v;
    sum += v;
  }
  let expected = 0;
  for (let i = 0; i < bins; i++) expected += i * (exps[i] / sum);
  return expected;
}

/**
 * Decode NanoDet raw heads into boxes.
 *
 * @param outputs  six tensors: [1,N,80] scores and [1,N,44] regression for
 *                 strides 8, 16 and 32.
 * @param inputSize model input edge (416 for NanoDet-m).
 * @param frameWidth source frame width in pixels.
 * @param frameHeight source frame height in pixels.
 * @param threshold minimum confidence.
 */
export interface NanoDetGeometry {
  /** Model input edge in pixels (square). */
  inputSize: number;
  /** Scale applied to the source frame before padding. */
  scale: number;
  padX: number;
  padY: number;
}

export function decodeNanoDet(
  outputs: NanoDetOutputTensor[],
  inputSize: number,
  frameWidth: number,
  frameHeight: number,
  threshold: number,
  geometry?: NanoDetGeometry
): NanoDetBox[] {
  const results: NanoDetBox[] = [];
  const numClasses = NANODET_COCO_LABELS.length;
  const bins = 11;
  // Without explicit geometry the frame is assumed to fill the square model
  // input (stretched). With geometry the box is de-letterboxed exactly.
  const mapX = geometry
    ? (v: number) => (v - geometry.padX) / (geometry.scale || 1)
    : (v: number) => (v * frameWidth) / inputSize;
  const mapY = geometry
    ? (v: number) => (v - geometry.padY) / (geometry.scale || 1)
    : (v: number) => (v * frameHeight) / inputSize;

  for (const stride of [8, 16, 32]) {
    const side = inputSize / stride;
    const anchors = side * side;
    const scores = outputs.find(
      (o) => o.shape[o.shape.length - 2] === anchors && o.shape[o.shape.length - 1] === numClasses
    );
    const regression = outputs.find(
      (o) => o.shape[o.shape.length - 2] === anchors && o.shape[o.shape.length - 1] === 4 * bins
    );
    if (!scores || !regression) continue;

    for (let i = 0; i < anchors; i++) {
      // sigmoid(best logit) — NanoDet emits logits for the classification head
      let bestIdx = -1;
      let bestRaw = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        const v = scores.data[i * numClasses + c];
        if (v > bestRaw) {
          bestRaw = v;
          bestIdx = c;
        }
      }
      if (bestIdx < 0) continue;
      const confidence = 1 / (1 + Math.exp(-bestRaw));
      if (!(confidence >= threshold)) continue;

      const cx = ((i % side) + 0.5) * stride;
      const cy = (Math.floor(i / side) + 0.5) * stride;
      const dist = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        dist[k] = softmaxExpectation(regression.data, i * (4 * bins) + k * bins, bins) * stride;
      }
      const x1 = Math.max(0, cx - dist[0]);
      const y1 = Math.max(0, cy - dist[1]);
      const x2 = Math.min(inputSize, cx + dist[2]);
      const y2 = Math.min(inputSize, cy + dist[3]);
      if (!(x2 > x1) || !(y2 > y1)) continue;

      const fx1 = Math.max(0, Math.min(frameWidth - 1, mapX(x1)));
      const fy1 = Math.max(0, Math.min(frameHeight - 1, mapY(y1)));
      const fx2 = Math.max(fx1 + 1, Math.min(frameWidth, mapX(x2)));
      const fy2 = Math.max(fy1 + 1, Math.min(frameHeight, mapY(y2)));
      results.push({
        x: fx1,
        y: fy1,
        width: fx2 - fx1,
        height: fy2 - fy1,
        label: NANODET_COCO_LABELS[bestIdx],
        classIndex: bestIdx,
        confidence,
      });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

let runtimePromise: Promise<{ tf: TfjsRuntime; tensors: TfjsTensors }> | null = null;

/**
 * Dynamically load the TF.js UMD bundle from `public/vendor/tf.min.js`.
 * The bundle is fetched by `npm run setup:models` and is loaded lazily so the
 * main application bundle stays small and the simulation works without it.
 */
async function loadTfjs(): Promise<{ tf: TfjsRuntime; tensors: TfjsTensors }> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    const url = `${base}/vendor/tf.min.js`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `TF.js runtime not installed (${url} → HTTP ${res.status}). Run "npm run setup:models".`
      );
    }
    const source = await res.text();
    // Resolve `tf` from whichever global exists: `window` in the main thread,
    // `self` inside a Worker (a Worker has no `window`).
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'scope',
      `${source}\n;return (typeof window!=='undefined'&&window.tf)||(typeof scope!=='undefined'&&scope.tf)||(typeof self!=='undefined'&&self.tf)||(typeof globalThis!=='undefined'&&globalThis.tf);`
    );
    const tf = factory(globalThis) as TfjsRuntime & TfjsTensors;
    if (!tf || typeof tf.loadGraphModel !== 'function') {
      throw new Error('TF.js runtime loaded but did not expose loadGraphModel');
    }
    return { tf, tensors: tf };
  })();
  return runtimePromise;
}

export interface TfjsDetectorLoadResult {
  model: TfjsGraphModel;
  tf: TfjsRuntime;
  tensors: TfjsTensors;
  backend: string;
  inputSize: number;
}

export async function loadTfjsDetector(
  modelUrl: string,
  inputSize = 416,
  preferredBackend: 'webgl' | 'cpu' = 'webgl'
): Promise<TfjsDetectorLoadResult> {
  const { tf, tensors } = await loadTfjs();
  // WebGL is much faster on real laptops, but GPU execution inside a Worker can
  // be starved when the host page drives a software-rendered WebGL scene. The
  // caller probes with `warmUpTfjsDetector` and falls back to CPU if needed.
  try {
    await tf.setBackend?.(preferredBackend);
    await tf.ready?.();
  } catch {
    await tf.setBackend?.('cpu');
    await tf.ready?.();
  }
  const model = await tf.loadGraphModel(modelUrl);
  return {
    model,
    tf,
    tensors,
    backend: tf.getBackend?.() ?? 'unknown',
    inputSize,
  };
}

/**
 * Run one synthetic inference to prove the execution provider actually works.
 *
 * TF.js executes lazily: `model.execute()` returning a tensor does not mean the
 * GPU kernel completed. Awaiting the output data forces completion, which is
 * exactly what detects a stalled WebGL context.
 */
export async function warmUpTfjsDetector(
  loaded: TfjsDetectorLoadResult,
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; reason?: string }> {
  const size = loaded.inputSize;
  const blank = new Uint8Array(size * size * 3).fill(114);
  const started = performance.now();
  const work = runTfjsDetectorFromPixels(
    loaded,
    blank,
    { inputSize: size, scale: 1, padX: 0, padY: 0, frameWidth: size, frameHeight: size },
    size,
    size,
    0.99 // nothing should be detected in a flat frame
  ).then(() => ({ ok: true as const, ms: performance.now() - started }));

  try {
    const result = await Promise.race([
      work,
      new Promise<{ ok: false; ms: number; reason: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              ms: performance.now() - started,
              reason: `warm-up exceeded ${timeoutMs} ms (${loaded.backend} backend)`,
            }),
          timeoutMs
        )
      ),
    ]);
    return result;
  } catch (err) {
    return {
      ok: false,
      ms: performance.now() - started,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface FrameGeometry {
  inputSize: number;
  scale: number;
  padX: number;
  padY: number;
  frameWidth: number;
  frameHeight: number;
}

/**
 * Run NanoDet on an already letterboxed RGB buffer (produced on the main
 * thread). This is the production path inside the detection worker: it avoids
 * OffscreenCanvas readback entirely.
 */
export async function runTfjsDetectorFromPixels(
  loaded: TfjsDetectorLoadResult,
  pixels: Uint8Array,
  geometry: FrameGeometry,
  frameWidth: number,
  frameHeight: number,
  threshold: number
): Promise<NanoDetBox[]> {
  const { model, tensors: T } = loaded;
  const size = geometry.inputSize;

  // Upload float32 directly: an int32 texture + cast forces TF.js into an
  // implicit GPU→CPU readback, which blocks inside a Worker.
  const floatPixels = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) floatPixels[i] = pixels[i];
  const hwc = T.tensor3d(floatPixels, [size, size, 3], 'float32');

  const raw = T.expandDims(hwc, 0);

  const asBgr = T.reverse(raw, [3]);

  const mean = T.tensor1d([103.53, 116.28, 123.675]).reshape([1, 1, 1, 3]);
  const std = T.tensor1d([57.375, 57.12, 58.395]).reshape([1, 1, 1, 3]);
  const normalized = T.div(T.sub(asBgr, mean), std);

  const input = T.transpose(normalized, [0, 3, 1, 2]);


  const flushed = model.execute(input) as unknown;
  const list = Array.isArray(flushed) ? flushed : [flushed];
  const tensors: NanoDetOutputTensor[] = [];
  for (const t of list) {
    const tensor = t as { shape: readonly number[]; data: () => Promise<Float32Array> };
    tensors.push({ shape: tensor.shape, data: await tensor.data() });
  }

  const boxes = decodeNanoDet(tensors, size, frameWidth, frameHeight, threshold, geometry);

  T.dispose(input);
  T.dispose(normalized);
  T.dispose(asBgr);
  T.dispose(std);
  T.dispose(mean);
  T.dispose(raw);
  T.dispose(hwc);
  for (const t of list) T.dispose(t);

  return boxes;
}

let letterboxCanvas: OffscreenCanvas | null = null;
let letterboxCtx: OffscreenCanvasRenderingContext2D | null = null;

export interface LetterboxResult {
  data: ImageData;
  scale: number;
  padX: number;
  padY: number;
}

/**
 * Draw any drawable source into a square, aspect-preserving letterbox and read
 * the pixels back. Canvas is reused across frames (no per-frame allocation of
 * a new backing store).
 */
export function letterboxToImageData(
  source: CanvasImageSource,
  frameWidth: number,
  frameHeight: number,
  inputSize: number
): LetterboxResult {
  if (!letterboxCanvas || letterboxCanvas.width !== inputSize) {
    letterboxCanvas = new OffscreenCanvas(inputSize, inputSize);
    letterboxCtx = letterboxCanvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
  }
  const ctx = letterboxCtx;
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  const scale = Math.min(inputSize / Math.max(1, frameWidth), inputSize / Math.max(1, frameHeight));
  const contentWidth = frameWidth * scale;
  const contentHeight = frameHeight * scale;
  const padX = (inputSize - contentWidth) / 2;
  const padY = (inputSize - contentHeight) / 2;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, inputSize, inputSize);
  ctx.drawImage(source, padX, padY, contentWidth, contentHeight);
  return { data: ctx.getImageData(0, 0, inputSize, inputSize), scale, padX, padY };
}

/**
 * Run NanoDet on a video element / canvas / ImageBitmap and return frame-space
 * boxes. The frame is letterboxed into the square model input, and boxes are
 * mapped back through the same geometry so they stay aligned with the video.
 *
 * Uses ImageNet BGR mean/std normalisation, which is what the converted
 * NanoDet-m graph expects.
 */
export async function runTfjsDetector(
  loaded: TfjsDetectorLoadResult,
  source: CanvasImageSource,
  frameWidth: number,
  frameHeight: number,
  threshold: number
): Promise<NanoDetBox[]> {
  const { model, tensors: T } = loaded;
  const size = loaded.inputSize;

  // `ImageBitmap` is not consistently supported by tf.browser.fromPixels inside
  // a Worker, so we always go through ImageData (also gives exact letterboxing).
  const letterboxed = letterboxToImageData(source, frameWidth, frameHeight, size);

  const raw = T.expandDims(T.browser.fromPixels(letterboxed.data), 0);
  const resized = T.image.resizeBilinear(raw, [size, size], false);
  const asBgr = T.reverse(resized, [3]);
  const mean = T.tensor1d([103.53, 116.28, 123.675]).reshape([1, 1, 1, 3]);
  const std = T.tensor1d([57.375, 57.12, 58.395]).reshape([1, 1, 1, 3]);
  const normalized = T.div(T.sub(asBgr, mean), std);
  const input = T.transpose(normalized, [0, 3, 1, 2]);

  const flushed = model.execute(input) as unknown;
  const list = Array.isArray(flushed) ? flushed : [flushed];
  const tensors: NanoDetOutputTensor[] = [];
  for (const t of list) {
    const tensor = t as { shape: readonly number[]; data: () => Promise<Float32Array> };
    tensors.push({ shape: tensor.shape, data: await tensor.data() });
  }

  const boxes = decodeNanoDet(tensors, size, frameWidth, frameHeight, threshold, {
    inputSize: size,
    scale: letterboxed.scale,
    padX: letterboxed.padX,
    padY: letterboxed.padY,
  });

  T.dispose(input);
  T.dispose(normalized);
  T.dispose(asBgr);
  T.dispose(resized);
  T.dispose(raw);
  for (const t of list) T.dispose(t);

  return boxes;
}

export function disposeTfjsDetector(loaded: TfjsDetectorLoadResult | null): void {
  if (!loaded) return;
  try {
    loaded.model.dispose();
  } catch {
    /* ignore disposal errors */
  }
}
