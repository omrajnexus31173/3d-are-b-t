import { describe, expect, it } from 'vitest';

import { decodeDFineOutput, DFINE_QUERIES } from '../dfine';

const LABELS = ['person', 'bicycle', 'car'];

function boxes(rows: number[][]): { dims: number[]; data: Float32Array } {
  return { dims: [1, rows.length, 4], data: new Float32Array(rows.flat()) };
}

describe('decodeDFineOutput', () => {
  it('reads int64 labels supplied as BigInt64Array (ORT Web representation)', () => {
    // This is the shape that actually comes back from onnxruntime-web for an
    // int64 output: BigInt values, not numbers.
    const labels = { dims: [1, 3], data: new BigInt64Array([2n, 0n, 1n]) };
    const scores = { dims: [1, 3], data: new Float32Array([0.9, 0.8, 0.7]) };
    const box = boxes([
      [10, 20, 110, 140],
      [0, 0, 50, 50],
      [5, 5, 25, 45],
    ]);

    const out = decodeDFineOutput({ labels, boxes: box, scores }, {
      threshold: 0.5,
      labels: LABELS,
    });

    expect(out).toHaveLength(3);
    expect(out.map((d) => d.classIndex)).toEqual([2, 0, 1]);
    expect(out[0].confidence).toBeCloseTo(0.9, 5);
  });

  it('accepts plain-number labels from other runtimes', () => {
    const labels = { dims: [1, 2], data: [1, 0] };
    const scores = { dims: [1, 2], data: new Float32Array([0.9, 0.6]) };
    const box = boxes([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);

    const out = decodeDFineOutput({ labels, boxes: box, scores }, {
      threshold: 0.5,
      labels: LABELS,
    });

    expect(out.map((d) => d.classIndex)).toEqual([1, 0]);
  });

  it('drops rows below the threshold', () => {
    const labels = { dims: [1, 4], data: new BigInt64Array([0n, 0n, 0n, 0n]) };
    const scores = { dims: [1, 4], data: new Float32Array([0.9, 0.5, 0.49, 0.1]) };
    const box = boxes([
      [0, 0, 10, 10],
      [0, 0, 10, 10],
      [0, 0, 10, 10],
      [0, 0, 10, 10],
    ]);

    const out = decodeDFineOutput({ labels, boxes: box, scores }, {
      threshold: 0.5,
      labels: LABELS,
    });

    // strictly greater than the threshold: 0.5 is excluded
    expect(out).toHaveLength(1);
  });

  it('converts absolute xyxy into x/y/width/height', () => {
    const labels = { dims: [1, 1], data: new BigInt64Array([2n]) };
    const scores = { dims: [1, 1], data: new Float32Array([0.9]) };
    const box = boxes([[10, 20, 110, 140]]);

    const [d] = decodeDFineOutput({ labels, boxes: box, scores }, {
      threshold: 0.5,
      labels: LABELS,
    });

    expect(d.box).toEqual({ x: 10, y: 20, width: 100, height: 120 });
  });

  it('drops out-of-range class indices instead of inventing a label', () => {
    const labels = { dims: [1, 3], data: new BigInt64Array([0n, 99n, 1n]) };
    const scores = { dims: [1, 3], data: new Float32Array([0.9, 0.9, 0.9]) };
    const box = boxes([
      [0, 0, 10, 10],
      [0, 0, 10, 10],
      [0, 0, 10, 10],
    ]);

    const out = decodeDFineOutput({ labels, boxes: box, scores }, {
      threshold: 0.5,
      labels: LABELS,
    });

    expect(out.map((d) => d.classIndex)).toEqual([0, 1]);
  });

  it('rejects inverted and zero-area boxes', () => {
    const labels = { dims: [1, 3], data: new BigInt64Array([0n, 0n, 0n]) };
    const scores = { dims: [1, 3], data: new Float32Array([0.9, 0.9, 0.9]) };
    const box = boxes([
      [100, 100, 10, 10], // inverted
      [10, 10, 10, 40], // zero width
      [10, 10, 40, 40], // fine
    ]);

    const out = decodeDFineOutput({ labels, boxes: box, scores }, {
      threshold: 0.5,
      labels: LABELS,
    });

    expect(out).toHaveLength(1);
    expect(out[0].box).toEqual({ x: 10, y: 10, width: 30, height: 30 });
  });

  it('respects maxDetections', () => {
    const n = 5;
    const labels = { dims: [1, n], data: new BigInt64Array(n).fill(0n) };
    const scores = { dims: [1, n], data: new Float32Array(n).fill(0.9) };
    const box = boxes(Array.from({ length: n }, () => [0, 0, 10, 10]));

    const out = decodeDFineOutput({ labels, boxes: box, scores }, {
      threshold: 0.5,
      labels: LABELS,
      maxDetections: 2,
    });

    expect(out).toHaveLength(2);
  });

  it('returns nothing for an empty graph output', () => {
    const out = decodeDFineOutput(
      {
        labels: { dims: [1, 0], data: new BigInt64Array([]) },
        boxes: { dims: [1, 0, 4], data: new Float32Array([]) },
        scores: { dims: [1, 0], data: new Float32Array([]) },
      },
      { threshold: 0.5, labels: LABELS }
    );
    expect(out).toEqual([]);
  });

  it('exposes the 300-query contract constant', () => {
    expect(DFINE_QUERIES).toBe(300);
  });
});
