/**
 * MediaPipe adapter tests.
 *
 * SCOPE, stated plainly: these exercise the conversion and error-handling code
 * against synthetic `DetectionResult` objects. They do NOT run the EfficientDet
 * model, and they do NOT prove bounding-box accuracy on a real camera - that
 * needs a browser with the .tflite asset, which is not available in CI or in the
 * environment this was written in. See `tools/dfine-audit/BROWSER-PATH-FINDINGS.md`
 * for what remains unverified.
 *
 * What they do guarantee is that everything between MediaPipe's output and the
 * overlay is correct and cannot silently misbehave.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MediaPipeFrameRunner,
  MediaPipeUnavailableError,
  MEDIAPIPE_MAX_RESULTS,
  MEDIAPIPE_SCORE_THRESHOLD,
  createMediaPipeDetector,
  toMediaPipeRawDetections,
  type MediaPipeResult,
} from '../mediapipe';
import { COCO_LABELS } from '../detector';
import { MEDIAPIPE_MODEL, ALL_MODELS, type DetectorId } from '../models';

const det = (
  box: { x: number; y: number; w: number; h: number } | undefined,
  score: number,
  index: number,
  name = COCO_LABELS[index] ?? 'unknown'
) => ({
  categories: [{ score, index, categoryName: name, displayName: name }],
  ...(box
    ? { boundingBox: { originX: box.x, originY: box.y, width: box.w, height: box.h } }
    : {}),
});

describe('toMediaPipeRawDetections', () => {
  it('passes boxes through unchanged as source-frame pixels', () => {
    // This is the property that makes the MediaPipe path trustworthy: no
    // letterbox, no scale factor, no clamping. MediaPipe already reports in the
    // video's own pixel space.
    const result: MediaPipeResult = {
      detections: [det({ x: 100, y: 40, w: 120, h: 180 }, 0.91, 0)],
    };
    const { detections } = toMediaPipeRawDetections(result);
    expect(detections).toHaveLength(1);
    expect(detections[0].box).toEqual({ x: 100, y: 40, width: 120, height: 180 });
    expect(detections[0].label).toBe('person');
    expect(detections[0].classIndex).toBe(0);
    expect(detections[0].confidence).toBeCloseTo(0.91, 5);
  });

  it('sorts strongest first so the label budget is spent on the best boxes', () => {
    const result: MediaPipeResult = {
      detections: [
        det({ x: 0, y: 0, w: 10, h: 10 }, 0.35, 2),
        det({ x: 0, y: 0, w: 10, h: 10 }, 0.95, 0),
        det({ x: 0, y: 0, w: 10, h: 10 }, 0.6, 5),
      ],
    };
    const { detections } = toMediaPipeRawDetections(result);
    expect(detections.map((d) => d.confidence)).toEqual([0.95, 0.6, 0.35]);
  });

  it('picks the highest-scoring category when several are reported', () => {
    const result: MediaPipeResult = {
      detections: [
        {
          categories: [
            { score: 0.4, index: 2, categoryName: 'car', displayName: 'car' },
            { score: 0.8, index: 5, categoryName: 'bus', displayName: 'bus' },
          ],
          boundingBox: { originX: 1, originY: 2, width: 3, height: 4 },
        },
      ],
    };
    const { detections } = toMediaPipeRawDetections(result);
    expect(detections[0].label).toBe('bus');
    expect(detections[0].classIndex).toBe(5);
  });

  it('drops a detection with no bounding box instead of guessing one', () => {
    const result: MediaPipeResult = { detections: [det(undefined, 0.9, 0)] };
    const { detections, dropped } = toMediaPipeRawDetections(result);
    expect(detections).toHaveLength(0);
    expect(dropped.noBox).toBe(1);
  });

  it('drops degenerate and non-finite boxes', () => {
    const result: MediaPipeResult = {
      detections: [
        det({ x: 10, y: 10, w: 0, h: 50 }, 0.9, 0), // zero width
        det({ x: 10, y: 10, w: 50, h: -5 }, 0.9, 0), // negative height
        det({ x: NaN, y: 10, w: 50, h: 50 }, 0.9, 0), // non-finite
        det({ x: 10, y: 10, w: 50, h: 50 }, 0.9, 0), // valid
      ],
    };
    const { detections, dropped } = toMediaPipeRawDetections(result);
    expect(detections).toHaveLength(1);
    expect(dropped.degenerate).toBe(3);
  });

  it('drops a class index outside the label table rather than mislabelling it', () => {
    const result: MediaPipeResult = {
      detections: [det({ x: 0, y: 0, w: 10, h: 10 }, 0.9, 900)],
    };
    const { detections, dropped } = toMediaPipeRawDetections(result);
    expect(detections).toHaveLength(0);
    expect(dropped.badClass).toBe(1);
  });

  it('handles an empty scene without inventing detections', () => {
    const { detections, dropped } = toMediaPipeRawDetections({ detections: [] });
    expect(detections).toHaveLength(0);
    expect(dropped).toEqual({ noBox: 0, degenerate: 0, badClass: 0 });
  });

  it('tolerates a missing detections array', () => {
    expect(toMediaPipeRawDetections({} as MediaPipeResult).detections).toHaveLength(0);
  });

  it('accepts a custom label table', () => {
    const result: MediaPipeResult = { detections: [det({ x: 0, y: 0, w: 5, h: 5 }, 0.9, 1, 'car')] };
    const { detections } = toMediaPipeRawDetections(result, ['pedestrian', 'car']);
    expect(detections[0].classIndex).toBe(1);
  });
});

describe('MediaPipeFrameRunner timestamps', () => {
  const stub = () => {
    const seen: number[] = [];
    const detector = {
      detectForVideo: (_v: HTMLVideoElement, ts: number) => {
        seen.push(ts);
        return { detections: [] };
      },
      close: vi.fn(),
    };
    return { detector, seen, runner: new MediaPipeFrameRunner(detector) };
  };
  const video = {} as HTMLVideoElement;

  it('forwards an advancing timestamp', () => {
    const { runner, seen } = stub();
    runner.detect(video, 1000);
    runner.detect(video, 1250);
    expect(seen).toEqual([1000, 1250]);
  });

  it('forces strictly increasing values when the clock stalls', () => {
    // Two frames in the same millisecond would make detectForVideo throw.
    const { runner, seen } = stub();
    runner.detect(video, 5000);
    runner.detect(video, 5000);
    runner.detect(video, 5000);
    expect(seen).toEqual([5000, 5001, 5002]);
    expect(new Set(seen).size).toBe(3);
  });

  it('recovers if the clock jumps backwards', () => {
    const { runner, seen } = stub();
    runner.detect(video, 9000);
    runner.detect(video, 4000); // system clock correction
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  it('closes the detector and stays closed-safe', () => {
    const { detector, runner } = stub();
    runner.close();
    expect(detector.close).toHaveBeenCalledOnce();
    // A second close must not throw.
    expect(() => runner.close()).not.toThrow();
  });

  it('survives a detector whose close() throws', () => {
    const detector = {
      detectForVideo: () => ({ detections: [] }),
      close: () => {
        throw new Error('already disposed');
      },
    };
    expect(() => new MediaPipeFrameRunner(detector).close()).not.toThrow();
  });
});

describe('createMediaPipeDetector error handling', () => {
  it('raises a typed error (not a crash) when the WASM runtime is missing', async () => {
    await expect(
      createMediaPipeDetector({
        wasmBasePath: '/definitely/not/here',
        modelAssetPath: 'models/efficientdet_lite0.tflite',
        delegate: 'CPU',
      })
    ).rejects.toBeInstanceOf(MediaPipeUnavailableError);
  });

  it('the error explains how to install the assets', async () => {
    try {
      await createMediaPipeDetector({
        wasmBasePath: '/definitely/not/here',
        modelAssetPath: 'models/efficientdet_lite0.tflite',
        delegate: 'CPU',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as MediaPipeUnavailableError).detail).toMatch(/setup:models/);
    }
  });
});

describe('MEDIAPIPE_MODEL definition', () => {
  it('is registered but is not the default detector', () => {
    expect(ALL_MODELS).toContain(MEDIAPIPE_MODEL);
    // YOLO11n must stay first: it is the default and the fallback.
    expect(ALL_MODELS[0].id).toBe('yolo11n-coco');
  });

  it('declares the mediapipe backend and a .tflite asset', () => {
    expect(MEDIAPIPE_MODEL.backend).toBe('mediapipe');
    expect(MEDIAPIPE_MODEL.url).toMatch(/\.tflite$/);
  });

  it('uses the same 80-class COCO table as the other detectors', () => {
    expect(MEDIAPIPE_MODEL.labels).toHaveLength(80);
    expect(MEDIAPIPE_MODEL.labels[0]).toBe('person');
    expect(MEDIAPIPE_MODEL.labels).toEqual(COCO_LABELS);
  });

  it('threshold matches the module constants', () => {
    expect(MEDIAPIPE_MODEL.minConfidence).toBe(MEDIAPIPE_SCORE_THRESHOLD);
    expect(MEDIAPIPE_SCORE_THRESHOLD).toBe(0.3);
    expect(MEDIAPIPE_MAX_RESULTS).toBe(8);
  });

  it('the DetectorId union covers all three selectable detectors', () => {
    const ids: DetectorId[] = ['yolo11n', 'dfine-n', 'mediapipe'];
    expect(ids).toHaveLength(3);
  });
});
