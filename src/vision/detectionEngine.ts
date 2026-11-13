/**
 * DetectionEngine — one instance per camera source.
 *
 * Responsibilities:
 *   - own the Web Worker (never block the UI or the simulation loop)
 *   - pull frames from the camera at a configurable inference rate
 *   - drop frames when the worker is still busy (back-pressure)
 *   - run IoU tracking, distance/risk estimation and class mapping
 *   - expose immutable snapshots of detections + statistics
 *
 * The engine is deliberately free of React so it can be unit-tested and so the
 * render loop can consume it at whatever rate it likes.
 */
import type { FrameSource } from '../camera/types';
import { IouTracker, type Track } from './tracker';
import { detectionDebugEnabled } from './diagnostics';
import { mapLabelToVisionClass, COCO_LABELS } from './detector';
import { assessImageRisk, estimateDistance, type CameraCalibration } from './distance';
import type {
  BoundingBox,
  CameraDetection,
  CameraSourceKind,
  DetectionConfig,
  DetectionFrame,
  DetectionStats,
  ModelStatus,
  VisionClassId,
} from './types';
import type { WorkerRequest, WorkerResponse } from './detector.worker';
import {
  classSupportFor,
  type ModelDefinition,
  DFINE_MODEL,
  PRIMARY_MODEL,
  resolveModelCandidates,
  FALLBACK_MODEL,
} from './models';

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  confidence: 0.35,
  inferenceHz: 8,
  nmsIou: 0.45,
  maxDetections: 40,
  tracking: true,
};

export interface DetectionEngineListeners {
  onFrame?: (frame: DetectionFrame) => void;
  onStatus?: (status: DetectionStats) => void;
  onModelStatus?: (status: ModelStatus) => void;
  onError?: (message: string) => void;
}

interface PendingRequest {
  requestId: number;
  timestamp: number;
}

const PRE = 'bharat-av';

function emptyStats(): DetectionStats {
  return {
    inferenceFps: 0,
    captureFps: 0,
    lastInferenceMs: 0,
    avgInferenceMs: 0,
    p95InferenceMs: 0,
    framesCaptured: 0,
    framesInferred: 0,
    framesSkipped: 0,
    detectionCount: 0,
    frameWidth: 0,
    frameHeight: 0,
  };
}

export class DetectionEngine {
  private worker: Worker | null = null;
  private tracker = new IouTracker({ maxTracks: DEFAULT_DETECTION_CONFIG.maxDetections });
  private detectionConfig: DetectionConfig;
  private listeners: DetectionEngineListeners;
  private calibration: CameraCalibration | null = null;
  private source: FrameSource | null = null;

  private running = false;
  private loopHandle: number | null = null;
  private requestId = 1;
  private pending: PendingRequest | null = null;
  private modelLoadedFor: { backend: string; url: string } | null = null;
  private modelStatus: ModelStatus;

  private stats: DetectionStats = emptyStats();
  private inferenceTimestamps: number[] = [];
  private captureTimestamps: number[] = [];
  private attemptTimestamps: number[] = [];
  private latencySamples: number[] = [];
  private lastFrame: DetectionFrame | null = null;
  private lastTracks: Track[] = [];
  private backend: 'onnxruntime-web' | 'tfjs' = 'onnxruntime-web';
  private preferredDetector: 'yolo11n' | 'dfine-n' = 'yolo11n';
  private activeDef: ModelDefinition | null = null;
  private lastDFineError: string | null = null;
  /** Number of consecutive ONNX initialisation failures before fallback. */
  private static onnxBlocked = false;

  constructor(config: Partial<DetectionConfig> = {}, listeners: DetectionEngineListeners = {}) {
    this.detectionConfig = { ...DEFAULT_DETECTION_CONFIG, ...config };
    this.listeners = listeners;
    this.modelStatus = {
      id: PRIMARY_MODEL.id,
      name: PRIMARY_MODEL.name,
      family: PRIMARY_MODEL.family,
      url: PRIMARY_MODEL.url,
      state: 'not_configured',
      message: 'Model not loaded yet',
      inputSize: PRIMARY_MODEL.inputSize,
      classCount: PRIMARY_MODEL.labels.length,
      classSupport: classSupportFor(PRIMARY_MODEL, false, 'not_configured'),
    };
  }

