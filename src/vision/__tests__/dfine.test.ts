import { describe, expect, it } from 'vitest';
import { DFINE_QUERIES, decodeDFineOutput, decodeDFineWithStats } from '../dfine';
import { computeLetterbox, unletterboxBox } from '../detector';

/**
 * Fixtures describe the D-FINE deploy contract exactly as the authors' exporter
 * produces it (`src/zoo/dfine/postprocessor.py` deploy branch):
 *
 *   labels INT64 [1,300]    index % num_classes  -> 0..79
 *   boxes  FLOAT [1,300,4]  absolute xyxy, already scaled by orig_target_sizes
 *   scores FLOAT [1,300]    sigmoid, descending
 */
const LABELS = Array.from({ length: 80 }, (_, i) => `class-${i}`);

interface Row {
  score: number;
  cls: number;
  /** absolute xyxy in canvas pixels */
  xyxy: [number, number, number, number];
}

/** Build a 300-row query tensor with the given leading rows, rest "background". */
function makeOutput(rows: Row[], backgroundScore = 0.01) {
  const scores = new Float32Array(DFINE_QUERIES);
  const boxes = new Float32Array(DFINE_QUERIES * 4);
  const labels = new BigInt64Array(DFINE_QUERIES);

  rows.forEach((r, i) => {
    scores[i] = r.score;
    labels[i] = BigInt(r.cls);
    boxes.set(r.xyxy, i * 4);
  });

  // Remaining queries: realistic low-scoring slots with finite, non-degenerate
  // boxes. They must NOT appear in the output at a sane threshold.
  for (let i = rows.length; i < DFINE_QUERIES; i++) {
    scores[i] = backgroundScore;
    labels[i] = BigInt(i % 80);
    boxes.set([10 + (i % 100), 20 + (i % 100), 60 + (i % 100), 90 + (i % 100)], i * 4);
  }

  return {
    labels: { dims: [1, DFINE_QUERIES] as const, data: labels },
    boxes: { dims: [1, DFINE_QUERIES, 4] as const, data: boxes },
    scores: { dims: [1, DFINE_QUERIES] as const, data: scores },
  };
}

describe('D-FINE decode: known tensors -> expected boxes', () => {
  it('returns exactly the planted boxes with the expected xyxy -> xywh conversion', () => {
    const raw = makeOutput([
      { score: 0.91, cls: 2, xyxy: [100, 120, 220, 300] },
      { score: 0.77, cls: 0, xyxy: [400, 200, 470, 420] },
    ]);

    const out = decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS });

    expect(out).toHaveLength(2);
    // xyxy [100,120,220,300] -> x,y,w,h
    expect(out[0].classIndex).toBe(2);
    // float32 storage: 0.91f is 0.9100000262..., so compare with a tolerance.
    expect(out[0].confidence).toBeCloseTo(0.91, 6);
    expect(out[0].box.x).toBeCloseTo(100, 5);
    expect(out[0].box.y).toBeCloseTo(120, 5);
    expect(out[0].box.width).toBeCloseTo(120, 5);
    expect(out[0].box.height).toBeCloseTo(180, 5);

    expect(out[1].box.width).toBeCloseTo(70, 5);
    expect(out[1].box.height).toBeCloseTo(220, 5);
  });

  it('does not treat boxes as cxcywh (a cxcywh reading would centre them wrongly)', () => {
    // If the decoder wrongly assumed cxcywh, x would be 100-60=40 and y 120-90=30.
    const raw = makeOutput([{ score: 0.9, cls: 1, xyxy: [100, 120, 220, 300] }]);
    const [d] = decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS });
    expect(d.box.x).toBeCloseTo(100, 5);
    expect(d.box.y).toBeCloseTo(120, 5);
    expect(d.box.x).not.toBeCloseTo(40, 1);
    expect(d.box.y).not.toBeCloseTo(30, 1);
  });

  it('is NMS-free: two DIFFERENT objects of the same class both survive', () => {
    const raw = makeOutput([
      { score: 0.88, cls: 2, xyxy: [10, 10, 60, 60] },
      { score: 0.8, cls: 2, xyxy: [300, 300, 380, 400] },
    ]);
    expect(decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS })).toHaveLength(2);
  });

  it('keeps genuinely duplicated queries when no suppression is requested', () => {
    // Two queries on the same object. D-FINE's own post-processing does NOT
    // de-duplicate, so by default neither is removed...
    const raw = makeOutput([
      { score: 0.9, cls: 2, xyxy: [100, 100, 200, 200] },
      { score: 0.85, cls: 2, xyxy: [102, 101, 201, 202] },
    ]);
    expect(decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS })).toHaveLength(2);

    // ...and only an explicit nmsIou collapses them, which is opt-in.
    const suppressed = decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS, nmsIou: 0.5 });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].confidence).toBeCloseTo(0.9, 5);
  });
});

