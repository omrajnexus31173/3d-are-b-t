import { describe, expect, it } from 'vitest';
import { IouTracker } from '../tracker';
import { decodeNanoDet } from '../tfjsDetector';
import { assessImageRisk, estimateDistance, focalLengthPx } from '../distance';
import type { VisionClassId } from '../types';

const box = (x: number, y: number, w = 60, h = 120) => ({ x, y, width: w, height: h });

describe('IouTracker', () => {
  it('assigns a stable id to an object moving smoothly', () => {
    const tracker = new IouTracker({ iouThreshold: 0.2 });
    let tracks = tracker.update([{ box: box(100, 100), classId: 'pedestrian', modelLabel: 'person', confidence: 0.9 }], 1000);
    expect(tracks).toHaveLength(1);
    const id = tracks[0].trackId;

    for (let i = 1; i <= 5; i++) {
      tracks = tracker.update(
        [{ box: box(100 + i * 4, 100 + i * 2), classId: 'pedestrian', modelLabel: 'person', confidence: 0.9 }],
        1000 + i * 100
      );
      expect(tracks[0].trackId).toBe(id);
    }
    expect(tracks[0].hits).toBe(6);
    expect(tracks[0].vxPx).toBeGreaterThan(0); // moving right
  });

  it('creates separate ids for two distinct objects', () => {
    const tracker = new IouTracker({ iouThreshold: 0.3 });
    const tracks = tracker.update(
      [
        { box: box(10, 10), classId: 'car', modelLabel: 'car', confidence: 0.8 },
        { box: box(500, 300), classId: 'car', modelLabel: 'car', confidence: 0.7 },
      ],
      1000
    );
    expect(tracks).toHaveLength(2);
    expect(new Set(tracks.map((t) => t.trackId)).size).toBe(2);
  });

  it('drops tracks that disappear for longer than maxMissed', () => {
    const tracker = new IouTracker({ iouThreshold: 0.3, maxMissed: 2 });
    tracker.update([{ box: box(10, 10), classId: 'car', modelLabel: 'car', confidence: 0.8 }], 1000);
    expect(tracker.getTracks()).toHaveLength(1);
    tracker.update([], 1100);
    tracker.update([], 1200);
    expect(tracker.getTracks()).toHaveLength(1); // missed == 2 → still alive
    tracker.update([], 1300);
    expect(tracker.getTracks()).toHaveLength(0); // missed == 3 → removed
  });

  it('measures box growth (approach) in image space', () => {
    const tracker = new IouTracker({ iouThreshold: 0.1 });
    tracker.update([{ box: box(100, 100, 40, 40), classId: 'car', modelLabel: 'car', confidence: 0.8 }], 1000);
    let tracks = tracker.update(
      [{ box: box(95, 95, 52, 52), classId: 'car', modelLabel: 'car', confidence: 0.8 }],
      1200
    );
    expect(tracks[0].growthRate).toBeGreaterThan(0);
    tracks = tracker.update(
      [{ box: box(95, 95, 52, 52), classId: 'car', modelLabel: 'car', confidence: 0.8 }],
      1400
    );
    expect(tracks[0].growthRate).toBeGreaterThan(0); // smoothed, still positive
  });

  it('does not match boxes of incompatible classes', () => {
    const tracker = new IouTracker({ iouThreshold: 0.1 });
    tracker.update([{ box: box(10, 10), classId: 'car', modelLabel: 'car', confidence: 0.8 }], 1000);
    const tracks = tracker.update(
      [{ box: box(10, 10), classId: 'pedestrian', modelLabel: 'person', confidence: 0.8 }],
      1100
    );
    /*
     * Association: the pedestrian did not absorb the car track - both are live.
     * Rendering: only the pedestrian was detected this frame, so only it is
     * drawn; the car is retained for id continuity but not rendered.
     */
    expect(tracker.getTracks()).toHaveLength(2);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].classId).toBe('pedestrian');
  });

  it('resets cleanly (no id reuse collisions)', () => {
    const tracker = new IouTracker();
    tracker.update([{ box: box(10, 10), classId: 'car', modelLabel: 'car', confidence: 0.8 }], 1000);
    tracker.reset();
    const tracks = tracker.update([{ box: box(10, 10), classId: 'car', modelLabel: 'car', confidence: 0.8 }], 2000);
    expect(tracks[0].trackId).toBe('CAM-1');
  });
});