  getModelStatus(): ModelStatus {
    return this.modelStatus;
  }

  getStats(): DetectionStats {
    return { ...this.stats };
  }

  getLastFrame(): DetectionFrame | null {
    return this.lastFrame;
  }

  getBackend(): 'onnxruntime-web' | 'tfjs' {
    return this.backend;
  }

  /** Which model definition is in use (primary or fallback). */
  getModelDefinition(): ModelDefinition {
    if (this.activeDef) return this.activeDef;
    return this.backend === 'tfjs' ? FALLBACK_MODEL : PRIMARY_MODEL;
  }

  /**
   * Which optional detector to prefer on the ONNX path.
   *
   * 'yolo11n' (default) leaves existing behaviour completely untouched.
   * 'dfine-n'  opts in to the D-FINE graph; if it fails to load, loadModel()
   *            still falls back exactly as before, so this is never a one-way
   *            door.
   */
  getPreferredDetector(): 'yolo11n' | 'dfine-n' {
    return this.preferredDetector;
  }

  /**
   * Choose the preferred detector.
   *
   * Switching does NOT hot-swap an already-loaded graph by itself: the caller
   * must call loadModel() afterwards, which is what the UI does. The loaded
   * model stays YOLO11n until then, so `activeDef` and `modelStatus` continue to
   * describe reality instead of advertising a detector that is not running.
   * Returns true when the preference actually changed.
   */
  setPreferredDetector(next: 'yolo11n' | 'dfine-n'): boolean {
    const changed = this.preferredDetector !== next;
    this.preferredDetector = next;
    if (changed) this.lastDFineError = null;
    /*
     * Apply the chosen family's confidence floor.
     *
     * A 300-query DETR graph needs a stricter operating point than a YOLO export
     * (which already suppresses hard by NMS), so switching to D-FINE raises the
     * threshold to its documented floor instead of silently reusing YOLO's.
     * Raising is one-way on purpose: lowering it automatically would undo a
     * deliberately stricter choice, and the operator can still set any value in
     * the panel afterwards.
     */
    const floor = (next === 'dfine-n' ? DFINE_MODEL : PRIMARY_MODEL).minConfidence;
    if (floor !== undefined && this.detectionConfig.confidence < floor) {
      this.detectionConfig = { ...this.detectionConfig, confidence: floor };
    }
    return changed;
  }

  getConfig(): DetectionConfig {
    return { ...this.detectionConfig };
  }

  setConfig(patch: Partial<DetectionConfig>): void {
    this.detectionConfig = { ...this.detectionConfig, ...patch };
    if (this.running) this.scheduleNext();
  }

  setCalibration(calibration: CameraCalibration | null): void {
    this.calibration = calibration;
  }

  getCalibration(): CameraCalibration | null {
    return this.calibration;
  }

  setSource(source: FrameSource | null): void {
    this.source = source;
    if (!source) {
      this.stats = emptyStats();
      this.lastFrame = null;
      this.lastTracks = [];
      this.tracker.reset();
    }
  }

  /** Edge length of the loaded model's square input (640 for YOLO, 416 for NanoDet). */
  private inputSize = 640;
  private watchdog: number | null = null;
  private sourceStalled = false;

  private emitModelStatus(patch: Partial<ModelStatus>) {
    this.modelStatus = { ...this.modelStatus, ...patch };
    this.listeners.onModelStatus?.(this.modelStatus);
  }