describe('D-FINE decode: the 300-query contract is why counts explode', () => {
  it('reports the full query set as raw and only the survivors as kept', () => {
    const raw = makeOutput([{ score: 0.9, cls: 2, xyxy: [100, 100, 200, 200] }], 0.3);
    const { counts } = decodeDFineWithStats(raw, { threshold: 0.5, labels: LABELS });

    expect(counts.raw).toBe(DFINE_QUERIES);
    expect(counts.kept).toBe(1);
    expect(counts.belowThreshold).toBe(DFINE_QUERIES - 1);
  });

  it('a low threshold admits hundreds of background queries (the reported bug)', () => {
    // Every background query sits at 0.30 with a valid box - exactly the input
    // that produced "hundreds of overlapping boxes" at the old 0.35 default.
    const raw = makeOutput([], 0.3);

    const low = decodeDFineWithStats(raw, { threshold: 0.25, labels: LABELS, maxDetections: 300 });
    expect(low.counts.kept).toBe(300);

    // The same frame at D-FINE's operating point yields almost nothing, which is
    // the correct answer for a frame with no confident object.
    const high = decodeDFineWithStats(raw, { threshold: 0.5, labels: LABELS, maxDetections: 300 });
    expect(high.counts.kept).toBe(0);
  });

  it('background boxes never leak into the output at a sane threshold', () => {
    const raw = makeOutput(
      [{ score: 0.93, cls: 5, xyxy: [50, 60, 150, 260] }],
      0.31 // just under a 0.5 threshold but well above the old 0.35
    );
    const out = decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS });
    expect(out).toHaveLength(1);
    expect(out[0].box).toMatchObject({ x: 50, y: 60, width: 100, height: 200 });
  });
});

describe('D-FINE decode: score range and drop accounting', () => {
  it('reports min/max over raw and kept rows separately', () => {
    const raw = makeOutput([
      { score: 0.95, cls: 1, xyxy: [10, 10, 50, 90] },
      { score: 0.6, cls: 3, xyxy: [200, 10, 260, 90] },
    ], 0.02);
    const { detections, counts } = decodeDFineWithStats(raw, { threshold: 0.5, labels: LABELS });

    expect(detections).toHaveLength(2);
    expect(counts.keptScoreMin).toBeCloseTo(0.6, 5);
    expect(counts.keptScoreMax).toBeCloseTo(0.95, 5);
    expect(counts.scoreMin).toBeCloseTo(0.02, 5);
    expect(counts.scoreMax).toBeCloseTo(0.95, 5);
  });

  it('counts each rejection reason separately', () => {
    const labels = new BigInt64Array(DFINE_QUERIES).fill(BigInt(1));
    const boxes = new Float32Array(DFINE_QUERIES * 4);
    const scores = new Float32Array(DFINE_QUERIES).fill(0.9);

    // row 0: good
    boxes.set([10, 10, 50, 50], 0);
    // row 1: bad class index
    labels[1] = BigInt(999);
    // row 2: inverted box
    boxes.set([50, 50, 10, 10], 8);
    // row 3: NaN coordinate
    boxes.set([Number.NaN, 10, 50, 50], 12);
    // rows 4+: below threshold
    scores.fill(0.01, 4);

    const { detections, counts } = decodeDFineWithStats(
      {
        labels: { dims: [1, DFINE_QUERIES], data: labels },
        boxes: { dims: [1, DFINE_QUERIES, 4], data: boxes },
        scores: { dims: [1, DFINE_QUERIES], data: scores },
      },
      { threshold: 0.5, labels: LABELS }
    );

    expect(detections).toHaveLength(1);
    expect(counts.badClass).toBe(1);
    expect(counts.degenerate).toBe(1);
    expect(counts.invalid).toBe(1);
    expect(counts.belowThreshold).toBe(DFINE_QUERIES - 4);
    expect(counts.kept).toBe(1);
  });
});

