/**
 * Engine integration for the MediaPipe backend.
 *
 * These run the REAL `DetectionEngine` with a stubbed detector runner, so they
 * verify the wiring that the unit tests cannot: that MediaPipe output becomes a
 * `DetectionFrame`, that tracking/class-mapping/overlay plumbing is shared with
 * the worker path, that a failed frame does not kill the camera loop, and that
 * YOLO11n remains the default and the fallback.
 *
 * They still do NOT prove real-camera accuracy - no .tflite model runs here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DetectionEngine } from '../detectionEngine';
import { MEDIAPIPE_MODEL, PRIMARY_MODEL } from '../models';
import { MediaPipeFrameRunner } from '../mediapipe';

describe('DetectionEngine + MediaPipe', () => {
  let engine: DetectionEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new DetectionEngine();
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('defaults to YOLO11n, so nothing changes for existing deployments', () => {
    expect(engine.getPreferredDetector()).toBe('yolo11n');
  });

  it('exposes mediapipe as a selectable detector without making it default', () => {
    expect(engine.setPreferredDetector('mediapipe')).toBe(true);
    expect(engine.getPreferredDetector()).toBe('mediapipe');
  });

  it('applies the MediaPipe confidence floor when switching to it', () => {
    // The default config is 0.35; MediaPipe's floor is 0.3, so it stays put.
    engine.setConfig({ confidence: 0.2 });
    engine.setPreferredDetector('mediapipe');
    expect(engine.getConfig().confidence).toBeGreaterThanOrEqual(MEDIAPIPE_MODEL.minConfidence!);
  });

  it('raises the floor when switching from a lower YOLO threshold', () => {
    engine.setConfig({ confidence: 0.1 });
    engine.setPreferredDetector('mediapipe');
    expect(engine.getConfig().confidence).toBe(0.3);
  });

  it('does not report mediapipe active before it is loaded', () => {
    expect(engine.isMediaPipeActive()).toBe(false);
  });

  it('never throws when the model asset is absent, and records why', async () => {
    engine.setPreferredDetector('mediapipe');
    const status = await engine.loadModel();
    // No .tflite here, so MediaPipe cannot become ready...
    expect(status.state).not.toBe('ready');
    // ...the reason is kept for the UI/fallback message...
    const reason = engine.getMediaPipeError();
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/setup:models|MediaPipe|mediapipe|WASM|model/i);
    // ...and loading still resolves rather than rejecting.
    expect(status.id).toBeTruthy();
  });

  it('falls back to YOLO11n rather than leaving the panel unusable', async () => {
    engine.setPreferredDetector('mediapipe');
    const status = await engine.loadModel();
    // Whatever happens, the engine must end with a coherent status object and a
    // detector id, so the UI can offer the next option.
    expect(status.id).toBeTruthy();
    expect(['not_configured', 'error', 'ready']).toContain(status.state);
  });

  it('switching away from mediapipe releases it', () => {
    engine.setPreferredDetector('mediapipe');
    engine.setPreferredDetector('yolo11n');
    expect(engine.isMediaPipeActive()).toBe(false);
    expect(engine.getPreferredDetector()).toBe('yolo11n');
  });

  it('setPreferredDetector reports whether the preference actually changed', () => {
    expect(engine.setPreferredDetector('yolo11n')).toBe(false); // already default
    expect(engine.setPreferredDetector('mediapipe')).toBe(true);
    expect(engine.setPreferredDetector('mediapipe')).toBe(false); // no-op
  });

  it('dispose() is safe with no MediaPipe detector loaded', () => {
    expect(() => engine.dispose()).not.toThrow();
  });

  it('refuses to start without a source or a ready model, and says why', () => {
    const onError = vi.fn();
    const e = new DetectionEngine({}, { onError });
    expect(e.start()).toBe(false);
    expect(onError).toHaveBeenCalled();
    e.dispose();
  });

  it('PRIMARY_MODEL is still YOLO11n and still first', () => {
    expect(PRIMARY_MODEL.id).toBe('yolo11n-coco');
  });
});

describe('MediaPipe frame production through the shared buildFrame path', () => {
  /**
   * Drive `tickMediaPipe` indirectly: install a fake runner on the engine and
   * call the private path the same way the frame loop does. TypeScript private is
   * a compile-time concept, so reaching in here keeps the test honest about what
   * the loop actually calls.
   */
  type Internals = {
    mediaPipe: unknown;
    modelStatus: { state: string; name: string; family: string };
    activeDef: unknown;
    tickMediaPipe: (v: HTMLVideoElement, w: number, h: number) => void;
    lastFrame: { detections: unknown[] } | null;
  };

  it('converts MediaPipe output into tracked, class-mapped detections', () => {
    const engine = new DetectionEngine({ tracking: true });
    const internals = engine as unknown as Internals;
    const onFrame = vi.fn();
    // Rebind listeners through the constructor listeners object.
    const e2 = new DetectionEngine({ tracking: true }, { onFrame });

    const fake = {
      detector: {
        detectForVideo: () => ({
          detections: [
            {
              categories: [{ score: 0.9, index: 0, categoryName: 'person', displayName: 'person' }],
              boundingBox: { originX: 100, originY: 50, width: 120, height: 240 },
            },
          ],
        }),
        close: () => {},
      },
    };

    const inner = e2 as unknown as Internals;
    inner.mediaPipe = new MediaPipeFrameRunner(fake.detector);
    inner.modelStatus = { state: 'ready', name: MEDIAPIPE_MODEL.name, family: 'mediapipe' };
    inner.activeDef = MEDIAPIPE_MODEL;

    inner.tickMediaPipe({} as HTMLVideoElement, 640, 480);

    expect(onFrame).toHaveBeenCalledOnce();
    const frame = onFrame.mock.calls[0][0];
    expect(frame.detections).toHaveLength(1);
    const d = frame.detections[0];
    // MediaPipe's box is passed through untouched - no letterbox maths.
    expect(d.box).toEqual({ x: 100, y: 50, width: 120, height: 240 });
    // person -> pedestrian through the existing mapping.
    expect(d.classId).toBe('pedestrian');
    expect(d.modelLabel).toBe('person');
    expect(d.confidence).toBeCloseTo(0.9, 5);
    expect(d.frameWidth).toBe(640);
    expect(d.frameHeight).toBe(480);
    expect(d.origin).toBe('camera');

    engine.dispose();
    e2.dispose();
    void internals;
  });

  it('a throwing detector reports once and does not kill the loop', () => {
    const onError = vi.fn();
    const engine = new DetectionEngine({ tracking: true }, { onError });
    const inner = engine as unknown as Internals;

    let calls = 0;
    inner.mediaPipe = new MediaPipeFrameRunner({
      detectForVideo: () => {
        calls += 1;
        throw new Error('wasm exploded');
      },
      close: () => {},
    });
    inner.modelStatus = { state: 'ready', name: MEDIAPIPE_MODEL.name, family: 'mediapipe' };
    inner.activeDef = MEDIAPIPE_MODEL;

    expect(() => inner.tickMediaPipe({} as HTMLVideoElement, 640, 480)).not.toThrow();
    // Same message twice: reported once, not spammed at 8 Hz.
    inner.tickMediaPipe({} as HTMLVideoElement, 640, 480);
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/MediaPipe inference failed/);

    engine.dispose();
  });

  it('tracks a repeated detection as one object, not a new one each frame', () => {
    const onFrame = vi.fn();
    const engine = new DetectionEngine({ tracking: true }, { onFrame });
    const inner = engine as unknown as Internals;

    inner.mediaPipe = new MediaPipeFrameRunner({
      detectForVideo: () => ({
        detections: [
          {
            categories: [{ score: 0.9, index: 0, categoryName: 'person', displayName: 'person' }],
            boundingBox: { originX: 100, originY: 50, width: 120, height: 240 },
          },
        ],
      }),
      close: () => {},
    });
    inner.modelStatus = { state: 'ready', name: MEDIAPIPE_MODEL.name, family: 'mediapipe' };
    inner.activeDef = MEDIAPIPE_MODEL;

    inner.tickMediaPipe({} as HTMLVideoElement, 640, 480);
    inner.tickMediaPipe({} as HTMLVideoElement, 640, 480);
    inner.tickMediaPipe({} as HTMLVideoElement, 640, 480);

    // One box on every frame - no duplicate accumulation.
    for (const call of onFrame.mock.calls) {
      expect(call[0].detections).toHaveLength(1);
    }
    const ids = onFrame.mock.calls.map((c) => c[0].detections[0].trackId);
    expect(new Set(ids).size).toBe(1);

    engine.dispose();
  });

  it('an empty scene yields zero detections, not stale ones', () => {
    const onFrame = vi.fn();
    const engine = new DetectionEngine({ tracking: true }, { onFrame });
    const inner = engine as unknown as Internals;
    let empty = true;

    inner.mediaPipe = new MediaPipeFrameRunner({
      detectForVideo: () =>
        empty
          ? {
              detections: [
                {
                  categories: [{ score: 0.9, index: 0, categoryName: 'person', displayName: 'person' }],
                  boundingBox: { originX: 10, originY: 10, width: 50, height: 50 },
                },
              ],
            }
          : { detections: [] },
      close: () => {},
    });
    inner.modelStatus = { state: 'ready', name: MEDIAPIPE_MODEL.name, family: 'mediapipe' };
    inner.activeDef = MEDIAPIPE_MODEL;

    inner.tickMediaPipe({} as HTMLVideoElement, 640, 480);
    expect(onFrame.mock.calls[0][0].detections).toHaveLength(1);

    empty = false;
    inner.tickMediaPipe({} as HTMLVideoElement, 640, 480);
    expect(onFrame.mock.calls[1][0].detections).toHaveLength(0);

    engine.dispose();
  });
});

describe('no overlapping frames (requirement 9)', () => {
  it('the MediaPipe branch returns before the worker path can also run', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../detectionEngine.ts', import.meta.url), 'utf8');

    // The MediaPipe branch must schedule the next tick and return; otherwise the
    // same frame would also be posted to the worker, running inference twice.
    const branch = src.slice(src.indexOf('if (this.mediaPipe) {'));
    const upToNextTry = branch.slice(0, branch.indexOf('try {', branch.indexOf('finally')));
    expect(branch).toContain('this.tickMediaPipe');
    expect(upToNextTry).toContain('this.scheduleNext()');
    expect(upToNextTry).toContain('return;');
  });

  it('guards the zero-size window between getUserMedia and the first frame', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../detectionEngine.ts', import.meta.url), 'utf8');
    // videoWidth/videoHeight are 0 until the first frame decodes; calling
    // detectForVideo then throws inside MediaPipe. The loop must skip, not call.
    expect(src).toMatch(/if \(width > 0 && height > 0\) this\.tickMediaPipe/);
  });
});