  /**
   * Load the detector model into the worker.
   * Returns the resulting status; never throws for a missing model file.
   */
  async loadModel(backendOverride?: 'onnxruntime-web' | 'tfjs'): Promise<ModelStatus> {
    const preferred: 'onnxruntime-web' | 'tfjs' =
      backendOverride ?? (DetectionEngine.onnxBlocked ? 'tfjs' : 'onnxruntime-web');

    // Opt-in D-FINE attempt. Any failure falls through to the existing
    // YOLO11n -> NanoDet chain below, so the default path is unchanged when the
    // preference is 'yolo11n' (the default) or the asset is absent.
    if (preferred === 'onnxruntime-web' && this.preferredDetector === 'dfine-n') {
      const dfine = await this.loadModelWith('onnxruntime-web', DFINE_MODEL);
      if (dfine.state === 'ready') return dfine;
      // Keep the D-FINE reason but continue to the normal chain.
      this.lastDFineError = dfine.message ?? 'D-FINE model unavailable';
    }

    const first = await this.loadModelWith(preferred);
    if (first.state === 'ready' || backendOverride) return first;

    // Primary backend unavailable (missing weights OR wasm blocked):
    // fall back to the TF.js detector and say so explicitly.
    const fallback = await this.loadModelWith(preferred === 'tfjs' ? 'onnxruntime-web' : 'tfjs');
    if (fallback.state === 'ready') {
      const dfineNote = this.lastDFineError ? ` [D-FINE: ${this.lastDFineError}]` : '';
      fallback.message = `${fallback.name} (fallback) — ${first.message ?? 'primary detector unavailable'}${dfineNote}`;
      this.listeners.onModelStatus?.(fallback);
      return fallback;
    }
    return first;
  }

