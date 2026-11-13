/**
 * useCameraSystem — React state binding for the camera + detection pipeline.
 *
 * Keeps ALL heavy work outside React:
 *   - `LocalCameraSource` / `WebRtcCameraSource` own the MediaStream
 *   - `DetectionEngine` owns the worker, tracker and statistics
 * React only receives throttled snapshots (~8 Hz) so the existing simulation
 * render loop keeps its frame budget.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CameraDeviceInfo,
  CameraError,
  CameraResolutionOption,
  CameraSourceKind,
  CameraStatus,
  DetectionConfig,
  DetectionFrame,
  ModelStatus,
  OperatingMode,
} from '../vision/types';
import { DetectionEngine, DEFAULT_DETECTION_CONFIG } from '../vision/detectionEngine';
import {
  LocalCameraSource,
  cameraErrorFrom,
  listCameraDevices,
  probeDeviceCapabilities,
  resolutionOptionsFor,
} from './deviceSource';
import { WebRtcCameraSource } from './webrtcSource';
import type { FrameSource } from './types';
import {
  closeCameraSession,
  createCameraSession,
  signalBaseUrl,
  SignalConfigError,
  signalHealthUrl,
  signalSocketUrl,
  type CreateSessionResult,
} from './signalClient';
import type { CameraCalibration } from '../vision/distance';
import { POTHOLE_MODEL } from '../vision/models';

/**
 * Pick the host a *phone* should use to open this app.
 *
 * A QR code that embeds `localhost` (or `127.0.0.1`) is unscannable in
 * practice: on the phone that address means the phone itself. When the laptop
 * is already on a LAN address we keep it; otherwise we fall back to the
 * signalling server's own LAN candidates and finally to the window host.
 */
function usableLanAddress(address: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  if (address.startsWith('169.254.')) return false; // link-local / APIPA — never routable from a phone
  if (address.startsWith('127.')) return false;
  return true;
}

function lanHostOf(hostname: string): boolean {
  return /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(hostname);
}

function buildPhoneUrl(session: CreateSessionResult): URL {
  const url = new URL(window.location.href);
  url.hash = '';
  if (lanHostOf(url.hostname)) {
    const candidate = session.lanAddresses?.find((a) => usableLanAddress(a.address));
    if (candidate) url.hostname = candidate.address;
  }
  return url;
}

function phoneSignalBase(session: CreateSessionResult, protocol: string): string {
  const base = new URL(signalBaseUrl());
  if (lanHostOf(base.hostname)) {
    const candidate = session.lanAddresses?.find((a) => usableLanAddress(a.address));
    if (candidate) {
      base.hostname = candidate.address;
      base.protocol = protocol;
    }
  }
  return base.toString().replace(/\/$/, '');
}

export interface PairingState {
  status: 'idle' | 'creating' | 'waiting' | 'connected' | 'error' | 'expired';
  session: CreateSessionResult | null;
  /** URL the phone must open (embeds the single-use token). */
  pairingUrl: string | null;
  error: string | null;
  expiresAt: number | null;
  peerState: 'waiting' | 'connecting' | 'connected' | 'disconnected';
}

export interface CameraSystemState {
  mode: OperatingMode;
  cameraStatus: CameraStatus;
  statusDetail: string;
  error: CameraError | null;
  devices: CameraDeviceInfo[];
  devicesLoaded: boolean;
  selectedDeviceId: string | null;
  permission: 'granted' | 'prompt' | 'unknown' | 'denied';
  trackInfo: { width: number; height: number; label: string; frameRate: number } | null;
  frame: DetectionFrame | null;
  detecting: boolean;
  modelLoadState: 'idle' | 'loading' | 'ready' | 'error';
  signalAvailable: boolean | null;
  pairing: PairingState;
  sourceKind: CameraSourceKind | null;
  config: DetectionConfig;
  calibration: CameraCalibration | null;
  /** Chosen capture size, null = browser default. */
  resolution: { width: number; height: number } | null;
  /** Modes available for the selected device (device-reported when possible). */
  resolutionOptions: CameraResolutionOption[];
  /** Detector the operator selected. YOLO11n is the default. */
  preferredDetector: 'yolo11n' | 'dfine-n';
}