describe('NanoDet decoding (TF.js fallback)', () => {
  /** Build the six NanoDet heads with one planted detection at stride 16. */
  function heads(planted: { stride: number; cell: number; classIdx: number; logit: number }) {
    const out = [];
    for (const stride of [8, 16, 32]) {
      const side = 416 / stride;
      const anchors = side * side;
      const scores = new Float32Array(anchors * 80).fill(-8);
      const reg = new Float32Array(anchors * 44).fill(0.1);
      if (stride === planted.stride) {
        scores[planted.cell * 80 + planted.classIdx] = planted.logit;
        // centre of the 11-bin distribution at bin 5 → 5 * stride distance
        for (let k = 0; k < 4; k++) {
          reg.fill(0, planted.cell * 44 + k * 11, planted.cell * 44 + k * 11 + 11);
          reg[planted.cell * 44 + k * 11 + 5] = 10;
        }
      }
      out.push({ shape: [1, anchors, 80], data: scores });
      out.push({ shape: [1, anchors, 44], data: reg });
    }
    return out;
  }

  it('decodes a planted detection with the right class and geometry', () => {
    const stride = 16;
    const side = 416 / stride; // 26
    const cell = 5 * side + 7; // row 5, col 7
    const dets = decodeNanoDet(heads({ stride, cell, classIdx: 2, logit: 4 }), 416, 832, 416, 0.5);
    expect(dets).toHaveLength(1);
    expect(dets[0].label).toBe('car'); // COCO index 2
    expect(dets[0].confidence).toBeGreaterThan(0.9);
    const cxModel = (7 + 0.5) * stride;
    const cyModel = (5 + 0.5) * stride;
    const centreX = dets[0].x + dets[0].width / 2;
    const centreY = dets[0].y + dets[0].height / 2;
    // frame is 2x wider than the model input
    expect(centreX).toBeCloseTo(cxModel * 2, 3);
    expect(centreY).toBeCloseTo(cyModel, 3);
  });

  it('returns nothing above threshold for background', () => {
    const stride = 8;
    const out = [];
    for (const s of [8, 16, 32]) {
      const anchors = (416 / s) ** 2;
      out.push({ shape: [1, anchors, 80], data: new Float32Array(anchors * 80).fill(-8) });
      out.push({ shape: [1, anchors, 44], data: new Float32Array(anchors * 44) });
    }
    expect(decodeNanoDet(out, 416, 640, 480, 0.4)).toHaveLength(0);
    void stride;
  });
});

describe('monocular distance + risk', () => {
  it('reports "unavailable" without calibration instead of guessing', () => {
    const d = estimateDistance('car' as VisionClassId, 200, 1280, null);
    expect(d.value).toBeNull();
    expect(d.provenance).toBe('unavailable');
    expect(d.basis).toMatch(/calibration/i);
  });

  it('estimates a plausible range once calibrated, tagged as estimated', () => {
    const calib = { focalLengthMm: 3.6, sensorWidthMm: 4.8 }; // typical laptop webcam
    const f = focalLengthPx(calib, 1280);
    expect(f.value).toBeCloseTo(960, 6); // 3.6/4.8*1280
    const d = estimateDistance('car' as VisionClassId, 96, 1280, calib);
    // (960 px * 1.5 m) / 96 px = 15 m
    expect(d.provenance).toBe('estimated');
    expect(d.value).toBeCloseTo(15, 1);
  });

  it('has no size prior for potholes (no fabricated range)', () => {
    const d = estimateDistance('pothole' as VisionClassId, 40, 1280, {
      focalLengthMm: 3.6,
      sensorWidthMm: 4.8,
    });
    expect(d.provenance).toBe('unavailable');
    expect(d.value).toBeNull();
  });

  it('grades a large, central, fast-growing box as high risk', () => {
    const near = assessImageRisk({
      classId: 'pedestrian',
      box: { x: 500, y: 300, width: 300, height: 400 },
      frameWidth: 1280,
      frameHeight: 720,
      growthRatePerSec: 0.8,
    });
    const far = assessImageRisk({
      classId: 'pedestrian',
      box: { x: 40, y: 40, width: 20, height: 30 },
      frameWidth: 1280,
      frameHeight: 720,
      growthRatePerSec: -0.1,
    });
    expect(['HIGH', 'CRITICAL']).toContain(near.riskLevel);
    expect(far.riskLevel).toBe('LOW');
    expect(near.basis).toMatch(/image-space/);
  });
});
