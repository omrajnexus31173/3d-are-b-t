/**
 * D-FINE post-processing.
 *
 * ## What the exported graph actually returns
 *
 * Verified against the authors' own reference implementation,
 * `src/zoo/dfine/postprocessor.py` (deploy branch) and
 * `tools/inference/onnx_inf.py`:
 *
 * ```python
 * bbox_pred = box_convert(boxes, in_fmt="cxcywh", out_fmt="xyxy")
 * bbox_pred *= orig_target_sizes.repeat(1, 2).unsqueeze(1)
 * scores, index = topk(sigmoid(logits).flatten(1), num_top_queries)
 * labels = index % num_classes
 * ```
 *
 * Therefore, with `deploy_mode`, the three outputs are:
 *
 *   labels  INT64   [N,300]     index % 80      -> COCO 0..79 (NOT the 1..90 ids)
 *   boxes   FLOAT   [N,300,4]   ABSOLUTE xyxy in the size given by orig_target_sizes
 *   scores  FLOAT   [N,300]     sigmoid, DESCENDING
 *
 * ## The consequence people miss
 *
 * The graph is NMS-free, but that does NOT mean it returns only real objects.
 * It always returns exactly `num_top_queries` (300) rows, one per query, already
 * sorted. There is no "background" class to filter on and no built-in score
 * cutoff: a frame containing two cars still yields 300 rows, of which ~298 are
 * query slots that learned to predict *something* with a low score.
 *
 * So thresholding is the caller's job and is mandatory. With a 300-query graph
 * exposed to a threshold that is too low (or not applied at all), a large share
 * of those 300 rows survive - which is exactly what "hundreds of overlapping
 * boxes" looks like.
 *
 * ## Note on orig_target_sizes
 *
 * The reference feeds the size of the ALREADY LETTERBOXED canvas, so this app
 * passes [[inputSize, inputSize]] (640x640). Boxes therefore come back in canvas
 * pixels and the subtract-pad / divide-scale mapping to the source frame is done
 * afterwards by `unletterboxBox`, exactly as YOLO does. Feeding the raw frame
 * size instead would scale every box twice.
 */

import type { BoundingBox } from './types';
import { emptyDetectionStats, type DetectionStatsSummary } from './diagnostics';

/** One decoded detection in the letterboxed canvas coordinate space. */
export interface DFineCanvasDetection {
  box: BoundingBox;
  classIndex: number;
  confidence: number;
}

export interface DFineRawOutputs {
  /** int64 [1,300] - BigInt64Array under ORT Web, numbers elsewhere. */
  labels: { dims: readonly number[]; data: ArrayLike<unknown> };
  /** float32 [1,300,4] - absolute xyxy in canvas pixels. */
  boxes: { dims: readonly number[]; data: ArrayLike<number> };
  /** float32 [1,300] - sigmoid scores, descending. */
  scores: { dims: readonly number[]; data: ArrayLike<number> };
}

/** Number of queries the D-FINE-N export always returns. */
export const DFINE_QUERIES = 300;

export interface DFineDecodeOptions {
  threshold: number;
  labels: readonly string[];
  maxDetections?: number;
  /**
   * Optional class-agnostic IoU suppression, applied AFTER thresholding.
   *
   * OFF by default, because a correctly exported and correctly thresholded
   * D-FINE graph does not need it: its 300 rows are distinct queries and the
   * high-scoring ones do not duplicate each other. It exists only as a guard for
   * the observed failure mode where a low threshold admits many low-score
   * query slots that collapse onto the same object. Never enable it blindly.
   */
  nmsIou?: number;
}

/**
 * Read one element of an int64 tensor regardless of runtime representation.
 * Anything not safely representable yields NaN so the caller rejects the row
 * instead of inventing a class index.
 */
