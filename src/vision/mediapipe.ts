/**
 * MediaPipe Tasks Vision object detector (EfficientDet-Lite0).
 *
 * Why this exists: the ONNX detectors (YOLO11n, D-FINE-N) both need a model
 * binary fetched from a GitHub release, and both need their own preprocessing and
 * decoding here. MediaPipe takes the video element directly, does its own resize
 * and normalisation internally, and returns boxes already in source-frame pixels
 * - so there is no letterbox to apply and none to undo.
 *
 * That is the whole point of this backend: one call in, boxes out, no geometry
 * arithmetic of our own to get wrong.
 *
 * Runs on the main thread, not in the worker. MediaPipe needs a `WasmFileset`
 * plus a DOM-capable environment, and its own WASM runtime already does the
 * heavy work; the ~10 ms of box conversion is not worth a second wasm instance
 * in a worker. Back-pressure is handled by the engine (one in-flight call).
 */
import type { BoundingBox } from './types';
import { COCO_LABELS } from './detector';

/** Minimal structural types for the parts of the API we use. */
export interface MediaPipeDetection {
  categories: { score: number; index: number; categoryName: string; displayName: string }[];
  boundingBox?: { originX: number; originY: number; width: number; height: number };
}

export interface MediaPipeResult {
  detections: MediaPipeDetection[];
}

export interface MediaPipeDetectorLike {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): MediaPipeResult;
  close(): void;
}

export interface MediaPipeLoadOptions {
  /** Where `vision_wasm_*.js/.wasm` live, e.g. `/vendor/mediapipe`. */
  wasmBasePath: string;
  /** Where `efficientdet_lite0.tflite` lives, e.g. `models/efficientdet_lite0.tflite`. */
  modelAssetPath: string;
  /** Preferred delegate; GPU falls back to CPU automatically. Default 'GPU'. */
  delegate?: 'GPU' | 'CPU';
  scoreThreshold?: number;
  maxResults?: number;
}

export class MediaPipeUnavailableError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`MediaPipe object detector unavailable: ${detail}`);
    this.name = 'MediaPipeUnavailableError';
    this.detail = detail;
  }
}

/**
 * EfficientDet-Lite0 (COCO) score threshold.
 *
 * 0.3 is the value the published MediaPipe object-detector sample uses. Unlike
 * D-FINE this is not a raw-query cut: EfficientDet is a one-stage detector whose
 * output is already NMS'd inside the graph, so a low threshold adds genuine weak
 * detections rather than rows of background queries.
 */
export const MEDIAPIPE_SCORE_THRESHOLD = 0.3;

/** MediaPipe's own NMS keeps this many boxes; small enough for a clear overlay. */
export const MEDIAPIPE_MAX_RESULTS = 8;

/**
 * Load the runtime and build a detector.
 *
 * Tries the GPU delegate first because it is markedly faster, then retries on CPU
 * when the device cannot provide one. Both failures are surfaced as
 * `MediaPipeUnavailableError` so the caller can fall back to YOLO11n instead of
 * leaving the panel stuck on "loading".
 */
export async function createMediaPipeDetector(
  options: MediaPipeLoadOptions
): Promise<MediaPipeDetectorLike> {
  const { wasmBasePath, modelAssetPath, scoreThreshold, maxResults } = options;
  const preferred = options.delegate ?? 'GPU';

  let vision: typeof import('@mediapipe/tasks-vision');
  try {
    vision = await import('@mediapipe/tasks-vision');
  } catch (err) {
    throw new MediaPipeUnavailableError(
      `could not import @mediapipe/tasks-vision (${err instanceof Error ? err.message : String(err)})`
    );
  }

  let fileset: Awaited<ReturnType<typeof vision.FilesetResolver.forVisionTasks>>;
  try {
    fileset = await vision.FilesetResolver.forVisionTasks(wasmBasePath);
  } catch (err) {
    throw new MediaPipeUnavailableError(
      `WASM runtime failed to load from ${wasmBasePath} ` +
        `(${err instanceof Error ? err.message : String(err)}). Run \`npm run setup:models -- --only=mediapipe\`.`
    );
  }

  const build = (delegate: 'GPU' | 'CPU') =>
    vision.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      scoreThreshold: scoreThreshold ?? MEDIAPIPE_SCORE_THRESHOLD,
      maxResults: maxResults ?? MEDIAPIPE_MAX_RESULTS,
    });

  try {
    return await build(preferred);
  } catch (gpuErr) {
    if (preferred === 'CPU') {
      throw new MediaPipeUnavailableError(
        `model failed to load from ${modelAssetPath} ` +
          `(${gpuErr instanceof Error ? gpuErr.message : String(gpuErr)}). ` +
          `Run \`npm run setup:models -- --only=mediapipe\`.`
      );
    }
    // GPU unavailable (no WebGL2, blacklisted driver, headless): retry on CPU.
    try {
      return await build('CPU');
    } catch (cpuErr) {
      throw new MediaPipeUnavailableError(
        `model failed to load from ${modelAssetPath} on both GPU and CPU ` +
          `(${cpuErr instanceof Error ? cpuErr.message : String(cpuErr)}). ` +
          `Run \`npm run setup:models -- --only=mediapipe\`.`
      );
    }
  }
}