  /** Load a specific model definition (used for the optional pothole model). */
  async loadModelWith(
    backend: 'onnxruntime-web' | 'tfjs',
    customDef?: ModelDefinition,
    labelsOverride?: string[],
    modelBytes?: Uint8Array
  ): Promise<ModelStatus> {
    const def = customDef ?? (backend === 'tfjs' ? FALLBACK_MODEL : PRIMARY_MODEL);
    this.backend = backend;
    this.activeDef = def;

    this.emitModelStatus({
      id: def.id,
      name: def.name,
      family: def.family,
      url: def.url,
      state: 'loading',
      message: `Loading ${def.name}…`,
      inputSize: def.inputSize,
      classCount: def.labels.length,
      classSupport: classSupportFor(def, false, 'loading'),
    });

    this.ensureWorker();
    const worker = this.worker;
    if (!worker) {
      this.emitModelStatus({
        state: 'error',
        message: 'Detection worker could not be created in this browser.',
        classSupport: classSupportFor(def, false, 'error', 'worker unavailable'),
      });
      return this.modelStatus;
    }

    const requestId = this.requestId++;
    const candidates = resolveModelCandidates(def);
    const payload: WorkerRequest = {
      type: 'load',
      requestId,
      backend,
      modelUrl: candidates[0],
      candidates,
      inputSize: def.inputSize,
      labels: labelsOverride ?? [...def.labels],
      modelId: def.id,
    };

    return new Promise<ModelStatus>((resolve) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        this.emitModelStatus({
          state: 'error',
          message: 'Model load timed out after 30 s.',
          classSupport: classSupportFor(def, false, 'error', 'load timeout'),
        });
        resolve(this.modelStatus);
      }, 30_000);

      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.requestId !== requestId) return;
        if (msg.type === 'loaded') {
          cleanup();
          this.inputSize = msg.inputSize;
          this.modelLoadedFor = { backend, url: msg.resolvedUrl };
          this.emitModelStatus({
            state: 'ready',
            message: `${def.name} ready (${msg.executionProvider})`,
            loadMs: Math.round(msg.loadMs),
            executionProvider: msg.executionProvider,
            bytes: msg.bytes,
            url: msg.resolvedUrl,
            classSupport: classSupportFor(def, true, 'ready'),
          });
          resolve(this.modelStatus);
        } else if (msg.type === 'error') {
          cleanup();
          const isWasmBlocked = /wasm|initialis|WebAssembly|error code/i.test(msg.message);
          if (isWasmBlocked && this.backend === 'onnxruntime-web') {
            DetectionEngine.onnxBlocked = true;
          }
          this.emitModelStatus({
            state: 'not_configured',
            message: msg.message,
            url: def.url,
            classSupport: classSupportFor(def, false, 'not_configured', msg.message),
          });
          resolve(this.modelStatus);
        }
      };

      const cleanup = () => {
        window.clearTimeout(timeout);
        worker.removeEventListener('message', onMessage);
      };

      worker.addEventListener('message', onMessage);
      // Forward the raw bytes so a user-supplied model never needs to be
      // re-fetched from a URL the browser may not have.
      worker.postMessage(payload, modelBytes ? [modelBytes.buffer] : []);
    });
  }

  /** True when ONNX was found unusable in this environment. */
  static isOnnxBlocked(): boolean {
    return DetectionEngine.onnxBlocked;
  }

  private ensureWorker() {
    if (this.worker) return;
    try {
      this.worker = new Worker(new URL('./detector.worker.ts', import.meta.url), {
        type: 'module',
        name: `${PRE}-detector`,
      });
      this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
        this.handleWorkerMessage(event.data);
      });
      this.worker.addEventListener('error', (event) => {
        this.listeners.onError?.(`Detection worker error: ${event.message}`);
      });
    } catch (err) {
      this.listeners.onError?.(
        `Could not start the detection worker: ${err instanceof Error ? err.message : String(err)}`
      );
      this.worker = null;
    }
  }

  start(): boolean {
    if (this.running) return true;
    if (!this.source || !this.source.video) {
      this.listeners.onError?.('No live camera to analyse.');
      return false;
    }
    if (this.modelStatus.state !== 'ready') {
      this.listeners.onError?.('Detection model is not ready.');
      return false;
    }
    this.running = true;
    this.scheduleNext();
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.loopHandle !== null) {
      window.clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
    this.lastTracks = [];
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Is the current source actually delivering frames?
   *
   * A WebRTC `<video>` keeps its element after the phone disconnects: the track
   * ends but `srcObject` and the last decoded frame remain, so `videoWidth` is
   * non-zero forever. Inferring from that would keep scoring a frozen picture and
   * reporting "detections" of a still image. We therefore treat an ended track as
   * not live (and resume automatically when a reconnect brings a live track).
   */
  private sourceIsDelivering(): boolean {
    const video = this.source?.video;
    if (!video) return false;
    if (video.ended || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
    const stream = video.srcObject as MediaStream | null;
    if (stream && typeof stream.getVideoTracks === 'function') {
      const tracks = stream.getVideoTracks();
      if (tracks.length === 0) return false;
      if (!tracks.some((t) => t.readyState === 'live')) return false;
    }
    return true;
  }

  /**
   * Draw the current video frame into a square, aspect-preserving letterbox and
   * return raw RGB bytes. Doing this on the main thread uses the hardware 2D
   * canvas path and keeps the worker free of OffscreenCanvas readback.
   */
  private grabLetterboxedFrame(
    video: HTMLVideoElement,
    width: number,
    height: number,
    inputSize: number
  ): {
    pixels: Uint8Array;
    buffer: ArrayBuffer;
    geometry: { inputSize: number; scale: number; padX: number; padY: number };
  } {
    if (!this.scratchCanvas || this.scratchCanvas.width !== inputSize) {
      this.scratchCanvas = document.createElement('canvas');
      this.scratchCanvas.width = inputSize;
      this.scratchCanvas.height = inputSize;
      this.scratchCtx = this.scratchCanvas.getContext('2d', { alpha: false, willReadFrequently: false });
    }
    const ctx = this.scratchCtx;
    if (!ctx) throw new Error('2D canvas context unavailable for frame capture');
    const scale = Math.min(inputSize / width, inputSize / height);
    const contentWidth = width * scale;
    const contentHeight = height * scale;
    const padX = (inputSize - contentWidth) / 2;
    const padY = (inputSize - contentHeight) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, inputSize, inputSize);
    ctx.drawImage(video, padX, padY, contentWidth, contentHeight);
    const { data } = ctx.getImageData(0, 0, inputSize, inputSize);
    const pixels = new Uint8Array(inputSize * inputSize * 3);
    for (let i = 0, p = 0; i < pixels.length; i += 3, p += 4) {
      pixels[i] = data[p];
      pixels[i + 1] = data[p + 1];
      pixels[i + 2] = data[p + 2];
    }
    return {
      pixels,
      buffer: pixels.buffer as ArrayBuffer,
      geometry: { inputSize, scale, padX, padY },
    };
  }

  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;

  /**
   * If a worker request never answers (e.g. the runtime stalls on an unusual
   * device) we drop the request instead of hanging detection forever.
   */
  private armWatchdog(requestId: number) {
    this.clearWatchdog();
    this.watchdog = window.setTimeout(() => {
      if (this.pending?.requestId === requestId) {
        this.pending = null;
        this.stats.framesSkipped += 1;
        this.listeners.onError?.(
          'Detector stopped responding (no result within 20 s). Detection was paused — press Start detection to retry.'
        );
        this.stop();
      }
      this.watchdog = null;
    }, 20_000);
  }

  private clearWatchdog() {
    if (this.watchdog !== null) {
      window.clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private scheduleNext() {
    if (this.loopHandle !== null) {
      window.clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }
    if (!this.running) return;
    const hz = this.detectionConfig.inferenceHz > 0 ? this.detectionConfig.inferenceHz : 30;
    const delay = Math.max(16, Math.round(1000 / hz));
    this.loopHandle = window.setTimeout(() => void this.tick(), delay);
  }

  private async tick() {
    if (!this.running) return;
    const source = this.source;
    const worker = this.worker;
    if (!source?.video || !worker) {
      this.scheduleNext();
      return;
    }
    if (this.pending) {
      // Worker still busy → skip this frame instead of queueing (back-pressure).
      this.stats.framesSkipped += 1;
      this.attemptTimestamps.push(Date.now());
      this.trimWindow(this.attemptTimestamps);
      this.scheduleNext();
      return;
    }
    if (!this.sourceIsDelivering()) {
      // Source stalled (phone disconnected): pause scoring, keep the loop alive
      // so a reconnect resumes without the user pressing Start again.
      if (!this.sourceStalled) {
        this.sourceStalled = true;
        this.listeners.onError?.('Camera stream stopped — detection paused until it resumes.');
      }
      this.scheduleNext();
      return;
    }
    if (this.sourceStalled) this.sourceStalled = false;

    const video = source.video;
    const width = video.videoWidth;
    const height = video.videoHeight;

    try {
      const { buffer, geometry } = this.grabLetterboxedFrame(video, width, height, this.inputSize);
      const timestamp = Date.now();
      this.stats.framesCaptured += 1;
      this.stats.frameWidth = width;
      this.stats.frameHeight = height;
      this.captureTimestamps.push(timestamp);
      this.trimWindow(this.captureTimestamps);

      const requestId = this.requestId++;
      this.pending = { requestId, timestamp };
      this.armWatchdog(requestId);
      const payload: WorkerRequest = {
        type: 'infer',
        requestId,
        pixels: buffer,
        inputSize: geometry.inputSize,
        scale: geometry.scale,
        padX: geometry.padX,
        padY: geometry.padY,
        frameWidth: width,
        frameHeight: height,
        threshold: this.detectionConfig.confidence,
        nmsIou: this.detectionConfig.nmsIou,
        maxDetections: this.detectionConfig.maxDetections,
        timestampMs: timestamp,
        // Read here, on the main thread: the worker has no localStorage.
        debug: detectionDebugEnabled(),
      };
      worker.postMessage(payload, [buffer]);
    } catch (err) {
      if (import.meta.env?.DEV) {
        // eslint-disable-next-line no-console
        console.error('[bharat-av][detector] frame capture failed:', err);
      }
      this.listeners.onError?.(
        `Frame capture failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Keep the most recent samples inside a window measured on the *same* clock
   * that produced them. `Date.now()` is epoch-based, `performance.now()` is not,
   * so mixing the two silently emptied the windows.
   */
  private trimWindow(list: number[], clock: () => number = () => Date.now()) {
    const cutoff = clock() - 30_000;
    while (list.length > 1 && list[0] < cutoff) list.shift();
  }

  /**
   * Rate from the actual span of the samples.
   *
   * Dividing a sample count by a fixed window overstates throughput whenever
   * the interval is large: at ~9 s per inference a 15 s window can hold at most
   * two samples but yields "0.27 fps" where the true rate is ~0.11. Using the
   * measured span makes the number honest at any speed, fast or slow.
   */
  private rateFrom(list: number[]): number {
    if (list.length < 2) return 0;
    const span = (list[list.length - 1] - list[0]) / 1000;
    if (span <= 0) return 0;
    return (list.length - 1) / span;
  }

  private handleWorkerMessage(msg: WorkerResponse) {
    if (msg.type === 'result' || msg.type === 'error') this.clearWatchdog();
    if (msg.type === 'result') {
      if (!this.pending || msg.requestId !== this.pending.requestId) return;
      const latency = msg.preprocessMs + msg.inferenceMs + msg.postprocessMs;
      this.pending = null;
      this.stats.framesInferred += 1;
      this.stats.lastInferenceMs = latency;
      this.latencySamples.push(latency);
      if (this.latencySamples.length > 60) this.latencySamples.shift();
      this.stats.avgInferenceMs =
        this.latencySamples.reduce((a, b) => a + b, 0) / this.latencySamples.length;
      const sorted = [...this.latencySamples].sort((a, b) => a - b);
      this.stats.p95InferenceMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      /*
       * Stamp the *completion* time, not the capture time. Pushing
       * `msg.timestampMs` measured when frames were started, so a 13 s
       * inference still reported a healthy-looking rate while results arrived
       * three times a minute. inferenceFps must answer "how often do results
       * come back", which is what the UI claims.
       */
      this.inferenceTimestamps.push(Date.now());
      this.trimWindow(this.inferenceTimestamps);

      const frame = this.buildFrame(msg.detections, msg.frameWidth, msg.frameHeight, msg.timestampMs, latency, msg.inferenceMs);
      this.lastFrame = frame;
      this.listeners.onFrame?.(frame);
      this.listeners.onStatus?.(this.stats);
      return;
    }
    if (msg.type === 'error' && msg.scope === 'infer') {
      this.pending = null;
      this.stats.framesSkipped += 1;
      if (import.meta.env?.DEV) {
        // eslint-disable-next-line no-console
        console.error('[bharat-av][detector] inference error:', msg.message);
      }
      this.listeners.onError?.(msg.message);
      return;
    }
  }

  private buildFrame(
    raw: { box: BoundingBox; label: string; confidence: number }[],
    frameWidth: number,
    frameHeight: number,
    timestamp: number,
    latency: number,
    pureInferenceMs: number
  ): DetectionFrame {
    const sourceKind: CameraSourceKind = this.source?.kind ?? 'webcam';
    const sourceId = this.source?.id ?? 'unknown';

    let tracks: Track[];
    if (this.detectionConfig.tracking) {
      tracks = this.tracker.update(
        raw.map((d) => ({
          box: d.box,
          classId: mapLabelToVisionClass(d.label),
          modelLabel: d.label,
          confidence: d.confidence,
        })),
        timestamp
      );
    } else {
      this.tracker.reset();
      tracks = raw.map((d, i) => ({
        ...d,
        classId: mapLabelToVisionClass(d.label),
        modelLabel: d.label,
        trackId: `CAM-D${i + 1}`,
        hits: 1,
        missed: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
        confidenceEma: d.confidence,
        vxPx: 0,
        vyPx: 0,
        growthRate: 0,
      }));
    }
    this.lastTracks = tracks;

    const classCounts = new Map<VisionClassId, number>();
    for (const t of tracks) {
      classCounts.set(t.classId, (classCounts.get(t.classId) ?? 0) + 1);
    }

    const detections: CameraDetection[] = tracks
      .map<CameraDetection>((track) => {
        const risk = assessImageRisk({
          classId: track.classId,
          box: track.box,
          frameWidth,
          frameHeight,
          growthRatePerSec: track.growthRate,
        });
        return {
          trackId: track.trackId,
          classId: track.classId,
          modelLabel: track.modelLabel,
          confidence: track.confidence,
          box: track.box,
          timestamp,
          sourceId,
          sourceKind,
          frameWidth,
          frameHeight,
          processingMs: latency,
          origin: 'camera',
          distance: estimateDistance(track.classId, track.box.height, frameWidth, this.calibration),
          riskLevel: risk.riskLevel,
          riskBasis: risk.basis,
        };
      })
      .sort((a, b) => {
        const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return order[a.riskLevel] - order[b.riskLevel] || b.confidence - a.confidence;
      })
      /*
       * Final ceiling on what is rendered.
       *
       * The tracker bounds its own live set, but a frame must never be able to
       * hand an unbounded list to the overlay: `maxDetections` is the operator's
       * stated budget, so enforce it here as well as in the worker. Sorted above,
       * so the cut keeps the highest-risk / highest-confidence boxes.
       */
      .slice(0, Math.max(1, this.detectionConfig.maxDetections));

    this.stats.detectionCount = detections.length;
    /*
     * Measured over the last 15 s. `captureFps` is the rate at which frames were
     * *attempted* (including those dropped by back-pressure) and `inferenceFps`
     * the rate at which results actually came back — deliberately separate so a
     * slow backend can't look like a fast one.
     */
    this.stats.captureFps = this.rateFrom(this.attemptTimestamps);
    this.stats.inferenceFps = this.rateFrom(this.inferenceTimestamps);

    return {
      detections,
      frameWidth,
      frameHeight,
      timestamp,
      sourceId,
      sourceKind,
      stats: { ...this.stats },
      modelId: this.modelStatus.state === 'ready' ? this.modelStatus.id : null,
      // kept for debugging / tests
      ...(pureInferenceMs >= 0 ? {} : {}),
      ...(classCounts.size ? {} : {}),
    } as DetectionFrame;
  }

  /** Currently tracked objects (image space) — used by the hybrid adapter. */
  getTracks(): Track[] {
    return this.lastTracks.map((t) => ({ ...t }));
  }

  dispose(): void {
    this.stop();
    this.worker?.postMessage({ type: 'reset', requestId: this.requestId++ } as WorkerRequest);
    this.worker?.terminate();
    this.worker = null;
    this.source = null;
    this.modelLoadedFor = null;
    this.tracker.reset();
  }

  /** Diagnostics for the UI ("which file was actually loaded?"). */
  getLoadedModel(): { backend: string; url: string } | null {
    return this.modelLoadedFor;
  }

  /** Counters used by automated end-to-end checks (no UI dependency). */
  getDiagnostics(): Record<string, number | string | boolean | null> {
    return {
      running: this.running,
      pendingRequest: this.pending?.requestId ?? null,
      framesCaptured: this.stats.framesCaptured,
      framesInferred: this.stats.framesInferred,
      framesSkipped: this.stats.framesSkipped,
      inferenceFps: this.stats.inferenceFps,
      captureFps: this.stats.captureFps,
      lastInferenceMs: this.stats.lastInferenceMs,
      avgInferenceMs: this.stats.avgInferenceMs,
      p95InferenceMs: this.stats.p95InferenceMs,
      detectionCount: this.stats.detectionCount,
      modelState: this.modelStatus.state,
      backend: this.backend,
      hasSource: Boolean(this.source),
      hasVideo: Boolean(this.source?.video),
      videoWidth: this.source?.video?.videoWidth ?? 0,
      workerReady: Boolean(this.worker),
      executionProvider: this.modelStatus.executionProvider ?? null,
      sourceKind: this.source?.kind ?? null,
      sourceDelivering: this.sourceIsDelivering(),
      sourceLiveTracks:
        (this.source?.video?.srcObject as MediaStream | null)?.getVideoTracks?.().filter(
          (t) => t.readyState === 'live'
        ).length ?? 0,
    };
  }
}

export { COCO_LABELS };
