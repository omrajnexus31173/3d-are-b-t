import React, { useState } from 'react';
import {
  AlertTriangle,
  Camera as CameraIcon,
  CameraOff,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Crosshair,
  Gauge,
  Layers,
  MonitorSmartphone,
  Play,
  Plug,
  RefreshCw,
  ScanEye,
  Sliders,
  Square,
  Upload,
  Usb,
  Video,
  XCircle,
} from 'lucide-react';
import type { CameraSystemActions, CameraSystemState } from '../../camera/useCameraSystem';
import type { ModelStatus } from '../../vision/types';
import { VISION_CLASS_COLORS, VISION_CLASS_LABELS } from '../../vision/detector';
import { classSupportFor, DFINE_MODEL, MEDIAPIPE_MODEL, POTHOLE_MODEL, PRIMARY_MODEL, type DetectorId } from '../../vision/models';
import { DetectionOverlay } from './DetectionOverlay';
import { QrPairingPanel } from './QrPairingPanel';

interface Props {
  state: CameraSystemState;
  actions: CameraSystemActions;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  modelStatus: ModelStatus | null;
  onLoadModel: () => void;
  /** Select + load a detector, updating the parent's modelStatus from the result. */
  onSelectDetector: (id: DetectorId) => void;
  onUploadPothole: (file: File) => Promise<void>;
}

const STATUS_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  idle: { dot: 'bg-slate-500', text: 'text-slate-400', label: 'idle' },
  requesting_permission: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'permission' },
  connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-300', label: 'connecting' },
  live: { dot: 'bg-emerald-400 shadow-[0_0_8px_#34D399]', text: 'text-emerald-300', label: 'live' },
  stopped: { dot: 'bg-slate-500', text: 'text-slate-400', label: 'stopped' },
  error: { dot: 'bg-rose-500', text: 'text-rose-300', label: 'error' },
};