export interface CameraSystemActions {
  setMode: (mode: OperatingMode) => void;
  refreshDevices: (requestPermission?: boolean) => Promise<void>;
  selectDevice: (deviceId: string | null) => void;
  connectLocal: () => Promise<void>;
  connectMobile: () => Promise<void>;
  disconnect: () => void;
  toggleDetection: () => Promise<void>;
  loadModel: (backend?: 'onnxruntime-web' | 'tfjs') => Promise<ModelStatus>;
  loadPotholeModel: (file: File) => Promise<ModelStatus>;
  startPairing: () => Promise<void>;
  cancelPairing: () => void;
  setResolution: (next: { width: number; height: number } | null) => void;
  setConfig: (patch: Partial<DetectionConfig>) => void;
  setCalibration: (c: CameraCalibration | null) => void;
  /**
   * Select YOLO11n or D-FINE-N and (re)load it. Returns the resulting status so
   * the caller can react to a D-FINE failure that fell back to YOLO11n.
   */
  selectDetector: (id: 'yolo11n' | 'dfine-n') => Promise<ModelStatus>;
  dismissError: () => void;
}

const initialPairing: PairingState = {
  status: 'idle',
  session: null,
  pairingUrl: null,
  error: null,
  expiresAt: null,
  peerState: 'waiting',
};

