import { describe, expect, it } from 'vitest';
import {
  COCO_LABELS,
  computeLetterbox,
  decodeYoloOutput,
  iou,
  mapLabelToVisionClass,
  nonMaxSuppression,
  unletterboxBox,
  type RawDetection,
} from '../detector';

describe('letterbox geometry', () => {
  it('fits a 16:9 frame into a square input and centres it', () => {
    const geo = computeLetterbox(1280, 720, 640);
    expect(geo.scale).toBeCloseTo(0.5, 6);
    expect(geo.contentWidth).toBeCloseTo(640, 6);
    expect(geo.contentHeight).toBeCloseTo(360, 6);
    expect(geo.padX).toBeCloseTo(0, 6);
    expect(geo.padY).toBeCloseTo(140, 6);
  });

  it('round-trips a box through letterbox/unletterbox', () => {
    const geo = computeLetterbox(1280, 720, 640);
    const inFrame = { x: 320, y: 180, width: 160, height: 90 };
    // project into model space
    const modelBox = {
      x: inFrame.x * geo.scale + geo.padX,
      y: inFrame.y * geo.scale + geo.padY,
      width: inFrame.width * geo.scale,
      height: inFrame.height * geo.scale,
    };
    const back = unletterboxBox(modelBox, geo);
    expect(back.x).toBeCloseTo(inFrame.x, 4);
    expect(back.y).toBeCloseTo(inFrame.y, 4);
    expect(back.width).toBeCloseTo(inFrame.width, 4);
    expect(back.height).toBeCloseTo(inFrame.height, 4);
  });

  it('clamps boxes that fall outside the frame', () => {
    const geo = computeLetterbox(640, 480, 640);
    const clamped = unletterboxBox({ x: -50, y: -50, width: 900, height: 900 }, geo);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(640);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(480);
  });
});

/** Build a YOLOv8-style output tensor [1, 4+nc, N] with one planted detection. */
function makeYoloTensor(
  nc: number,
  anchors: number,
  planted: { anchor: number; cx: number; cy: number; w: number; h: number; classIdx: number; score: number }
) {
  const channels = 4 + nc;
  const data = new Float32Array(channels * anchors);
  // background: tiny scores
  for (let a = 0; a < anchors; a++) {
    for (let c = 0; c < nc; c++) data[(4 + c) * anchors + a] = 0.01;
  }
  const a = planted.anchor;
  data[0 * anchors + a] = planted.cx;
  data[1 * anchors + a] = planted.cy;
  data[2 * anchors + a] = planted.w;
  data[3 * anchors + a] = planted.h;
  data[(4 + planted.classIdx) * anchors + a] = planted.score;
  return { dims: [1, channels, anchors] as const, data };
}