describe('D-FINE decode: letterbox reversal into source-frame pixels', () => {
  it('maps a canvas-space box back into a 1280x720 source frame', () => {
    // 1280x720 into 640 => scale 0.5, padY 140. A box at canvas y 240..300
    // corresponds to source y 200..320.
    const geo = computeLetterbox(1280, 720, 640);
    expect(geo.scale).toBeCloseTo(0.5, 6);
    expect(geo.padY).toBeCloseTo(140, 6);

    const raw = makeOutput([{ score: 0.9, cls: 2, xyxy: [100, 240, 200, 300] }]);
    const [d] = decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS });
    const inFrame = unletterboxBox(d.box, geo, 1280, 720);

    expect(inFrame.x).toBeCloseTo(200, 4);
    expect(inFrame.y).toBeCloseTo(200, 4);
    expect(inFrame.width).toBeCloseTo(200, 4);
    expect(inFrame.height).toBeCloseTo(120, 4);
  });

  it('stays inside the source frame for a box that touches the canvas edge', () => {
    const geo = computeLetterbox(1280, 720, 640);
    const raw = makeOutput([{ score: 0.9, cls: 2, xyxy: [0, 0, 640, 640] }]);
    const [d] = decodeDFineOutput(raw, { threshold: 0.5, labels: LABELS });
    const b = unletterboxBox(d.box, geo, 1280, 720);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1280 + 1e-6);
    expect(b.y + b.height).toBeLessThanOrEqual(720 + 1e-6);
  });
});

describe('D-FINE decode: int64 handling', () => {
  it('accepts BigInt64Array (ORT Web) and plain numbers identically', () => {
    const big = BigInt64Array.from([BigInt(2)]);
    const num = new Float32Array([2]);
    const boxes = { dims: [1, 1, 4] as const, data: new Float32Array([0, 0, 10, 10]) };
    const scores = { dims: [1, 1] as const, data: new Float32Array([0.9]) };

    const a = decodeDFineOutput(
      { labels: { dims: [1, 1], data: big }, boxes, scores },
      { threshold: 0.5, labels: LABELS }
    );
    const b = decodeDFineOutput(
      { labels: { dims: [1, 1], data: num }, boxes, scores },
      { threshold: 0.5, labels: LABELS }
    );

    expect(a[0].classIndex).toBe(2);
    expect(b[0].classIndex).toBe(2);
  });
});

describe('D-FINE decode: letterbox-padding rejection', () => {
  it('drops boxes that live wholly in the padding band', async () => {
    const { filterToContentRegion } = await import('../dfine');
    // 1280x720 into 640 => scale 0.5, padY 140, content 640x360.
    const geo = { padX: 0, padY: 140, contentWidth: 640, contentHeight: 360 };
    const dets = [
      { box: { x: 100, y: 10, width: 60, height: 50 } },   // inside top filler
      { box: { x: 100, y: 560, width: 60, height: 50 } },  // inside bottom filler
      { box: { x: 100, y: 230, width: 60, height: 50 } },  // real content
      { box: { x: 100, y: 120, width: 60, height: 60 } },  // straddles the edge -> kept
    ];
    const { kept, droppedInPadding } = filterToContentRegion(dets, geo);
    expect(droppedInPadding).toBe(2);
    expect(kept).toHaveLength(2);
  });

  it('keeps everything when the frame is already square (no padding)', async () => {
    const { filterToContentRegion } = await import('../dfine');
    const geo = { padX: 0, padY: 0, contentWidth: 640, contentHeight: 640 };
    const dets = [{ box: { x: 1, y: 1, width: 10, height: 10 } }];
    expect(filterToContentRegion(dets, geo).kept).toHaveLength(1);
  });

  it('drops a side-band box for a portrait frame', async () => {
    const { filterToContentRegion } = await import('../dfine');
    // 480x640 into 640 => scale 1, padX 80, content 480x640.
    const geo = { padX: 80, padY: 0, contentWidth: 480, contentHeight: 640 };
    const dets = [{ box: { x: 5, y: 100, width: 40, height: 40 } }];
    expect(filterToContentRegion(dets, geo).droppedInPadding).toBe(1);
  });
});