export function useCameraSystem(
  simTimeRef: { current: number }
): { state: CameraSystemState; actions: CameraSystemActions; videoRef: React.RefObject<HTMLVideoElement | null>; engineRef: React.RefObject<DetectionEngine | null> } {
  const [mode, setModeState] = useState<OperatingMode>('simulation');
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [error, setError] = useState<CameraError | null>(null);
  const [devices, setDevices] = useState<CameraDeviceInfo[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [permission, setPermission] = useState<'granted' | 'prompt' | 'unknown' | 'denied'>('unknown');
  const [trackInfo, setTrackInfo] = useState<CameraSystemState['trackInfo']>(null);
  const [frame, setFrame] = useState<DetectionFrame | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [modelLoadState, setModelLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [signalAvailable, setSignalAvailable] = useState<boolean | null>(null);
  const [pairing, setPairing] = useState<PairingState>(initialPairing);
  const [sourceKind, setSourceKind] = useState<CameraSourceKind | null>(null);
  const [config, setConfigState] = useState<DetectionConfig>(DEFAULT_DETECTION_CONFIG);
  const [calibration, setCalibrationState] = useState<CameraCalibration | null>(null);
  const [preferredDetector, setPreferredDetectorState] = useState<'yolo11n' | 'dfine-n'>('yolo11n');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const engineRef = useRef<DetectionEngine | null>(null);
  const lastFrameFlush = useRef(0);
  const pendingFrame = useRef<DetectionFrame | null>(null);
  const rafRef = useRef<number | null>(null);
  const pairingSessionRef = useRef<CreateSessionResult | null>(null);
  /** Latest selected device, readable from callbacks without a stale closure. */
  const selectedDeviceIdRef = useRef<string | null>(null);

  // --- engine construction ------------------------------------------------
  if (!engineRef.current) {
    engineRef.current = new DetectionEngine(DEFAULT_DETECTION_CONFIG, {
      onFrame: (f) => {
        pendingFrame.current = f;
      },
      onModelStatus: (status) => {
        setModelLoadState(status.state === 'ready' ? 'ready' : status.state === 'error' ? 'error' : status.state === 'loading' ? 'loading' : 'idle');
      },
      onError: (msg) => {
        setError({ code: 'unknown', message: msg });
      },
    });
  }

  // Dev-only diagnostics handle (used by the automated end-to-end checks).
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__bharatCamera = {
      engine: engineRef.current,
      getDiagnostics: () => engineRef.current?.getDiagnostics(),
      getFrame: () => engineRef.current?.getLastFrame(),
    };
  }

  // Throttled snapshot of detection frames → React.
  useEffect(() => {
    const tick = () => {
      const now = performance.now();
      if (pendingFrame.current && now - lastFrameFlush.current > 110) {
        lastFrameFlush.current = now;
        setFrame(pendingFrame.current);
        pendingFrame.current = null;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Keep the visible <video> element attached to the active source.
  useEffect(() => {
    const src = sourceRef.current;
    if (src?.video && videoRef.current && videoRef.current.srcObject !== src.video.srcObject) {
      videoRef.current.srcObject = src.video.srcObject;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [cameraStatus, frame]);

  const refreshDevices = useCallback(async (requestPermission = false) => {
    const result = await listCameraDevices({ requestPermission });
    if (result.ok) {
      setDevices(result.devices);
      setPermission(result.permission);
      setDevicesLoaded(true);
      if (!result.ok) return;
      // Real hardware modes, read once per device. Only after permission, since
      // getCapabilities() needs a track and the labels need consent.
      if (result.permission === 'granted') {
        const withCaps = await Promise.all(
          result.devices.map(async (d) =>
            d.capabilities?.length ? d : { ...d, capabilities: await probeDeviceCapabilities(d.deviceId) }
          )
        );
        setDevices(withCaps);
      }
    } else {
      setError(result.error);
      const fallback = (result as unknown as { devices?: CameraDeviceInfo[] }).devices ?? [];
      setDevices(fallback);
      setDevicesLoaded(true);
    }
  }, []);

  /**
   * Selected capture size. `null` = let the browser pick, which is the right
   * default for a device whose real modes are unknown.
   */
  const [resolution, setResolutionState] = useState<{ width: number; height: number } | null>(null);

  const selectDevice = useCallback((deviceId: string | null) => {
    // Mirror into the ref first so an immediate Connect cannot race the state update.
    selectedDeviceIdRef.current = deviceId;
    setSelectedDeviceId(deviceId);
    // Modes differ per device; never carry a stale choice across devices.
    setResolutionState(null);
  }, []);

  /**
   * Stop and detach the active source, and clear its remote video element.
   * Stops tracks so the phone's camera indicator turns off and no stale
   * MediaStream is left attached to a hidden element.
   */
  const releaseSource = useCallback(() => {
    const current = sourceRef.current;
    sourceRef.current = null;
    try {
      current?.stop();
    } catch {
      /* already gone */
    }
    if (engineRef.current) engineRef.current.setSource(null);
    if (videoRef.current) videoRef.current.srcObject = null;
    setSourceKind(null);
  }, []);

  const disconnect = useCallback(() => {
    engineRef.current?.stop();
    setDetecting(false);
    releaseSource();
    setCameraStatus('stopped');
    setStatusDetail('');
    setTrackInfo(null);
    setFrame(null);
    setPairing(initialPairing);
    const session = pairingSessionRef.current;
    if (session) {
      void closeCameraSession(session.sessionId, session.sessionToken);
      pairingSessionRef.current = null;
    }
  }, [releaseSource]);

  const connectLocal = useCallback(async () => {
    // Release whatever was running before (single camera source at a time).
    // Uses releaseSource so the previous source's late callbacks can no longer
    // resurrect it — the same ownership rule the WebRTC path follows.
    releaseSource();
    setFrame(null);
    setError(null);
    setStatusDetail('');

    /*
     * Read the selection through the ref, not the closure.
     *
     * `actions` is a useMemo over these callbacks, and connectLocal is also
     * invoked directly by the panel. When the device list is refreshed the
     * component may re-render without this callback being rebuilt in the same
     * tick, so a closure over `selectedDeviceId` can still hold the previous
     * camera — connecting the wrong device (or the "Default camera" entry) even
     * though the dropdown shows another one.
     */
    const deviceId = selectedDeviceIdRef.current;
    const chosen = devices.find((d) => d.deviceId === deviceId) ?? null;
    const source = new LocalCameraSource(
      {
        deviceId: deviceId ?? undefined,
        kind: chosen?.kind,
        label: chosen?.label,
        // Only constrain when the user picked a mode; otherwise let the browser
        // choose, which avoids OverconstrainedError on unknown hardware.
        width: resolution?.width,
        height: resolution?.height,
        frameRate: 30,
      },
      {
        status: (s, detail) => {
          if (sourceRef.current !== source) return;
          setCameraStatus(s);
          if (detail) setStatusDetail(detail);
        },
        error: (e) => {
          if (sourceRef.current !== source) return;
          setError(e);
        },
        trackInfo: (info) => {
          if (sourceRef.current !== source) return;
          setTrackInfo({ width: info.width, height: info.height, label: info.label, frameRate: info.frameRate });
          setSourceKind(info.sourceKind);
        },
      }
    );
    sourceRef.current = source;
    setSourceKind('webcam');
    try {
      await source.start();
      setSourceKind(source.kind);
      engineRef.current?.setSource(source);
      if (videoRef.current && source.video?.srcObject) {
        videoRef.current.srcObject = source.video.srcObject;
        void videoRef.current.play().catch(() => undefined);
      }
      // Refresh the device list now that labels are available.
      void refreshDevices(false);
    } catch (err) {
      setError(cameraErrorFrom(err));
    }
  }, [refreshDevices, devices, resolution, releaseSource]);

  // --- QR / WebRTC pairing ------------------------------------------------
  const pairingInFlight = useRef(false);

  const startPairing = useCallback(async () => {
    // Guard against a double submit (double click / StrictMode replay) creating
    // two sessions and leaving a QR code that points at the abandoned one.
    if (pairingInFlight.current) return;
    pairingInFlight.current = true;
    setPairing({ ...initialPairing, status: 'creating' });
    setSignalAvailable(null);
    try {
      const session = await createCameraSession('BHARAT-AV laptop');
      pairingSessionRef.current = session;
      // The phone must be able to reach this exact origin. When the app runs
      // over a LAN address this embeds the signalling URL as well so the phone
      // talks to the same server even on a different port/host.
      const url = buildPhoneUrl(session);
      url.searchParams.set('pair', session.sessionId);
      url.searchParams.set('token', session.sessionToken);
      url.searchParams.set('signal', phoneSignalBase(session, url.protocol));
      setPairing({
        status: 'waiting',
        session,
        pairingUrl: url.toString(),
        error: null,
        expiresAt: session.expiresAt,
        peerState: 'waiting',
      });
      setSignalAvailable(true);
    } catch (err) {
      setSignalAvailable(false);
      setPairing({
        ...initialPairing,
        status: 'error',
        error:
          err instanceof SignalConfigError
            ? err.message
            : err instanceof Error
            ? `${err.message} — start it with "npm run signal" (or "npm run dev:signal").`
            : 'Could not create a pairing session.',
      });
    } finally {
      pairingInFlight.current = false;
    }
  }, []);

  const cancelPairing = useCallback(() => {
    const session = pairingSessionRef.current;
    if (session) {
      void closeCameraSession(session.sessionId, session.sessionToken);
      pairingSessionRef.current = null;
    }
    setPairing(initialPairing);
  }, []);

  const connectMobile = useCallback(async () => {
    const session = pairing.session;
    if (!session) {
      setError({
        code: 'signalling_unavailable',
        message: 'Create a pairing QR code first.',
      });
      return;
    }
    // Release the previous source *before* building the new one. Otherwise its
    // late async callbacks (track ended, video ready) can resurrect a stale
    // element while the new source is already live — two live <video>s, one of
    // them orphaned in the DOM.
    releaseSource();
    setFrame(null);
    setError(null);

    const source = new WebRtcCameraSource({
      sessionId: session.sessionId,
      socketUrl: signalSocketUrl(),
      socketTicket: session.sessionToken,
      iceServers: session.iceServers,
      onStatus: (s, detail) => {
        if (sourceRef.current !== source) return;
        setCameraStatus(s);
        if (detail) setStatusDetail(detail);
      },
      onError: (e) => {
        if (sourceRef.current !== source) return;
        setError(e);
      },
      onTrackInfo: (info) => {
        if (sourceRef.current !== source) return;
        setTrackInfo({ width: info.width, height: info.height, label: info.label, frameRate: info.frameRate });
      },
      onPeerState: (peerState) => {
        if (sourceRef.current !== source) return;
        setPairing((prev) => ({ ...prev, peerState, status: peerState === 'connected' ? 'connected' : prev.status }));
      },
      // The source object is created before the phone is known, so the engine
      // must be (re)bound whenever this source acquires or drops its stream.
      // Without this, detection keeps pointing at the previous session's dead
      // element after a reconnect while the new video renders fine.
      onVideoChange: (video) => {
        if (!video) return;
        if (sourceRef.current !== source) return; // stale source, ignore
        setSourceKind(source.kind);
        if (engineRef.current) {
          engineRef.current.setSource(source);
          if (videoRef.current && video.srcObject) {
            videoRef.current.srcObject = video.srcObject;
            void videoRef.current.play().catch(() => undefined);
          }
        }
      },
    });
    sourceRef.current = source;
    setSourceKind('mobile_webrtc');
    try {
      await source.start();
      engineRef.current?.setSource(source);
      if (videoRef.current && source.video?.srcObject) {
        videoRef.current.srcObject = source.video.srcObject;
        void videoRef.current.play().catch(() => undefined);
      }
    } catch (err) {
      setError(cameraErrorFrom(err));
    }
  }, [pairing.session, releaseSource]);

  /**
   * Turn on the optional pothole adapter with real, user-supplied weights.
   * Returns the resulting model status; throws only for an empty file.
   */
  const loadPotholeModel = useCallback(async (file: File) => {
    const engine = engineRef.current;
    if (!engine) throw new Error('Detection engine is not ready.');
    if (file.size < 1024) throw new Error('That file is too small to be an ONNX model.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0x08) {
      throw new Error('Not an ONNX model (unexpected file signature).');
    }
    // Pothole weights are always single-class; let the operator override labels.
    setModelLoadState('loading');
    const status = await engine.loadModelWith('onnxruntime-web', POTHOLE_MODEL, undefined, bytes);
    setModelLoadState(status.state === 'ready' ? 'ready' : 'error');
    return status;
  }, []);

  const loadModel = useCallback(async (backend?: 'onnxruntime-web' | 'tfjs') => {
    setModelLoadState('loading');
    const engine = engineRef.current;
    if (!engine) return { state: 'error' } as ModelStatus;
    const status = await engine.loadModel(backend);
    setModelLoadState(status.state === 'ready' ? 'ready' : status.state === 'error' ? 'error' : 'idle');
    return status;
  }, []);

  const toggleDetection = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.isRunning()) {
      engine.stop();
      setDetecting(false);
      return;
    }
    if (engine.getModelStatus().state !== 'ready') {
      // Auto-load on first Start Detection so the user is not forced to press
      // two buttons; if the primary runtime is unavailable we fall back.
      const status = await loadModel();
      if (status.state !== 'ready') {
        return;
      }
    }
    const ok = engine.start();
    setDetecting(ok);
    if (!ok) {
      setError({
        code: 'unknown',
        message: 'Detection could not start — check the camera preview and model status.',
      });
    }
  }, [loadModel]);

  /**
   * Switch the preferred detector and immediately load it.
   *
   * Detection is stopped first: swapping the graph underneath a running loop
   * would score frames with the old session while the panel claims the new one.
   * The operator presses Start detection again once the new model is ready.
   */
  const selectDetector = useCallback(async (id: 'yolo11n' | 'dfine-n') => {
    const engine = engineRef.current;
    setPreferredDetectorState(id);
    if (!engine) return { state: 'error' } as ModelStatus;
    const changed = engine.setPreferredDetector(id);
    if (!changed && engine.getModelStatus().state === 'ready') {
      return engine.getModelStatus();
    }
    if (engine.isRunning()) {
      engine.stop();
      setDetecting(false);
    }
    setModelLoadState('loading');
    const status = await engine.loadModel('onnxruntime-web');
    setModelLoadState(status.state === 'ready' ? 'ready' : status.state === 'error' ? 'error' : 'idle');
    /*
     * If D-FINE was requested but the engine fell back, say so explicitly rather
     * than leaving the panel showing a detector the operator did not pick.
     */
    if (id === 'dfine-n' && status.state === 'ready' && status.id !== 'dfine-n-coco') {
      setError({
        code: 'unknown',
        message: `D-FINE-N could not be loaded — running ${status.name} instead.`,
        hint: status.message,
      });
    }
    return status;
  }, []);

  const setResolution = useCallback((next: { width: number; height: number } | null) => {
    setResolutionState(next);
  }, []);

  const setConfig = useCallback((patch: Partial<DetectionConfig>) => {
    setConfigState((prev) => {
      const next = { ...prev, ...patch };
      engineRef.current?.setConfig(next);
      return next;
    });
  }, []);

  const setCalibration = useCallback((c: CameraCalibration | null) => {
    setCalibrationState(c);
    engineRef.current?.setCalibration(c);
  }, []);

  const setMode = useCallback(
    (next: OperatingMode) => {
      setModeState(next);
      if (next === 'simulation') {
        // Camera keeps streaming if connected, but detection is paused to keep
        // the simulation frame budget untouched.
        engineRef.current?.stop();
        setDetecting(false);
      }
    },
    []
  );

  // Detect signalling availability once (cheap, no session created).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Route through the shared helper so the mount path is defined once.
        const res = await fetch(signalHealthUrl());
        if (!cancelled) setSignalAvailable(res.ok);
      } catch {
        if (!cancelled) setSignalAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Enumerate devices once (labels appear after first permission grant).
  useEffect(() => {
    void refreshDevices(false);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return;
    const handler = () => void refreshDevices(false);
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
  }, [refreshDevices]);

  /*
   * Full cleanup on unmount: stops tracks, closes peer connections, terminates
   * the worker.
   *
   * The pairing session is deliberately NOT deleted here. React StrictMode
   * mounts, unmounts and re-mounts effects once at startup, so an unmount-time
   * DELETE destroyed the session milliseconds after the QR was generated and
   * every phone scan then failed with `unknown_session`. The session is torn
   * down explicitly by the user (Disconnect / Cancel) or by the signalling
   * server's TTL and idle sweeper.
   */
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      sourceRef.current?.stop();
    };
  }, []);

  // A page that is really closed releases its session immediately. `pagehide`
  // fires on close/navigation, unlike a React unmount, so this cannot race with
  // StrictMode.
  useEffect(() => {
    const release = () => {
      const session = pairingSessionRef.current;
      if (!session) return;
      pairingSessionRef.current = null;
      void closeCameraSession(session.sessionId, session.sessionToken);
    };
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
  }, []);

  const state = useMemo<CameraSystemState>(
    () => ({
      mode,
      cameraStatus,
      statusDetail,
      error,
      devices,
      devicesLoaded,
      selectedDeviceId,
      permission,
      trackInfo,
      frame,
      detecting,
      modelLoadState,
      signalAvailable,
      pairing,
      sourceKind,
      config,
      calibration,
      resolution,
      resolutionOptions: resolutionOptionsFor(devices.find((d) => d.deviceId === selectedDeviceId) ?? null),
      preferredDetector,
    }),
    [
      mode,
      cameraStatus,
      statusDetail,
      error,
      devices,
      devicesLoaded,
      selectedDeviceId,
      permission,
      trackInfo,
      frame,
      detecting,
      modelLoadState,
      signalAvailable,
      pairing,
      sourceKind,
      config,
      calibration,
      resolution,
      preferredDetector,
    ]
  );

  const actions = useMemo<CameraSystemActions>(
    () => ({
      setMode,
      refreshDevices,
      selectDevice,
      connectLocal,
      connectMobile,
      disconnect,
      toggleDetection,
      loadModel,
      loadPotholeModel,
      startPairing,
      cancelPairing,
      setResolution,
      setConfig,
      setCalibration,
      selectDetector,
      dismissError: () => setError(null),
    }),
    [
      setMode,
      refreshDevices,
      selectDevice,
      connectLocal,
      connectMobile,
      disconnect,
      toggleDetection,
      loadModel,
      loadPotholeModel,
      startPairing,
      cancelPairing,
      setResolution,
      setConfig,
      setCalibration,
      selectDetector,
    ]
  );

  // simTimeRef is reserved for future timestamp alignment between worlds; the
  // simulation clock is not required by the camera pipeline itself.
  void simTimeRef;

  return { state, actions, videoRef, engineRef };
}
