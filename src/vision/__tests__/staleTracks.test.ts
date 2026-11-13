/**
 * Regression tests for the browser-only "excessive overlapping boxes" symptom.
 *
 * Ground truth from the offline audit of the real artifact (threshold 0.50,
 * three street images): 11 / 13 / 12 detections per image, absolute
 * canvas-pixel boxes, labels 0..79, plausible person/car/bus/traffic-light
 * classes. The model emits about a dozen objects per frame.
 *
 * The browser drew far more than that. It was not a decoding fault: the tracker
 * retained a track for `maxMissed` (10) frames and the overlay drew every live
 * track, so one object became a trail of up to 11 boxes. At the ~0.8 FPS
 * measured on device that is 12.5 seconds per ghost.
 */
import { describe, it, expect } from 'vitest';
import { IouTracker } from '../tracker';
import type { BoundingBox } from '../types';

const box = (x: number, y: number, w = 60, h = 120): BoundingBox => ({ x, y, width: w, height: h });

/** Engine configuration, verbatim from detectionEngine.ts. */
const engineTracker = () => new IouTracker({ maxTracks: 40 });

const person = (x: number, y: number, confidence = 0.8) => ({
  box: box(x, y),
  classId: 'pedestrian' as const,
  modelLabel: 'person',
  confidence,
});

describe('stale tracks are retained but not drawn', () => {
  it('stops drawing a track the frame after it disappears', () => {
    const t = engineTracker();
    expect(t.update([person(100, 100)], 0)).toHaveLength(1);

    // The object is gone. It must not be drawn, at 0.8 FPS or any other rate.
    const rendered = t.update([], 1250);
    expect(rendered).toHaveLength(0);

    // But it is still retained for id continuity, and reported as stale.
    expect(t.getTracks()).toHaveLength(1);
    expect(t.getStale()).toHaveLength(1);
    expect(t.getRenderableTracks()).toHaveLength(0);
  });

  it('drops the track for good once maxMissed is exceeded', () => {
    const t = new IouTracker({ maxMissed: 3 });
    t.update([person(100, 100)], 0);
    for (let f = 1; f <= 3; f++) t.update([], f * 1000);
    expect(t.getTracks()).toHaveLength(1); // 3 misses is still retained
    t.update([], 4000);
    expect(t.getTracks()).toHaveLength(0); // 4th miss evicts
  });

  /**
   * The exact defect. A person walking fast relative to the inference rate
   * fails IoU association on consecutive frames, so each frame spawns a new
   * track. Before the fix all of them were drawn, producing a trail.
   */
  it('draws one box per real object while it moves, not a trail', () => {
    const t = engineTracker();
    const renderedCounts: number[] = [];
    const ghostIds = new Set<string>();
    let lastTrackId: string | null = null;

    for (let f = 0; f < 12; f++) {
      // 150 px per 1.25 s: a brisk walk across a 640 px frame.
      const tracks = t.update([person(40 + f * 150, 100)], f * 1250);
      renderedCounts.push(tracks.length);
      for (const tr of tracks) {
        if (lastTrackId !== null && tr.trackId !== lastTrackId) ghostIds.add(tr.trackId);
      }
      lastTrackId = tracks[0]?.trackId ?? null;
    }

    // Exactly one box drawn on every frame, no matter how badly IoU associates.
    expect(renderedCounts).toEqual(new Array(12).fill(1));
    // Before the fix this was 1,2,3,...,11 - the trail of ghosts.
    expect(Math.max(...renderedCounts)).toBe(1);
    // New ids appear as association fails - that is an id-churn issue, not a
    // rendering issue, and it must not translate into extra boxes.
    expect(ghostIds.size).toBeGreaterThan(0);
  });

  it('never exceeds the number of objects actually present in the frame', () => {
    const t = engineTracker();
    const DETECTIONS_PER_FRAME = 12; // measured real-model rate at 0.50
    const FRAME_MS = 1250;
    let peakRendered = 0;

    for (let f = 0; f < 30; f++) {
      // Every detection at a fresh position: nothing associates, worst case.
      const dets = Array.from({ length: DETECTIONS_PER_FRAME }, (_, i) =>
        person(20 + i * 45 + f * 7, 40 + i * 20)
      );
      peakRendered = Math.max(peakRendered, t.update(dets, f * FRAME_MS).length);
    }

    // This is the invariant the overlay depends on.
    expect(peakRendered).toBe(DETECTIONS_PER_FRAME);
  });

  it('caps the retained set independently of what is drawn', () => {
    const t = new IouTracker({ maxTracks: 5 });
    for (let f = 0; f < 10; f++) {
      t.update([person(10 + f * 100, 10)], f * 1000);
      // Whatever survives eviction, drawing is always a subset of retention.
      expect(t.getRenderableTracks().length).toBeLessThanOrEqual(t.getTracks().length);
    }
    expect(t.getTracks().length).toBeLessThanOrEqual(5);
  });

  it('still draws every detection when the frame is fully populated', () => {
    const t = engineTracker();
    const dets = Array.from({ length: 8 }, (_, i) => person(20 + i * 70, 50 + i * 10));
    expect(t.update(dets, 0)).toHaveLength(8);
    expect(t.update(dets, 1250)).toHaveLength(8); // all re-matched, all drawn
  });
});

describe('unknown-class association stays unfiltered', () => {
  it('merges unrelated COCO classes into one track because mapping is unknown', () => {
    const t = engineTracker();
    t.update([{ box: box(100, 100), classId: 'unknown', modelLabel: 'chair', confidence: 0.6 }], 0);
    const tracks = t.update(
      [{ box: box(105, 105), classId: 'unknown', modelLabel: 'couch', confidence: 0.6 }],
      500
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0].modelLabel).toBe('couch');
  });

  it('lets a track change class when a mapped detection arrives', () => {
    const t = engineTracker();
    t.update([{ box: box(100, 100), classId: 'unknown', modelLabel: 'chair', confidence: 0.6 }], 0);
    const tracks = t.update([person(100, 100, 0.9)], 500);
    expect(tracks[0].classId).toBe('pedestrian');
    expect(tracks[0].modelLabel).toBe('person');
  });
});

/**
 * Engine-level check: `buildFrame` feeds the overlay from `tracker.update()`, so
 * the frame handed to DetectionOverlay must never contain more detections than
 * the detector reported for that frame.
 */
describe('engine frame handed to the overlay', () => {
  it('never exceeds the detections reported for the frame', async () => {
    const { default: fs } = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../detectionEngine.ts', import.meta.url),
      'utf8'
    );
    // The engine must consume update()'s return value directly...
    expect(src).toContain('tracks = this.tracker.update(');
    // ...and must not re-render the full retained set behind its back.
    expect(src).not.toContain('tracker.getTracks()');
  });

  it('keeps the render cap and the tracker ceiling consistent', async () => {
    const { DEFAULT_DETECTION_CONFIG } = await import('../detectionEngine');
    // The overlay slice uses maxDetections; the tracker ceiling uses it too.
    expect(DEFAULT_DETECTION_CONFIG.maxDetections).toBe(40);
    const t = new IouTracker({ maxTracks: DEFAULT_DETECTION_CONFIG.maxDetections });
    const dets = Array.from({ length: 60 }, (_, i) => person(5 + i * 10, 20));
    expect(t.update(dets, 0).length).toBeLessThanOrEqual(DEFAULT_DETECTION_CONFIG.maxDetections);
  });
});
