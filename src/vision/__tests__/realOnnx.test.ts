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

/**
 * End-to-end: real ORT session -> decode -> padding filter -> letterbox reversal
 * -> tracker, i.e. every stage between the graph and the overlay.
 *
 * The one non-synthetic thing this can still prove without the 15 MB artifact is
 * that the *pipeline* neither invents boxes nor duplicates them. The numbers the
 * overlay would receive are asserted to equal the numbers the decoder produced.
 */
describe('pipeline: decoder -> worker filters -> tracker -> overlay input', () => {
  const FRAME = { width: 640, height: 480 };
  // 640x480 into 640: scale 1, padY 80, content 640x320.
  const geo = { padX: 0, padY: 80, contentWidth: 640, contentHeight: 320 };

  it('carries decoder output through to the overlay without duplicating it', async () => {
    const { filterToContentRegion } = await import('../dfine');
    const { unletterboxBox } = await import('../detector');
    const { IouTracker } = await import('../tracker');
    const { mapLabelToVisionClass } = await import('../detector');
    const ort = await import('onnxruntime-web');
    const bytes = new Uint8Array(readFileSync(MODEL));
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    const out = await session.run({
      images: new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from([BigInt(640), BigInt(640)]), [1, 2]),
    });

    const { detections, counts } = decodeDFineWithStats(
      {
        labels: { dims: out.labels.dims as unknown as readonly number[], data: out.labels.data as ArrayLike<unknown> },
        boxes: { dims: out.boxes.dims as unknown as readonly number[], data: out.boxes.data as ArrayLike<number> },
        scores: { dims: out.scores.dims as unknown as readonly number[], data: out.scores.data as ArrayLike<number> },
      },
      { threshold: 0.5, labels: LABELS, maxDetections: 40 }
    );
    expect(counts.kept).toBe(2);

    // Worker stage: padding rejection (boxes at canvas y 120..300 and 200..420
    // both overlap the 80..400 content band, so nothing is dropped here).
    const { kept, droppedInPadding } = filterToContentRegion(detections, geo);
    expect(droppedInPadding).toBe(0);
    expect(kept).toHaveLength(counts.kept);

    // Worker stage: letterbox reversal into frame space.
    const inFrame = kept.map((d) => ({
      box: unletterboxBox(d.box, { ...geo, frameWidth: FRAME.width, frameHeight: FRAME.height } as never,
        FRAME.width, FRAME.height),
      classId: mapLabelToVisionClass(LABELS[d.classIndex]),
      modelLabel: LABELS[d.classIndex],
      confidence: d.confidence,
    }));

    // Geometry round-trip: canvas (100,120) 120x180, padY 80, scale 1 -> (100,40).
    expect(inFrame[0].box).toEqual({ x: 100, y: 40, width: 120, height: 180 });
    expect(inFrame[1].box).toEqual({ x: 400, y: 120, width: 70, height: 220 });

    // Tracker stage: first frame must render exactly what was decoded.
    const tracker = new IouTracker({ maxTracks: 40 });
    const rendered = tracker.update(inFrame, 1000);
    expect(rendered).toHaveLength(2);
    expect(rendered.map((t) => t.box)).toEqual(inFrame.map((d) => d.box));

    // Second frame with the identical detections must still render 2, not 4.
    expect(tracker.update(inFrame, 2250)).toHaveLength(2);

    // Third frame with nothing detected must render 0, not the 2 ghosts.
    expect(tracker.update([], 3500)).toHaveLength(0);
  });
});
