/**
 * Detection diagnostics.
 *
 * A DETR-family graph (D-FINE) always returns a FIXED number of queries (300),
 * because it is NMS-free: the graph does not decide how many objects are in the
 * frame, it emits a ranked row per query and leaves thresholding to the caller.
 * That makes raw vs. kept counts the single most useful number when the overlay
 * shows far too many boxes.
 *
 * These records are plain data so they can be asserted in tests and read from
 * the worker / engine without pulling in a logger or a browser dependency.
 */

export interface DetectionStatsSummary {
  /** Rows the graph emitted (queries), before any filtering. */
  raw: number;
  /** Rows that survived score + validity filtering. */
  kept: number;
  /** Rows dropped because score <= threshold. */
  belowThreshold: number;
  /** Rows dropped for a non-finite score or box. */
  invalid: number;
  /** Rows dropped for a degenerate (non-positive area) box. */
  degenerate: number;
  /** Rows dropped for a class index outside the label table. */
  badClass: number;
  /** Rows dropped because they lay wholly inside the letterbox filler. */
  inPadding?: number;
  /** Observed score range over ALL raw rows, 0 when empty. */
  scoreMin: number;
  scoreMax: number;
  /** Observed score range over KEPT rows, 0 when none kept. */
  keptScoreMin: number;
  keptScoreMax: number;
  /** Threshold the above was measured against. */
  threshold: number;
  /**
   * Rows that survived padding rejection AND unletterboxing, i.e. the boxes
   * actually sent to the main thread. Present on the worker's own report; the
   * main thread fills in the two tracker numbers below when it logs.
   */
  afterPadding?: number;
}

/**
 * The full stage-by-stage count from graph output to painted box.
 *
 * Deliberately ordered as the pipeline runs, because the whole point is to find
 * *which* stage changes the number. `rendered` is the only one the operator
 * actually sees on screen.
 */
export interface StageCounts {
  /** Rows the graph emitted (300 for D-FINE). */
  raw: number;
  /** Rows above the confidence threshold with a valid, non-degenerate box. */
  afterThreshold: number;
  /** ...minus rows lying wholly in the letterbox filler. */
  afterPadding: number;
  /** Live tracks after IoU association (identity, includes stale). */
  tracked: number;
  /** Tracks drawn this frame; equals what DetectionOverlay maps over. */
  rendered: number;
}

export function emptyDetectionStats(threshold = 0): DetectionStatsSummary {
  return {
    raw: 0,
    kept: 0,
    belowThreshold: 0,
    invalid: 0,
    degenerate: 0,
    badClass: 0,
    scoreMin: 0,
    scoreMax: 0,
    keptScoreMin: 0,
    keptScoreMax: 0,
    threshold,
  };
}

export interface SummaryBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionDiagnostic {
  /** Which decode path produced these boxes. */
  detector: 'yolo' | 'dfine' | 'tfjs';
  /** Raw graph output shapes, for spotting a changed export. */
  rawShapes: Record<string, readonly number[]>;
  counts: DetectionStatsSummary;
  /** Final boxes in SOURCE FRAME pixels, strongest first. */
  boxes: { label: string; confidence: number; box: SummaryBox }[];
  /** Source frame the boxes are expressed in. */
  frame: { width: number; height: number };
}

const round = (v: number): number => Math.round(v * 10) / 10;

/**
 * Format one diagnostic as a single readable line.
 *
 * Deliberately compact: this runs per frame at ~8 Hz, so a multi-line dump
 * would flood the console and hide the signal.
 */
export function formatDiagnostic(d: DetectionDiagnostic): string {
  const c = d.counts;
  const shapes = Object.entries(d.rawShapes)
    .map(([name, dims]) => `${name}[${dims.join(',')}]`)
    .join(' ');
  const keptRange =
    c.kept > 0 ? `${c.keptScoreMin.toFixed(2)}..${c.keptScoreMax.toFixed(2)}` : 'none';
  const top = d.boxes
    .slice(0, 3)
    .map(
      (b) =>
        `${b.label}@${b.confidence.toFixed(2)}(${round(b.box.x)},${round(b.box.y)},${round(
          b.box.width
        )}x${round(b.box.height)})`
    )
    .join(' ');

  return (
    `[bharat-av][${d.detector}] raw=${c.raw} kept=${c.kept} ` +
    `dropped(thr<=${c.threshold}:${c.belowThreshold} invalid:${c.invalid} ` +
    `degenerate:${c.degenerate} badClass:${c.badClass}` +
    (c.inPadding ? ` inPadding:${c.inPadding}` : '') +
    `) ` +
    `score=${c.scoreMin.toFixed(2)}..${c.scoreMax.toFixed(2)} keptScore=${keptRange} ` +
    `frame=${d.frame.width}x${d.frame.height}` +
    (shapes ? ` shapes=${shapes}` : '') +
    (top ? ` top=${top}` : '')
  );
}

/**
 * Format the stage-by-stage count as one line.
 *
 * Printed by the engine once per frame, after tracking, so a single line covers
 * the whole path and any stage that changes the count is immediately visible.
 */
export function formatStageCounts(
  detector: DetectionDiagnostic['detector'],
  stages: StageCounts,
  model: { name: string; provider?: string | null },
  threshold: number
): string {
  return (
    `[bharat-av][stages] detector=${detector} model=${model.name}` +
    (model.provider ? ` provider=${model.provider}` : '') +
    ` thr=${threshold} raw=${stages.raw} -> afterThreshold=${stages.afterThreshold}` +
    ` -> afterPadding=${stages.afterPadding} -> tracked=${stages.tracked}` +
    ` -> rendered=${stages.rendered}`
  );
}

/**
 * Emit a diagnostic line when explicitly enabled.
 *
 * Opt-in via `VITE_DETECTION_DEBUG=1` (build-time) or
 * `localStorage.bharatDetectionDebug = '1'` (runtime, main thread only —
 * a Web Worker has no localStorage, which is why the engine forwards the flag
 * on each infer request instead of letting the worker read it).
 */
export function detectionDebugEnabled(override?: boolean): boolean {
  if (override !== undefined) return override;
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
    if (env.VITE_DETECTION_DEBUG === '1' || env.VITE_DETECTION_DEBUG === 'true') return true;
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('bharatDetectionDebug') === '1';
    }
  } catch {
    /* SSR / locked-down storage */
  }
  return false;
}

export function logDiagnostic(d: DetectionDiagnostic, override?: boolean): void {
  if (!detectionDebugEnabled(override)) return;
  // eslint-disable-next-line no-console
  console.info(formatDiagnostic(d));
}

export function logStageCounts(
  detector: DetectionDiagnostic['detector'],
  stages: StageCounts,
  model: { name: string; provider?: string | null },
  threshold: number,
  override?: boolean
): void {
  if (!detectionDebugEnabled(override)) return;
  // eslint-disable-next-line no-console
  console.info(formatStageCounts(detector, stages, model, threshold));
}
