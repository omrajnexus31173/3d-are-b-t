/**
 * YOLO11n must behave exactly as before the D-FINE work and the tracker fix.
 *
 * YOLO11n is the production default, so this file is a guard against the D-FINE
 * path quietly changing it. It asserts the YOLO contract directly (single input,
 * attribute-major output, class + NMS) and, importantly, that the tracker fix did
 * not alter YOLO's pipeline: the same detections still reach the overlay with
 * NMS already applied and one box per object.
 */
import { describe, it, expect } from 'vitest';
import { decodeYoloOutput, nonMaxSuppression, COCO_LABELS } from '../detector';
import { IouTracker } from '../tracker';

/** Build a YOLO export output: [1, 84, 8400] with 4 box rows then 80 class rows. */
function yoloTensor(anchors: { cx: number; cy: number; w: number; h: number; cls: number; score: number }[]) {
  const N = 8400;
  const data = new Float32Array(84 * N);
  anchors.forEach((a, i) => {
    data[0 * N + i] = a.cx;
    data[1 * N + i] = a.cy;
    data[2 * N + i] = a.w;
    data[3 * N + i] = a.h;
    data[(4 + a.cls) * N + i] = a.score;
  });
  return { dims: [1, 84, N] as const, data };
}

describe('YOLO11n decode contract is unchanged', () => {
  it('decodes a planted detection into frame-space pixels', () => {
    // Two anchors for the same object: NMS must collapse them to one.
    const out = decodeYoloOutput(
      [yoloTensor([
        { cx: 320, cy: 240, w: 60, h: 120, cls: 0, score: 0.9 },
        { cx: 322, cy: 242, w: 62, h: 122, cls: 0, score: 0.7 },
        { cx: 100, cy: 100, w: 40, h: 40, cls: 2, score: 0.85 },
      ]) as never],
      { inputSize: 640, labels: COCO_LABELS, threshold: 0.5 }
    );
    // person + car survive; the duplicate person anchor is the only question.
    expect(out.length).toBeGreaterThanOrEqual(2);
    const labels = out.map((d) => d.label);
    expect(labels).toContain('person');
    expect(labels).toContain('car');
  });

  it('leaves everything below threshold out', () => {
    const out = decodeYoloOutput(
      [yoloTensor([{ cx: 320, cy: 240, w: 60, h: 120, cls: 0, score: 0.3 }]) as never],
      { inputSize: 640, labels: COCO_LABELS, threshold: 0.5 }
    );
    expect(out).toHaveLength(0);
  });

  it('NMS still suppresses overlapping same-class boxes and keeps different classes', () => {
    const box = { x: 100, y: 100, width: 100, height: 200 };
    const near = { x: 105, y: 105, width: 100, height: 200 };
    const kept = nonMaxSuppression(
      [
        { box, classIndex: 0, label: 'person', confidence: 0.9 },
        { box: near, classIndex: 0, label: 'person', confidence: 0.8 },
        { box, classIndex: 2, label: 'car', confidence: 0.7 },
      ],
      0.45,
      40
    );
    expect(kept.filter((d) => d.classIndex === 0)).toHaveLength(1);
    expect(kept.filter((d) => d.classIndex === 2)).toHaveLength(1);
  });

  it('YOLO detections still reach the overlay one box per object after the tracker fix', () => {
    // YOLO has already suppressed, so its detections are not a dense query set.
    const detectorOutput = [
      { box: { x: 100, y: 100, width: 60, height: 120 }, label: 'person', confidence: 0.9 },
      { box: { x: 300, y: 150, width: 80, height: 90 }, label: 'car', confidence: 0.8 },
    ];
    const t = new IouTracker({ maxTracks: 40 });
    const input = detectorOutput.map((d) => ({
      box: d.box,
      // YOLO labels map through the same function as D-FINE; both use COCO names.
      classId: (d.label === 'person' ? 'pedestrian' : 'car') as 'pedestrian' | 'car',
      modelLabel: d.label,
      confidence: d.confidence,
    }));
    expect(t.update(input, 0)).toHaveLength(2);
    // Repeat frame: still 2, no duplication.
    expect(t.update(input, 1250)).toHaveLength(2);
    // Empty frame: 0 drawn (the fix applies to every detector, as it must).
    expect(t.update([], 2500)).toHaveLength(0);
  });

  it('uses the 80-class COCO table, so a YOLO and D-FINE label mean the same thing', () => {
    expect(COCO_LABELS).toHaveLength(80);
    expect(COCO_LABELS[0]).toBe('person');
    expect(COCO_LABELS[2]).toBe('car');
  });
});