function readInt64(data: ArrayLike<unknown>, i: number): number {
  const v = data[i];
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (v == null) return Number.NaN;
  const n = Number(v as number);
  return Number.isFinite(n) ? n : Number.NaN;
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const ix1 = Math.max(a.x, b.x);
  const iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(a.x + a.width, b.x + b.width);
  const iy2 = Math.min(a.y + a.height, b.y + b.height);
  const iw = ix2 - ix1;
  const ih = iy2 - iy1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Full decode with per-reason drop accounting.
 *
 * `counts.raw` is the number of graph rows, `counts.kept` the number returned.
 * The ratio between them is the diagnostic that explains an over-dense overlay.
 */
export function decodeDFineWithStats(
  raw: DFineRawOutputs,
  opts: DFineDecodeOptions
): { detections: DFineCanvasDetection[]; counts: DetectionStatsSummary } {
  const { threshold, labels } = opts;
  const maxDetections = opts.maxDetections ?? DFINE_QUERIES;
  const counts = emptyDetectionStats(threshold);

  const scoreDim = raw.scores.dims[raw.scores.dims.length - 1] ?? 0;
  const n = Math.min(scoreDim, raw.scores.data.length);
  counts.raw = n;
  if (n === 0) return { detections: [], counts };

  // Boxes must be packed as 4 values per row.
  const boxStride = raw.boxes.dims.length >= 2 ? raw.boxes.dims[raw.boxes.dims.length - 1] : 4;
  if (boxStride !== 4) {
    counts.invalid = n;
    return { detections: [], counts };
  }

  let scoreMin = Infinity;
  let scoreMax = -Infinity;

  const passed: DFineCanvasDetection[] = [];
  for (let i = 0; i < n; i++) {
    const score = raw.scores.data[i];
    if (!Number.isFinite(score)) {
      counts.invalid += 1;
      continue;
    }
    if (score < scoreMin) scoreMin = score;
    if (score > scoreMax) scoreMax = score;

    // Strict ">" matches the reference (`scores > thrh`).
    if (!(score > threshold)) {
      counts.belowThreshold += 1;
      continue;
    }

    const cls = readInt64(raw.labels.data, i);
    if (!Number.isFinite(cls) || cls < 0 || cls >= labels.length) {
      counts.badClass += 1;
      continue;
    }

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
      counts.invalid += 1;
      continue;
    }

    // Low-score queries can emit inverted or zero-area boxes.
    const width = x2 - x1;
    const height = y2 - y1;
    if (!(width > 0) || !(height > 0)) {
      counts.degenerate += 1;
      continue;
    }

    passed.push({
      box: { x: x1, y: y1, width, height },
      classIndex: cls,
      confidence: score,
    });
  }

  counts.scoreMin = scoreMin === Infinity ? 0 : scoreMin;
  counts.scoreMax = scoreMax === -Infinity ? 0 : scoreMax;

  /*
   * Optional class-agnostic suppression. Kept off unless asked for: D-FINE's own
   * post-processing does not do this, so enabling it unconditionally would be
   * inventing a step the model contract does not specify.
   */
  let selected = passed;
  if (opts.nmsIou !== undefined && opts.nmsIou > 0) {
    const order = passed
      .map((d, i) => ({ d, i }))
      .sort((p, q) => q.d.confidence - p.d.confidence || p.i - q.i);
    const suppressed = new Set<number>();
    const kept: DFineCanvasDetection[] = [];
    for (const { d: cand, i: ci } of order) {
      if (suppressed.has(ci)) continue;
      kept.push(cand);
      for (const { d: other, i: oi } of order) {
        if (oi === ci || suppressed.has(oi)) continue;
        if (iou(cand.box, other.box) > opts.nmsIou) suppressed.add(oi);
      }
    }
    selected = kept;
  }

  const detections = selected.slice(0, Math.max(0, maxDetections));
  counts.kept = detections.length;
  if (detections.length > 0) {
    counts.keptScoreMin = Math.min(...detections.map((d) => d.confidence));
    counts.keptScoreMax = Math.max(...detections.map((d) => d.confidence));
  }
  return { detections, counts };
}

/**
 * Turn the three raw D-FINE outputs into canvas-space detections.
 *
 * Thin wrapper over `decodeDFineWithStats` for callers that only need boxes.
 */
export function decodeDFineOutput(
  raw: DFineRawOutputs,
  opts: DFineDecodeOptions
): DFineCanvasDetection[] {
  return decodeDFineWithStats(raw, opts).detections;
}