/**
 * One raw detection in BHARAT-AV form, in SOURCE FRAME pixels.
 *
 * Deliberately the same shape the worker returns, so the tracker, the overlay and
 * the risk assessment downstream cannot tell which backend produced it.
 */
export interface MediaPipeRawDetection {
  box: BoundingBox;
  label: string;
  classIndex: number;
  confidence: number;
}

/**
 * Convert a MediaPipe result into the app's detection format.
 *
 * MediaPipe reports boxes in the input image's pixel space, which for
 * `detectForVideo(video)` is the video's intrinsic size - exactly what the
 * overlay expects. No letterbox reversal, no scaling: that is why this conversion
 * is trustworthy where the ONNX paths needed a geometry audit.
 *
 * Drops, rather than guesses at:
 *  - detections with no bounding box
 *  - non-finite or non-positive-area boxes
 *  - class indices outside the 80-class table
 */
export function toMediaPipeRawDetections(
  result: MediaPipeResult,
  labels: readonly string[] = COCO_LABELS
): { detections: MediaPipeRawDetection[]; dropped: { noBox: number; degenerate: number; badClass: number } } {
  const detections: MediaPipeRawDetection[] = [];
  const dropped = { noBox: 0, degenerate: 0, badClass: 0 };

  for (const d of result.detections ?? []) {
    const box = d.boundingBox;
    if (!box) {
      dropped.noBox += 1;
      continue;
    }
    const width = box.width;
    const height = box.height;
    if (
      !Number.isFinite(box.originX) ||
      !Number.isFinite(box.originY) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      dropped.degenerate += 1;
      continue;
    }
    // Highest-scoring category describes the object; the rest are alternatives.
    const best = [...(d.categories ?? [])].sort((a, b) => b.score - a.score)[0];
    if (!best) {
      dropped.noBox += 1;
      continue;
    }
    const classIndex = best.index;
    if (!Number.isInteger(classIndex) || classIndex < 0 || classIndex >= labels.length) {
      dropped.badClass += 1;
      continue;
    }
    // Prefer the model's own name when it supplies one; fall back to the table.
    const label = best.categoryName || best.displayName || labels[classIndex];
    detections.push({
      box: { x: box.originX, y: box.originY, width, height },
      label,
      classIndex,
      confidence: best.score,
    });
  }

  // Strongest first: the overlay budgets labels by confidence.
  detections.sort((a, b) => b.confidence - a.confidence);
  return { detections, dropped };
}

/**
 * Run one detection, keeping timestamps strictly increasing.
 *
 * `detectForVideo` throws if the timestamp does not advance. Frames can arrive
 * with the same `Date.now()` millisecond at high rates, and a clock correction
 * can move it backwards, so the caller's value is only a request.
 */
export class MediaPipeFrameRunner {
  private lastTimestamp = -1;

  constructor(private readonly detector: MediaPipeDetectorLike) {}

  detect(video: HTMLVideoElement, requestedMs: number): MediaPipeResult {
    const ts = requestedMs <= this.lastTimestamp ? this.lastTimestamp + 1 : requestedMs;
    this.lastTimestamp = ts;
    return this.detector.detectForVideo(video, ts);
  }

  close(): void {
    try {
      this.detector.close();
    } catch {
      /* already closed */
    }
  }
}
