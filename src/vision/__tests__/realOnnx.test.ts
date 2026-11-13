import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { decodeDFineWithStats } from '../dfine';

/**
 * REAL ONNX RUNTIME validation (not synthetic).
 *
 * Runs an actual .onnx graph through onnxruntime-web's WASM kernel and decodes
 * the genuine session output. The graph mirrors D-FINE-N's export signature
 * exactly (2 inputs incl. int64 orig_target_sizes, 3 outputs) and emits fixed
 * constants, so the assertions are exact while still exercising the real
 * tensor types: int64 arrives as BigInt64Array, floats as Float32Array.
 *
 * It does NOT validate D-FINE's accuracy - only that the decode path consumes
 * real ORT tensors correctly.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Committed fixture (8.7 kB): a real, valid .onnx graph with D-FINE's signature. */
const MODEL = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dfine_contract_stub.onnx');
const LABELS = Array.from({ length: 80 }, (_, i) => `class-${i}`);

describe.skipIf(!existsSync(MODEL))('real ONNX Runtime session -> decoder', () => {
  it('decodes genuine ORT output tensors', async () => {
    const ort = await import('onnxruntime-web');
    const bytes = new Uint8Array(readFileSync(MODEL));
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });

    expect(session.inputNames).toEqual(['images', 'orig_target_sizes']);
    expect(session.outputNames).toEqual(['labels', 'boxes', 'scores']);

    const out = await session.run({
      images: new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor(
        'int64',
        BigInt64Array.from([BigInt(640), BigInt(640)]),
        [1, 2]
      ),
    });

    // Tensor types as the real runtime produced them.
    expect(out.labels.type).toBe('int64');
    expect(out.labels.data).toBeInstanceOf(BigInt64Array);
    expect(out.labels.dims).toEqual([1, 300]);
    expect(out.boxes.dims).toEqual([1, 300, 4]);
    expect(out.scores.dims).toEqual([1, 300]);

    const { detections, counts } = decodeDFineWithStats(
      {
        labels: { dims: out.labels.dims as unknown as readonly number[], data: out.labels.data as ArrayLike<unknown> },
        boxes: { dims: out.boxes.dims as unknown as readonly number[], data: out.boxes.data as ArrayLike<number> },
        scores: { dims: out.scores.dims as unknown as readonly number[], data: out.scores.data as ArrayLike<number> },
      },
      { threshold: 0.5, labels: LABELS, maxDetections: 40 }
    );

    // 300 raw queries; only the 2 planted above 0.5 survive.
    expect(counts.raw).toBe(300);
    expect(counts.kept).toBe(2);
    expect(counts.belowThreshold).toBe(298);

    expect(detections[0].classIndex).toBe(2);
    expect(detections[0].confidence).toBeCloseTo(0.93, 5);
    expect(detections[0].box).toEqual({ x: 100, y: 120, width: 120, height: 180 });

    expect(detections[1].classIndex).toBe(0);
    expect(detections[1].box).toEqual({ x: 400, y: 200, width: 70, height: 220 });
  });

  it('the same real tensors at the OLD 0.35 threshold produce the over-dense output', async () => {
    const ort = await import('onnxruntime-web');
    const bytes = new Uint8Array(readFileSync(MODEL));
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    const out = await session.run({
      images: new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([BigInt(640), BigInt(640)]), [1, 2]),
    });

    const raw = {
      labels: { dims: out.labels.dims as unknown as readonly number[], data: out.labels.data as ArrayLike<unknown> },
      boxes: { dims: out.boxes.dims as unknown as readonly number[], data: out.boxes.data as ArrayLike<number> },
      scores: { dims: out.scores.dims as unknown as readonly number[], data: out.scores.data as ArrayLike<number> },
    };

    // 0.35 admits every background slot; the worker's cap then truncates to 40.
    const old = decodeDFineWithStats(raw, { threshold: 0.35, labels: LABELS, maxDetections: 40 });
    expect(old.counts.kept).toBe(40);

    // 0.5 gives the correct answer for this frame.
    const fixed = decodeDFineWithStats(raw, { threshold: 0.5, labels: LABELS, maxDetections: 40 });
    expect(fixed.counts.kept).toBe(2);
  });
});
