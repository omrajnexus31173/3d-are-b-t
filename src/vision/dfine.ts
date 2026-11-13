/**
 * D-FINE-N post-processing.
 *
 * D-FINE's exported graph already contains the whole decoder:
 *   sigmoid -> top-k(300) over flattened (query x class) logits -> cxcywh->xyxy
 *   -> multiply by orig_target_sizes -> return (labels, boxes, scores)
 *
 * So there is NO NMS here: the graph is NMS-free by construction and hands back
 * exactly 300 rows, already sorted by descending score. All this module does is
 * threshold, drop the letterbox padding, and map class indices to labels.
 *
 * Verified contract of the exported model (from the D-FINE export script):
 *   images            FLOAT [N,3,640,640]   0..1, RGB, CHW   (letterboxed)
 *   orig_target_sizes INT64 [N,2]           [H, W] of the letterboxed canvas
 *   labels            INT64 [N,300]         0..79 COCO index (0..79, not 1..90)
 *   boxes             FLOAT [N,300,4]       absolute xyxy in canvas pixels
 *   scores            FLOAT [N,300]         descending
 *
 * TWO SUBTLETIES THAT MATTER:
 *
 * 1. `orig_target_sizes` must be [[640,640]], not the frame's dimensions.
 *    D-FINE's reference implementation (tools/inference/onnx_inf.py) reads the
 *    size from the *already letterboxed* image, so it is always the square
 *    canvas. The box->source-frame mapping is the same subtract-pad/divide-scale
 *    that YOLO uses, and is done after inference, not via this tensor. Feeding
 *    the raw frame size here would scale boxes twice.
 *
 * 2. `labels` arrives as BigInt64Array under ONNX Runtime Web (int64 tensors map
 *    to BigInt). Reading it as a number without conversion throws or silently
 *    yields wrong indices, so it is normalised here.
 */

import type { BoundingBox } from './types';

/** One decoded detection in the letterboxed canvas coordinate space. */
export interface DFineCanvasDetection {
  box: BoundingBox;
  classIndex: number;
  confidence: number;
}

export interface DFineRawOutputs {
  /** int64 [1,300] - may be BigInt64Array or Int32Array depending on backend. */
  labels: { dims: readonly number[]; data: ArrayLike<unknown> };
  /** float32 [1,300,4] - absolute xyxy in canvas pixels. */
  boxes: { dims: readonly number[]; data: ArrayLike<number> };
  /** float32 [1,300] - descending. */
  scores: { dims: readonly number[]; data: ArrayLike<number> };
}

/** Number of queries the D-FINE-N export always returns. */
export const DFINE_QUERIES = 300;

/**
 * Read one element of an int64 tensor regardless of how the runtime represented
 * it. ORT Web gives BigInt64Array for int64; some paths hand back Int32Array or
 * a plain array. Anything not safely representable yields NaN so the caller can
 * reject it instead of producing a bogus class index.
 */
function readInt64(data: ArrayLike<unknown>, i: number): number {
  const v = data[i];
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (v == null) return Number.NaN;
  const n = Number(v as number);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Turn the three raw D-FINE outputs into canvas-space detections.
 *
 * `labels` is optional in the sense that out-of-range indices are dropped rather
 * than produced, because a mismatched label table is worse than a missed box.
 */
export function decodeDFineOutput(
  raw: DFineRawOutputs,
  opts: {
    threshold: number;
    labels: readonly string[];
    /** Safety cap on returned rows. The graph already caps at 300. */
    maxDetections?: number;
  }
): DFineCanvasDetection[] {
  const { threshold, labels } = opts;
  const maxDetections = opts.maxDetections ?? DFINE_QUERIES;

  const scoreDim = raw.scores.dims[raw.scores.dims.length - 1] ?? 0;
  const n = Math.min(scoreDim, raw.scores.data.length);
  if (n === 0) return [];

  const boxStride = raw.boxes.dims.length >= 2 ? raw.boxes.dims[raw.boxes.dims.length - 1] : 4;
  if (boxStride !== 4) return [];

  const out: DFineCanvasDetection[] = [];
  for (let i = 0; i < n; i++) {
    const score = raw.scores.data[i];
    if (!(score > threshold)) continue;

    const cls = readInt64(raw.labels.data, i);
    if (!Number.isFinite(cls) || cls < 0 || cls >= labels.length) continue;

    const b = i * 4;
    const x1 = raw.boxes.data[b];
    const y1 = raw.boxes.data[b + 1];
    const x2 = raw.boxes.data[b + 2];
    const y2 = raw.boxes.data[b + 3];
    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      continue;
    }

    // The graph can emit inverted or zero-area boxes for low-confidence queries.
    const width = x2 - x1;
    const height = y2 - y1;
    if (!(width > 0) || !(height > 0)) continue;

    out.push({
      box: { x: x1, y: y1, width, height },
      classIndex: cls,
      confidence: score,
    });

    if (out.length >= maxDetections) break;
  }

  return out;
}
