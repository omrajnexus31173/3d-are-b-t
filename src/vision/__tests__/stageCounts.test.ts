/**
 * Regression tests for the stage-by-stage count line.
 *
 * The point of this diagnostic is to name the stage that changes the count, so
 * the label that appears in the operator's console is asserted here verbatim -
 * a renamed field would silently break the investigation it exists for.
 */
import { describe, it, expect } from 'vitest';
import { formatStageCounts, type StageCounts } from '../diagnostics';

const stages: StageCounts = {
  raw: 300,
  afterThreshold: 11,
  afterPadding: 11,
  tracked: 13,
  rendered: 11,
};

describe('formatStageCounts', () => {
  it('prints every stage in pipeline order', () => {
    const line = formatStageCounts(
      'dfine',
      stages,
      { name: 'D-FINE-N (COCO)', provider: 'wasm' },
      0.5
    );
    expect(line).toBe(
      '[bharat-av][stages] detector=dfine model=D-FINE-N (COCO) provider=wasm thr=0.5 ' +
        'raw=300 -> afterThreshold=11 -> afterPadding=11 -> tracked=13 -> rendered=11'
    );
  });

  it('omits the provider when unknown', () => {
    const line = formatStageCounts('yolo', stages, { name: 'YOLO11n', provider: null }, 0.35);
    expect(line).toContain('model=YOLO11n thr=0.35');
    expect(line).not.toContain('provider=');
  });

  it('makes a stale-track gap visible', () => {
    // tracked > rendered is normal after the fix: retained for ids, not drawn.
    const line = formatStageCounts('dfine', stages, { name: 'D-FINE-N (COCO)' }, 0.5);
    expect(line).toContain('tracked=13');
    expect(line).toContain('rendered=11');
    expect(stages.tracked - stages.rendered).toBe(2);
  });

  it('reports zero rendered when nothing is detected', () => {
    const empty: StageCounts = {
      raw: 300,
      afterThreshold: 0,
      afterPadding: 0,
      tracked: 2,
      rendered: 0,
    };
    const line = formatStageCounts('dfine', empty, { name: 'D-FINE-N (COCO)' }, 0.5);
    expect(line).toContain('afterThreshold=0');
    expect(line).toContain('tracked=2 -> rendered=0');
  });
});

/**
 * End-to-end stage accounting through a REAL onnxruntime-web session.
 *
 * Runs the committed contract fixture (a real .onnx graph with D-FINE's exact
 * signature) and asserts the counts at every stage the operator's diagnostic
 * line reports, using the same decode/filter/letterbox code the browser runs.
 * This cannot validate the 15 MB artifact's *accuracy*, only that the stage
 * numbers are produced by real tensors rather than mocks.
 */
describe('stage counts from a real ORT session', () => {
  const MODEL = new URL('./fixtures/dfine_contract_stub.onnx', import.meta.url).pathname;

  it('raw=300, threshold filters, padding filters, tracker renders', async () => {
    const { readFileSync } = await import('node:fs');
    const ort = await import('onnxruntime-web');
    const { decodeDFineWithStats, filterToContentRegion } = await import('../dfine');
    const { unletterboxBox, mapLabelToVisionClass } = await import('../detector');
    const { IouTracker } = await import('../tracker');

    const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(MODEL)), {
      executionProviders: ['wasm'],
    });
    const out = await session.run({
      images: new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]),
      orig_target_sizes: new ort.Tensor(
        'int64',
        BigInt64Array.from([BigInt(640), BigInt(640)]),
        [1, 2]
      ),
    });

    const labels = Array.from({ length: 80 }, (_, i) => `class-${i}`);
    const { detections, counts } = decodeDFineWithStats(
      {
        labels: { dims: out.labels.dims as unknown as readonly number[], data: out.labels.data as ArrayLike<unknown> },
        boxes: { dims: out.boxes.dims as unknown as readonly number[], data: out.boxes.data as ArrayLike<number> },
        scores: { dims: out.scores.dims as unknown as readonly number[], data: out.scores.data as ArrayLike<number> },
      },
      { threshold: 0.5, labels, maxDetections: 40 }
    );

    expect(counts.raw).toBe(300);
    expect(counts.kept).toBe(2);

    // 640x480 frame -> padY 80, content band y 80..400.
    const geo = { padX: 0, padY: 80, contentWidth: 640, contentHeight: 320 };
    const { kept, droppedInPadding } = filterToContentRegion(detections, geo);
    expect(droppedInPadding).toBe(0);
    expect(kept).toHaveLength(2);

    const inFrame = kept.map((d) => ({
      box: unletterboxBox(d.box, geo as never, 640, 480),
      classId: mapLabelToVisionClass(labels[d.classIndex]),
      modelLabel: labels[d.classIndex],
      confidence: d.confidence,
    }));

    const tracker = new IouTracker({ maxTracks: 40 });
    const renderedFrame1 = tracker.update(inFrame, 1000);
    const renderedFrame2 = tracker.update(inFrame, 2000);
    const renderedAfterEmpty = tracker.update([], 3000);

    const stageLine: StageCounts = {
      raw: counts.raw,
      afterThreshold: counts.kept,
      afterPadding: kept.length,
      tracked: tracker.getTracks().length,
      rendered: renderedFrame1.length,
    };
    expect(stageLine).toEqual({
      raw: 300,
      afterThreshold: 2,
      afterPadding: 2,
      tracked: 2,
      rendered: 2,
    });

    // Repeat frame: still 2 drawn, still 2 retained (no duplication).
    expect(renderedFrame2).toHaveLength(2);
    expect(tracker.getTracks()).toHaveLength(2);

    // Empty frame: 0 drawn, but 2 retained -> tracked(2) > rendered(0).
    expect(renderedAfterEmpty).toHaveLength(0);
    expect(tracker.getTracks()).toHaveLength(2);
  });
});
