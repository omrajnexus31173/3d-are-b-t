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
import type { CameraDeviceInfo, CameraError, CameraSourceKind, CameraStatus, DetectionConfig, DetectionFrame, ModelStatus, OperatingMode } from '../vision/types';
import { DetectionEngine, DEFAULT_DETECTION_CONFIG } from '../vision/detectionEngine';
import { LocalCameraSource, cameraErrorFrom, listCameraDevices } from './deviceSource';
import { WebRtcCameraSource } from './webrtcSource';
import type { FrameSource } from './types';
import {
  closeCameraSession,
  createCameraSession,
  signalBaseUrl,
  signalSocketUrl,
  type CreateSessionResult,
} from './signalClient';
import type { CameraCalibration } from '../vision/distance';
import { POTHOLE_MODEL } from '../vision/models';

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
  setConfig: (patch: Partial<DetectionConfig>) => void;
  setCalibration: (c: CameraCalibration | null) => void;
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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const engineRef = useRef<DetectionEngine | null>(null);
  const lastFrameFlush = useRef(0);
  const pendingFrame = useRef<DetectionFrame | null>(null);
  const rafRef = useRef<number | null>(null);
  const pairingSessionRef = useRef<CreateSessionResult | null>(null);

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
    } else {
      setError(result.error);
      const fallback = (result as unknown as { devices?: CameraDeviceInfo[] }).devices ?? [];
      setDevices(fallback);
      setDevicesLoaded(true);
    }
  }, []);

  const selectDevice = useCallback((deviceId: string | null) => {
    setSelectedDeviceId(deviceId);
  }, []);

  const disconnect = useCallback(() => {
    engineRef.current?.stop();
    setDetecting(false);
    sourceRef.current?.stop();
    sourceRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraStatus('stopped');
    setStatusDetail('');
    setTrackInfo(null);
    setFrame(null);
    setSourceKind(null);
    setPairing(initialPairing);
    const session = pairingSessionRef.current;
    if (session) {
      void closeCameraSession(session.sessionId, session.sessionToken);
      pairingSessionRef.current = null;
    }
  }, []);

  const connectLocal = useCallback(async () => {
    // Release whatever was running before (single camera source at a time).
    sourceRef.current?.stop();
    engineRef.current?.setSource(null);
    setFrame(null);
    setError(null);
    setStatusDetail('');

    const source = new LocalCameraSource(
      { deviceId: selectedDeviceId ?? undefined, width: 1280, height: 720, frameRate: 30 },
      {
        status: (s, detail) => {
          setCameraStatus(s);
          if (detail) setStatusDetail(detail);
        },
        error: (e) => setError(e),
        trackInfo: (info) => {
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
  }, [refreshDevices, selectedDeviceId]);

  // --- QR / WebRTC pairing ------------------------------------------------
  const startPairing = useCallback(async () => {
    setPairing({ ...initialPairing, status: 'creating' });
    setSignalAvailable(null);
    try {
      const session = await createCameraSession('BHARAT-AV laptop');
      pairingSessionRef.current = session;
      // The phone must be able to reach this exact origin. When the app runs
      // over a LAN address this embeds the signalling URL as well so the phone
      // talks to the same server even on a different port/host.
      const url = new URL(window.location.href);
      url.hash = '';
      url.searchParams.set('pair', session.sessionId);
      url.searchParams.set('token', session.sessionToken);
      url.searchParams.set('signal', signalBaseUrl());
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
          err instanceof Error
            ? `${err.message} — start it with "npm run signal" (or "npm run dev:signal").`
            : 'Could not create a pairing session.',
      });
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
    sourceRef.current?.stop();
    engineRef.current?.setSource(null);
    setFrame(null);
    setError(null);

    const source = new WebRtcCameraSource({
      sessionId: session.sessionId,
      socketUrl: signalSocketUrl(session.sessionId, 'laptop', session.sessionToken),
      iceServers: session.iceServers,
      onStatus: (s, detail) => {
        setCameraStatus(s);
        if (detail) setStatusDetail(detail);
      },
      onError: (e) => setError(e),
      onTrackInfo: (info) => {
        setTrackInfo({ width: info.width, height: info.height, label: info.label, frameRate: info.frameRate });
      },
      onPeerState: (peerState) => {
        setPairing((prev) => ({ ...prev, peerState, status: peerState === 'connected' ? 'connected' : prev.status }));
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
  }, [pairing.session]);

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
        const res = await fetch(`${signalBaseUrl()}/health`);
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

  // Full cleanup on unmount: stops tracks, closes peer connections, terminates
  // the worker, releases the session. Prevents "camera still on" leaks.
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      sourceRef.current?.stop();
      const session = pairingSessionRef.current;
      if (session) void closeCameraSession(session.sessionId, session.sessionToken);
    };
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
      setConfig,
      setCalibration,
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
      setConfig,
      setCalibration,
    ]
  );

  // simTimeRef is reserved for future timestamp alignment between worlds; the
  // simulation clock is not required by the camera pipeline itself.
  void simTimeRef;

  return { state, actions, videoRef, engineRef };
}
