import { describe, expect, it } from 'vitest';
import { emptyDetectionStats, formatDiagnostic, type DetectionDiagnostic } from '../diagnostics';

function makeDiagnostic(over: Partial<DetectionDiagnostic> = {}): DetectionDiagnostic {
  return {
    detector: 'dfine',
    rawShapes: { labels: [1, 300], boxes: [1, 300, 4], scores: [1, 300] },
    counts: {
      ...emptyDetectionStats(0.5),
      raw: 300,
      kept: 2,
      belowThreshold: 298,
      scoreMin: 0.01,
      scoreMax: 0.93,
      keptScoreMin: 0.71,
      keptScoreMax: 0.93,
    },
    boxes: [
      { label: 'car', confidence: 0.93, box: { x: 100, y: 120, width: 120, height: 180 } },
    ],
    frame: { width: 1280, height: 720 },
    ...over,
  };
}

describe('detection diagnostics', () => {
  it('reports raw vs kept counts, threshold drops and score ranges', () => {
    const line = formatDiagnostic(makeDiagnostic());

    expect(line).toContain('raw=300');
    expect(line).toContain('kept=2');
    expect(line).toContain('thr<=0.5:298');
    expect(line).toContain('score=0.01..0.93');
    expect(line).toContain('keptScore=0.71..0.93');
  });

  it('includes the frame size so a scaling mistake is visible', () => {
    expect(formatDiagnostic(makeDiagnostic())).toContain('frame=1280x720');
  });

  it('includes final box coordinates for the strongest detections', () => {
    const line = formatDiagnostic(makeDiagnostic());
    expect(line).toContain('top=car@0.93(100,120,120x180)');
  });

  it('reports the raw tensor shapes, so a changed export is obvious', () => {
    const line = formatDiagnostic(makeDiagnostic());
    expect(line).toContain('boxes[1,300,4]');
    expect(line).toContain('scores[1,300]');
  });

  it('says "none" rather than printing a bogus range when nothing was kept', () => {
    const d = makeDiagnostic({
      counts: { ...emptyDetectionStats(0.5), raw: 300, kept: 0, belowThreshold: 300 },
      boxes: [],
    });
    const line = formatDiagnostic(d);
    expect(line).toContain('kept=0');
    expect(line).toContain('keptScore=none');
    expect(line).not.toContain('top=');
  });

  it('names the detector so YOLO and D-FINE lines are distinguishable', () => {
    expect(formatDiagnostic(makeDiagnostic({ detector: 'yolo' }))).toContain('[bharat-av][yolo]');
    expect(formatDiagnostic(makeDiagnostic({ detector: 'dfine' }))).toContain('[bharat-av][dfine]');
  });
});