export const CameraPanel: React.FC<Props> = ({
  state,
  actions,
  videoRef,
  modelStatus,
  onLoadModel,
  onSelectDetector,
  onUploadPothole,
}) => {
  const [showLabels, setShowLabels] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const status = STATUS_STYLES[state.cameraStatus] ?? STATUS_STYLES.idle;
  const frame = state.frame;
  const stats = frame?.stats;
  const videoSize = state.trackInfo ?? { width: 0, height: 0, label: '', frameRate: 0 };
  const aspect = videoSize.width && videoSize.height ? videoSize.width / videoSize.height : 16 / 9;

  // The pothole adapter is independent of the primary detector: it is "ready"
  // only when its own weights were loaded successfully.
  const potholeLoaded = modelStatus?.id === POTHOLE_MODEL.id && modelStatus.state === 'ready';
  const potholeSupport = classSupportFor(
    POTHOLE_MODEL,
    potholeLoaded,
    potholeLoaded ? 'ready' : 'not_configured'
  );
  const potholeEntry = potholeSupport.find((c) => c.classId === 'pothole');

  const primaryClasses = modelStatus?.classSupport ?? classSupportFor(PRIMARY_MODEL, false, 'not_configured');

  // CPU fallback is honest but slow (~10 s/frame); say so instead of leaving a
  // silently stalled-looking panel of zeros.
  const slowBackend = !!stats && stats.framesInferred > 0 && stats.avgInferenceMs > 1500;

  const selectedDevice = state.devices.find((d) => d.deviceId === state.selectedDeviceId) ?? null;
  const selectedIsUsbLike = selectedDevice?.kind === 'usb_uvc';

  const classCounts = new Map<string, number>();
  for (const d of frame?.detections ?? []) {
    classCounts.set(d.classId, (classCounts.get(d.classId) ?? 0) + 1);
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* ---------- Source controls ---------- */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <CameraIcon className="w-3.5 h-3.5 text-cyan-400" />
            <span>Live Camera Input</span>
          </h2>
          <span className={`text-[10px] font-mono-tech px-1.5 py-0.5 rounded border border-slate-400/20 flex items-center gap-1 ${status.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
        </div>

        {/* Device selector */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <select
            value={state.selectedDeviceId ?? ''}
            onChange={(e) => actions.selectDevice(e.target.value || null)}
            className="flex-1 min-w-0 bg-[#0B0F17] border border-slate-400/20 rounded-lg px-2 py-1 text-[10.5px] font-mono-tech text-slate-200 outline-none focus:border-cyan-400/50"
          >
            <option value="">Default camera (auto)</option>
            {state.devices.map((d, i) => (
              <option key={d.deviceId || `dev-${i}`} value={d.deviceId}>
                {d.kind === 'usb_uvc' ? '[USB] ' : ''}
                {d.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => void actions.refreshDevices(true)}
            title="Refresh camera list (asks for permission the first time)"
            className="p-1.5 rounded-lg bg-[#0B0F17] border border-slate-400/20 text-slate-300 hover:text-cyan-300 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Resolution selector */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <select
            value={state.resolution ? `${state.resolution.width}x${state.resolution.height}` : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return actions.setResolution(null);
              const [w, h] = v.split('x').map(Number);
              actions.setResolution({ width: w, height: h });
            }}
            className="flex-1 min-w-0 bg-[#0B0F17] border border-slate-400/20 rounded-lg px-2 py-1 text-[10.5px] font-mono-tech text-slate-200 outline-none focus:border-cyan-400/50"
            title="Capture resolution. Modes are read from the device where the browser exposes them."
          >
            <option value="">Resolution: device default</option>
            {state.resolutionOptions.map((r) => (
              <option key={`${r.width}x${r.height}`} value={`${r.width}x${r.height}`}>
                {r.label}
                {r.reported ? '' : ' (unverified)'}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between text-[9px] font-mono-tech text-slate-500 mb-2">
          <span className="flex items-center gap-1">
            <Usb className="w-3 h-3" />
            {state.devices.length} video input{state.devices.length === 1 ? '' : 's'}
          </span>
          <span>
            permission: <span className={state.permission === 'granted' ? 'text-emerald-400' : state.permission === 'denied' ? 'text-rose-400' : 'text-slate-400'}>{state.permission}</span>
          </span>
        </div>

        {/* Connect / disconnect */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => void actions.connectLocal()}
            /*
             * Only block while a *local* capture is starting. A WebRTC session
             * waiting for a phone can sit in `connecting` for up to its join
             * timeout (120 s), which used to lock the USB camera out entirely —
             * the operator could not switch to a webcam that was already
             * plugged in.
             */
            disabled={
              state.sourceKind !== 'mobile_webrtc' &&
              (state.cameraStatus === 'connecting' || state.cameraStatus === 'requesting_permission')
            }
            className="px-2 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed border border-cyan-400/40 text-cyan-200 text-[10.5px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Plug className="w-3.5 h-3.5" />
            Connect camera
          </button>
          <button
            onClick={actions.disconnect}
            disabled={
              (state.cameraStatus === 'idle' || state.cameraStatus === 'stopped') &&
              state.sourceKind !== 'mobile_webrtc'
            }
            className="px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-400/25 text-slate-200 text-[10.5px] font-medium flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <CameraOff className="w-3.5 h-3.5" />
            Disconnect
          </button>
        </div>

        {selectedIsUsbLike && (
          <p className="mt-1.5 text-[9px] leading-snug text-slate-500">
            Labelled USB/UVC from its device name — the browser does not expose the physical bus, so this
            is an inference. A phone only appears here if the OS presents it as a capture device;
            otherwise use QR pairing.
          </p>
        )}

        {state.error && (
          <div className="mt-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[10.5px] text-rose-200 font-semibold leading-snug">{state.error.message}</p>
                {state.error.hint && (
                  <p className="text-[9.5px] text-rose-200/70 leading-snug mt-0.5">{state.error.hint}</p>
                )}
                <button
                  onClick={actions.dismissError}
                  className="mt-1 text-[9px] font-mono-tech text-rose-300/80 hover:text-rose-200 cursor-pointer"
                >
                  dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {state.statusDetail && !state.error && (
          <p className="mt-1.5 text-[9.5px] font-mono-tech text-slate-500 truncate">{state.statusDetail}</p>
        )}
      </section>

      {/* ---------- Live preview ---------- */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2">
        <div className="flex items-center justify-between mb-1.5 px-0.5">
          <span className="text-[10px] font-mono-tech text-slate-400 flex items-center gap-1">
            <Video className="w-3 h-3 text-cyan-400" />
            {state.sourceKind === 'mobile_webrtc' ? 'PHONE FEED' : 'CAMERA FEED'}
          </span>
          <div className="flex items-center gap-2 text-[9px] font-mono-tech text-slate-400">
            <span>{videoSize.width ? `${videoSize.width}×${videoSize.height}` : '—'}</span>
            <span className="text-emerald-300">{stats ? `${stats.captureFps.toFixed(0)} fps` : '—'}</span>
          </div>
        </div>

        <div
          className="relative w-full bg-black rounded-lg overflow-hidden border border-slate-700/70"
          style={{ aspectRatio: `${aspect}` }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="absolute inset-0 w-full h-full object-contain"
          />
          <DetectionOverlay
            frame={frame}
            videoWidth={videoSize.width}
            videoHeight={videoSize.height}
            showLabels={showLabels}
            showLowConfidence
            minConfidence={state.config.confidence}
          />

          {state.cameraStatus !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[#0B0F17]/90 text-center px-3">
              <ScanEye className="w-6 h-6 text-slate-600" />
              <p className="text-[10.5px] text-slate-400">
                {state.cameraStatus === 'connecting' || state.cameraStatus === 'requesting_permission'
                  ? 'Starting camera…'
                  : 'No live camera. Connect a webcam/USB camera or pair a phone.'}
              </p>
              <p className="text-[9px] font-mono-tech text-slate-600">
                Camera access requires HTTPS or localhost
              </p>
            </div>
          )}

          {state.cameraStatus === 'live' && !state.detecting && (
            <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-amber-500/85 text-[9px] font-mono-tech font-bold text-[#0B0F17]">
              PREVIEW ONLY · DETECTION OFF
            </div>
          )}
          {state.detecting && (
            <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-emerald-500/90 text-[9px] font-mono-tech font-bold text-[#0B0F17] flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-[#0B0F17] animate-pulse" />
              DETECTING
            </div>
          )}
        </div>

        {/* Detection controls */}
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <button
            onClick={() => void actions.toggleDetection()}
            disabled={state.cameraStatus !== 'live'}
            className={`px-2 py-1.5 rounded-lg border text-[10.5px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
              state.detecting
                ? 'bg-rose-500/20 hover:bg-rose-500/30 border-rose-400/45 text-rose-200'
                : 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-400/45 text-emerald-200'
            }`}
          >
            {state.detecting ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {state.detecting ? 'Stop detection' : 'Start detection'}
          </button>
          <button
            onClick={() => setShowLabels((v) => !v)}
            className={`px-2 py-1.5 rounded-lg border text-[10.5px] font-medium flex items-center justify-center gap-1.5 cursor-pointer ${
              showLabels
                ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-200'
                : 'bg-slate-800 border-slate-400/25 text-slate-300'
            }`}
          >
            <Crosshair className="w-3.5 h-3.5" />
            Boxes {showLabels ? 'on' : 'off'}
          </button>
        </div>

        <div className="mt-1 flex items-center justify-between">
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="text-[9.5px] font-mono-tech text-slate-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
          >
            <Sliders className="w-3 h-3" />
            {showSettings ? 'hide' : 'detection'} settings
          </button>
          <span className="text-[9px] font-mono-tech text-slate-500">
            {state.detecting && stats
              ? `${stats.inferenceFps.toFixed(1)} infer/s · ${stats.lastInferenceMs.toFixed(0)} ms`
              : 'detector idle'}
          </span>
        </div>

        {showSettings && (
          <div className="mt-2 space-y-2 border-t border-slate-400/10 pt-2">
            <label className="block">
              <span className="text-[9.5px] font-mono-tech text-slate-400 flex items-center justify-between">
                <span>Confidence threshold</span>
                <span className="text-cyan-300">{(state.config.confidence * 100).toFixed(0)}%</span>
              </span>
              <input
                type="range"
                min={0.15}
                max={0.9}
                step={0.05}
                value={state.config.confidence}
                onChange={(e) => actions.setConfig({ confidence: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
              {/*
               * D-FINE emits a fixed 300 queries regardless of scene content, so
               * a threshold tuned for YOLO admits many background slots and
               * floods the overlay. Say where the safe point is instead of
               * letting the operator discover it by lowering the slider.
               */}
              {state.preferredDetector === 'dfine-n' && state.config.confidence < 0.5 && (
                <span className="mt-1 block text-[9px] leading-snug text-amber-300/90">
                  D-FINE returns 300 queries per frame. Below ~50% many are background
                  slots, which is what makes the overlay dense and overlapping.
                </span>
              )}
            </label>
            <label className="block">
              <span className="text-[9.5px] font-mono-tech text-slate-400 flex items-center justify-between">
                <span>Inference rate</span>
                <span className="text-cyan-300">{state.config.inferenceHz} Hz</span>
              </span>
              <input
                type="range"
                min={1}
                max={15}
                step={1}
                value={state.config.inferenceHz}
                onChange={(e) => actions.setConfig({ inferenceHz: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
            </label>
            <label className="flex items-center justify-between text-[9.5px] font-mono-tech text-slate-400">
              <span>Tracking (IoU)</span>
              <input
                type="checkbox"
                checked={state.config.tracking}
                onChange={(e) => actions.setConfig({ tracking: e.target.checked })}
                className="accent-cyan-400"
              />
            </label>
          </div>
        )}
      </section>

      {/* ---------- Mobile pairing ---------- */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <MonitorSmartphone className="w-3.5 h-3.5 text-cyan-400" />
            <span>Mobile Camera (QR / WebRTC)</span>
          </h2>
        </div>
        <QrPairingPanel
          pairing={state.pairing}
          signalAvailable={state.signalAvailable}
          onStart={() => void actions.startPairing()}
          onConnect={() => void actions.connectMobile()}
          onCancel={actions.cancelPairing}
        />
      </section>

      {/* ---------- Stats ---------- */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-cyan-400" />
            <span>Detector Performance</span>
          </h2>
          <span className="text-[9px] font-mono-tech text-slate-500">
            {modelStatus?.state === 'ready' ? modelStatus.name : 'no model'}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <Metric label="Capture FPS" value={stats ? stats.captureFps.toFixed(1) : '—'} />
          <Metric label="Infer FPS" value={stats ? stats.inferenceFps.toFixed(1) : '—'} accent="text-emerald-300" />
          <Metric label="Latency" value={stats ? `${stats.lastInferenceMs.toFixed(0)}ms` : '—'} accent="text-amber-300" />
          <Metric label="Detections" value={frame ? String(frame.detections.length) : '—'} />
          <Metric label="Avg lat" value={stats && stats.framesInferred ? `${stats.avgInferenceMs.toFixed(0)}ms` : '—'} />
          <Metric label="Skipped" value={stats ? String(stats.framesSkipped) : '—'} />
        </div>
        {slowBackend && (
          <p className="mt-2 text-[9.5px] leading-snug text-amber-300/90 bg-amber-500/10 border border-amber-400/25 rounded-md px-1.5 py-1">
            Running on the CPU fallback (~{stats ? (stats.lastInferenceMs / 1000).toFixed(0) : '10'} s/frame). Frames are
            dropped on purpose so the sensor stays live — detections are real but delayed. GPU inference needs a device
            whose WebGL context the worker can claim.
          </p>
        )}
        {classCounts.size > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Array.from(classCounts.entries()).map(([classId, count]) => (
              <span
                key={classId}
                className="px-1.5 py-0.5 rounded text-[9px] font-mono-tech font-semibold"
                style={{
                  backgroundColor: `${VISION_CLASS_COLORS[classId as keyof typeof VISION_CLASS_COLORS]}22`,
                  color: VISION_CLASS_COLORS[classId as keyof typeof VISION_CLASS_COLORS],
                  border: `1px solid ${VISION_CLASS_COLORS[classId as keyof typeof VISION_CLASS_COLORS]}55`,
                }}
              >
                {VISION_CLASS_LABELS[classId as keyof typeof VISION_CLASS_LABELS] ?? classId}: {count}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ---------- Model status ---------- */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-cyan-400" />
            <span>Detection Model</span>
          </h2>
          {modelStatus && (
            <span
              className={`text-[9px] font-mono-tech px-1.5 py-0.5 rounded border ${
                modelStatus.state === 'ready'
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                  : modelStatus.state === 'loading'
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/35'
                  : 'bg-slate-700/40 text-slate-300 border-slate-500/30'
              }`}
            >
              {modelStatus.state}
            </span>
          )}
        </div>

        {/* Detector selection. YOLO11n stays the default; D-FINE-N is opt-in. */}
        <div className="flex items-center gap-1.5 mb-2">
          <select
            value={state.preferredDetector}
            onChange={(e) => onSelectDetector(e.target.value as DetectorId)}
            disabled={state.modelLoadState === 'loading'}
            title="YOLO11n is the default. D-FINE-N must be installed in public/models/dfine_n_coco.onnx (the production build downloads it from the GitHub release)."
            className="flex-1 min-w-0 bg-[#0B0F17] border border-slate-400/20 rounded-lg px-2 py-1 text-[10.5px] font-mono-tech text-slate-200 outline-none focus:border-cyan-400/50 disabled:opacity-50"
          >
            <option value="yolo11n">{PRIMARY_MODEL.name}</option>
            <option value="mediapipe">{MEDIAPIPE_MODEL.name}</option>
            <option value="dfine-n">{DFINE_MODEL.name}</option>
          </select>
        </div>

        <div className="text-[9.5px] font-mono-tech text-slate-400 space-y-0.5 mb-2">
          <div className="flex justify-between gap-2">
            <span>model</span>
            <span className="text-slate-200 truncate" title={modelStatus?.name}>{modelStatus?.name ?? PRIMARY_MODEL.name}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>runtime</span>
            <span className={modelStatus?.executionProvider ? 'text-emerald-300' : 'text-slate-400'}>
              {modelStatus?.executionProvider ?? 'not started'}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>weights</span>
            <span className="text-slate-300 truncate max-w-[150px]" title={modelStatus?.url}>{modelStatus?.url ?? PRIMARY_MODEL.url}</span>
          </div>
          {modelStatus?.loadMs !== undefined && (
            <div className="flex justify-between gap-2">
              <span>load time</span>
              <span className="text-slate-300">{modelStatus.loadMs} ms</span>
            </div>
          )}
        </div>

        {modelStatus?.message && modelStatus.state !== 'ready' && (
          <p className="text-[9px] text-amber-300/90 leading-snug mb-2 font-mono-tech break-words">
            {modelStatus.message}
          </p>
        )}

        <div className="space-y-1 mb-2">
          <p className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Traffic classes</p>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            {primaryClasses.map((c) => (
              <div key={c.classId} className="flex items-center gap-1 text-[9.5px] font-mono-tech" title={c.note}>
                {c.supported ? (
                  <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                ) : (
                  <XCircle className="w-2.5 h-2.5 text-slate-600 shrink-0" />
                )}
                <span className={c.supported ? 'text-slate-200' : 'text-slate-500'}>
                  {VISION_CLASS_LABELS[c.classId]}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Pothole adapter is a separate, explicitly-configured model. */}
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[9.5px] font-mono-tech font-semibold text-purple-200 flex items-center gap-1">
              <Layers className="w-3 h-3" />
              Pothole adapter
            </span>
            <span className="text-[8.5px] font-mono-tech px-1 rounded bg-purple-500/20 text-purple-200">
              {potholeEntry?.supported ? 'ready' : 'not configured'}
            </span>
          </div>
          <p className="mt-1 text-[9px] text-slate-400 leading-snug">
            {potholeEntry?.note ??
              'Requires a purpose-trained pothole model. A generic COCO model cannot detect potholes.'}
          </p>
          <label className="mt-1.5 flex items-center justify-center gap-1 px-2 py-1 rounded bg-[#0B0F17] border border-purple-400/30 text-[9px] font-mono-tech text-purple-200 hover:border-purple-400/60 cursor-pointer">
            <Upload className="w-3 h-3" />
            Load pothole .onnx
            <input
              type="file"
              accept=".onnx,application/octet-stream"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploadError(null);
                try {
                  await onUploadPothole(file);
                } catch (err) {
                  setUploadError(err instanceof Error ? err.message : 'Upload failed');
                }
              }}
            />
          </label>
          {uploadError && <p className="mt-1 text-[9px] text-rose-300">{uploadError}</p>}
        </div>

        <button
          onClick={onLoadModel}
          disabled={state.modelLoadState === 'loading'}
          className="mt-2 w-full px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 border border-slate-400/25 text-slate-200 text-[10px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
        >
          {state.modelLoadState === 'loading' ? (
            <>
              <CircleDashed className="w-3.5 h-3.5 animate-spin" />
              Loading weights…
            </>
          ) : (
            <>
              <Cpu className="w-3.5 h-3.5" />
              {modelStatus?.state === 'ready' ? 'Reload model' : 'Load detection model'}
            </>
          )}
        </button>
      </section>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-1.5">
    <div className="text-[9px] text-slate-400 truncate">{label}</div>
    <div className={`text-[11px] font-bold font-mono-tech ${accent ?? 'text-slate-100'}`}>{value}</div>
  </div>
);