describe('decodeYoloOutput', () => {
  it('decodes a [1, 4+nc, N] Ultralytics tensor', () => {
    const tensor = makeYoloTensor(80, 8400, {
      anchor: 7,
      cx: 320,
      cy: 240,
      w: 100,
      h: 200,
      classIdx: 0,
      score: 0.92,
    });
    const out = decodeYoloOutput([tensor], { inputSize: 640, labels: COCO_LABELS, threshold: 0.5 });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('person');
    expect(out[0].confidence).toBeCloseTo(0.92, 3);
    // cxcywh → xywh
    expect(out[0].box.x).toBeCloseTo(270, 2);
    expect(out[0].box.y).toBeCloseTo(140, 2);
    expect(out[0].box.width).toBeCloseTo(100, 2);
    expect(out[0].box.height).toBeCloseTo(200, 2);
  });

  it('decodes the transposed [1, N, 4+nc] layout too', () => {
    const nc = 3;
    const anchors = 10;
    const ch = 4 + nc;
    const data = new Float32Array(anchors * ch);
    data[3 * ch + 0] = 100;
    data[3 * ch + 1] = 120;
    data[3 * ch + 2] = 40;
    data[3 * ch + 3] = 60;
    data[3 * ch + 5] = 0.7; // class index 1
    const out = decodeYoloOutput(
      [{ dims: [1, anchors, ch], data }],
      { inputSize: 640, labels: ['a', 'b', 'c'], threshold: 0.5 }
    );
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('b');
    expect(out[0].box.x).toBeCloseTo(80, 4);
  });

  it('handles objectness-prefixed outputs (YOLOv5/v7)', () => {
    const nc = 2;
    const ch = 5 + nc;
    const data = new Float32Array([320, 320, 64, 64, 0.9, 0.1, 0.8]);
    const out = decodeYoloOutput(
      [{ dims: [1, 1, ch], data }],
      { inputSize: 640, labels: ['cat', 'dog'], threshold: 0.3 }
    );
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('dog');
    expect(out[0].confidence).toBeCloseTo(0.9 * 0.8, 5);
  });

  it('applies sigmoid when the output contains raw logits', () => {
    const nc = 2;
    const ch = 4 + nc;
    // logit 3.0 → sigmoid ≈ 0.9526
    const data = new Float32Array([100, 100, 20, 20, -2.0, 3.0]);
    const out = decodeYoloOutput(
      [{ dims: [1, 1, ch], data }],
      { inputSize: 640, labels: ['cat', 'dog'], threshold: 0.5 }
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBeCloseTo(1 / (1 + Math.exp(-3)), 5);
  });

  it('ignores tensors with unknown shapes instead of throwing', () => {
    const out = decodeYoloOutput(
      [{ dims: [1, 25200, 85], data: new Float32Array(10) }],
      { inputSize: 640, labels: COCO_LABELS, threshold: 0.5 }
    );
    // 85 channels is YOLOv3/v5 with 80 classes → objectness layout should decode,
    // but the data buffer is truncated: no detections, and no crash.
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('NMS', () => {
  const det = (x: number, y: number, w: number, h: number, conf: number, cls = 0): RawDetection => ({
    box: { x, y, width: w, height: h },
    classIndex: cls,
    label: `c${cls}`,
    confidence: conf,
  });

  it('suppresses overlapping boxes of the same class', () => {
    const a = det(0, 0, 100, 100, 0.9);
    const b = det(5, 5, 100, 100, 0.8);
    const kept = nonMaxSuppression([a, b], 0.5, 10);
    expect(kept).toHaveLength(1);
    expect(kept[0].confidence).toBe(0.9);
  });

  it('keeps overlapping boxes of different classes (per-class NMS)', () => {
    const a = det(0, 0, 100, 100, 0.9, 0);
    const b = det(5, 5, 100, 100, 0.8, 1);
    expect(nonMaxSuppression([a, b], 0.5, 10)).toHaveLength(2);
  });

  it('respects the detection cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => det(i * 200, 0, 50, 50, 0.9 - i * 0.01));
    expect(nonMaxSuppression(many, 0.5, 3)).toHaveLength(3);
  });

  it('computes IoU correctly', () => {
    expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(1);
    expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 })).toBe(0);
    expect(
      iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 })
    ).toBeCloseTo(50 / 150, 6);
  });
});

describe('class mapping', () => {
  it('maps COCO labels onto BHARAT-AV traffic classes', () => {
    expect(mapLabelToVisionClass('person')).toBe('pedestrian');
    expect(mapLabelToVisionClass('cow')).toBe('cattle');
    expect(mapLabelToVisionClass('motorcycle')).toBe('motorcycle');
    expect(mapLabelToVisionClass('bicycle')).toBe('bicycle');
    expect(mapLabelToVisionClass('bus')).toBe('truck_bus');
    expect(mapLabelToVisionClass('truck')).toBe('truck_bus');
    expect(mapLabelToVisionClass('car')).toBe('car');
    expect(mapLabelToVisionClass('pothole')).toBe('pothole');
  });

  it('never invents an auto-rickshaw from a COCO label', () => {
    // COCO has no auto-rickshaw class: generic detectors report them as car/truck.
    expect(mapLabelToVisionClass('car')).not.toBe('auto_rickshaw');
    expect(mapLabelToVisionClass('truck')).not.toBe('auto_rickshaw');
  });

  it('falls back to unknown for unseen labels', () => {
    expect(mapLabelToVisionClass('unicorn')).toBe('unknown');
  });
});
