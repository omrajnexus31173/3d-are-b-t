/**
 * Lightweight, deterministic IoU tracker for camera detections.
 *
 * This is intentionally *not* a Kalman/DeepSORT stack: for a browser-only,
 * single-camera ADAS preview a greedy IoU association gives stable ids at a
 * fraction of the cost, and it is fully unit-testable. Track kinematics are
 * reported in image space (pixels) which is what a monocular camera actually
 * measures; conversions to metres are handled separately and explicitly
 * flagged as estimates (see `distance.ts`).
 */
import { BoundingBox, VisionClassId } from './types';
import { iou } from './detector';

export interface TrackerInput {
  box: BoundingBox;
  classId: VisionClassId;
  modelLabel: string;
  confidence: number;
}

export interface Track extends TrackerInput {
  trackId: string;
  /** Frames this track has been continuously matched. */
  hits: number;
  /** Consecutive frames without a match. */
  missed: number;
  /** First observation timestamp (ms). */
  firstSeen: number;
  /** Last matched timestamp (ms). */
  lastSeen: number;
  /** Exponential moving average of confidence. */
  confidenceEma: number;
  /** Image-space velocity, pixels / second (measured, image space only). */
  vxPx: number;
  vyPx: number;
  /** Exponential moving average of box area growth per second (1/s), >0 approaching. */
  growthRate: number;
}

export interface TrackerOptions {
  iouThreshold?: number;
  maxMissed?: number;
  /** Track ids confirmed only after N hits are exposed. */
  minHits?: number;
}

const PREFIX = 'CAM';

export class IouTracker {
  private tracks = new Map<string, Track>();
  private nextId = 1;
  private readonly iouThreshold: number;
  private readonly maxMissed: number;
  private readonly minHits: number;
  private readonly prefix: string;

  constructor(options: TrackerOptions = {}, prefix = PREFIX) {
    this.iouThreshold = options.iouThreshold ?? 0.3;
    this.maxMissed = options.maxMissed ?? 10;
    this.minHits = options.minHits ?? 1;
    this.prefix = prefix;
  }

  reset(): void {
    this.tracks.clear();
    this.nextId = 1;
  }

  /** All currently live, confirmed tracks (copy). */
  getTracks(): Track[] {
    return Array.from(this.tracks.values())
      .filter((t) => t.hits >= this.minHits)
      .map((t) => ({ ...t }));
  }

  /** Number of live tracks including unconfirmed ones. */
  get size(): number {
    return this.tracks.size;
  }

  /**
   * Associate new detections with existing tracks and return the updated tracks.
   * `timestampMs` must be monotonically increasing.
   */
  update(detections: TrackerInput[], timestampMs: number): Track[] {
    const liveTracks = Array.from(this.tracks.values());
    const used = new Set<string>();
    const matchedDetections = new Set<number>();

    // Greedy global best-IoU association across all (track, detection) pairs.
    const pairs: { ti: number; di: number; score: number }[] = [];
    for (let ti = 0; ti < liveTracks.length; ti++) {
      const t = liveTracks[ti];
      for (let di = 0; di < detections.length; di++) {
        const d = detections[di];
        if (d.classId !== t.classId && d.classId !== 'unknown' && t.classId !== 'unknown') {
          continue;
        }
        const score = iou(t.box, d.box);
        if (score >= this.iouThreshold) pairs.push({ ti, di, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    for (const { ti, di } of pairs) {
      const track = liveTracks[ti];
      if (used.has(track.trackId) || matchedDetections.has(di)) continue;
      used.add(track.trackId);
      matchedDetections.add(di);
      this.applyMatch(track, detections[di], timestampMs);
    }

    // Age unmatched tracks.
    for (const track of liveTracks) {
      if (used.has(track.trackId)) continue;
      track.missed += 1;
      if (track.missed > this.maxMissed) {
        this.tracks.delete(track.trackId);
      } else {
        // Decay velocity/growth so stale tracks do not report phantom motion.
        track.vxPx *= 0.5;
        track.vyPx *= 0.5;
        track.growthRate *= 0.5;
      }
    }

    // Spawn tracks for unmatched detections.
    for (let di = 0; di < detections.length; di++) {
      if (matchedDetections.has(di)) continue;
      const d = detections[di];
      const trackId = `${this.prefix}-${this.nextId++}`;
      const track: Track = {
        ...d,
        trackId,
        hits: 1,
        missed: 0,
        firstSeen: timestampMs,
        lastSeen: timestampMs,
        confidenceEma: d.confidence,
        vxPx: 0,
        vyPx: 0,
        growthRate: 0,
      };
      this.tracks.set(trackId, track);
    }

    return this.getTracks();
  }

  private applyMatch(track: Track, detection: TrackerInput, timestampMs: number): void {
    const dt = Math.max(1, timestampMs - track.lastSeen) / 1000;
    const prevCx = track.box.x + track.box.width / 2;
    const prevCy = track.box.y + track.box.height / 2;
    const nextCx = detection.box.x + detection.box.width / 2;
    const nextCy = detection.box.y + detection.box.height / 2;
    const instVx = (nextCx - prevCx) / dt;
    const instVy = (nextCy - prevCy) / dt;

    const prevArea = Math.max(1, track.box.width * track.box.height);
    const nextArea = Math.max(1, detection.box.width * detection.box.height);
    const instGrowth = (nextArea - prevArea) / prevArea / dt;

    // EMA (alpha 0.45) keeps the numbers readable in the HUD without hiding motion.
    const a = 0.45;
    track.vxPx = a * instVx + (1 - a) * track.vxPx;
    track.vyPx = a * instVy + (1 - a) * track.vyPx;
    track.growthRate = a * instGrowth + (1 - a) * track.growthRate;
    track.confidenceEma = a * detection.confidence + (1 - a) * track.confidenceEma;

    track.box = detection.box;
    track.confidence = detection.confidence;
    track.modelLabel = detection.modelLabel;
    if (detection.classId !== 'unknown') track.classId = detection.classId;
    track.hits += 1;
    track.missed = 0;
    track.lastSeen = timestampMs;
  }
}
