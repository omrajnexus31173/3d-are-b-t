import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Compass,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  SwitchCamera,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { signalBaseUrl } from '../../camera/signalClient';
import {
  getPairingController,
  type PairingController,
  type PairingSnapshot,
} from '../../camera/pairingController';

interface PairingParams {
  sessionId: string | null;
  token: string | null;
}

function readParams(): PairingParams {
  if (typeof window === 'undefined') return { sessionId: null, token: null };
  const p = new URLSearchParams(window.location.search);
  return { sessionId: p.get('pair'), token: p.get('token') };
}

const EMPTY: PairingSnapshot = {
  phase: 'preflight',
  message: '',
  facing: 'environment',
  ticketValidated: false,
  cameraLive: false,
  previewSize: null,
  iceServers: [],
};

/**
 * Dedicated mobile camera page.
 *
 * Opened by scanning the laptop's QR code. It:
 *   1. redeems the single-use pairing token (server-validated),
 *   2. asks the user for camera permission explicitly (button press, never auto),
 *   3. streams the camera to the waiting laptop via WebRTC,
 *   4. shows front/rear switching, live state and an explicit stop button.
 *
 * Connection state lives in `PairingController` at module scope, not in this
 * component — see that file for why (StrictMode would otherwise open two
 * signalling sockets and trip the server's single-phone rule).
 */
export const PairingPage: React.FC = () => {
  const params = useMemo(readParams, []);
  const [snapshot, setSnapshot] = useState<PairingSnapshot>(EMPTY);
  const controllerRef = useRef<PairingController | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!params.sessionId || !params.token || typeof window === 'undefined') return;
    const controller = getPairingController(params.sessionId, params.token, setSnapshot);
    controllerRef.current = controller;
    controller.attachVideo(videoRef.current);
    // Re-sync in case the controller already advanced (remount / fast refresh).
    setSnapshot(controller.getSnapshot());
    void controller.start();
  }, [params.sessionId, params.token]);

  // The controller must only be attached once the <video> element exists.
  useEffect(() => {
    controllerRef.current?.attachVideo(videoRef.current);
  }, []);

  const startCamera = useCallback(() => {
    void controllerRef.current?.startCamera();
  }, []);
  const switchFacing = useCallback(() => {
    void controllerRef.current?.switchFacing();
  }, []);
  const stopAll = useCallback(() => {
    controllerRef.current?.stop();
  }, []);

  const { phase, message, facing, previewSize, ticketValidated } = snapshot;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      <header className="h-[52px] shrink-0 bg-[#111827] border-b border-slate-400/15 px-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/15 border border-cyan-400/40 flex items-center justify-center text-cyan-400">
            <Compass className="w-4 h-4" />
          </div>
          <div className="leading-tight">
            <div className="text-[12.5px] font-bold">BHARAT-AV</div>
            <div className="text-[9px] text-slate-400 font-mono-tech">Mobile camera pairing</div>
          </div>
        </div>
        <span className="text-[9px] font-mono-tech text-slate-400 flex items-center gap-1">
          <ShieldCheck className="w-3 h-3 text-emerald-400" />
          single-use token
        </span>
      </header>

      <main className="flex-1 p-3 flex flex-col gap-2.5 max-w-[520px] w-full mx-auto">
        <div className="rounded-xl border border-slate-400/15 bg-[#111827] overflow-hidden">
          <div className="relative bg-black aspect-[3/4] sm:aspect-video">
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              className="absolute inset-0 w-full h-full object-cover"
            />
            {phase !== 'streaming' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center bg-[#0B0F17]/85">
                {phase === 'joining' || phase === 'permission' ? (
                  <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                ) : phase === 'error' ? (
                  <TriangleAlert className="w-6 h-6 text-rose-400" />
                ) : phase === 'ended' ? (
                  <WifiOff className="w-6 h-6 text-slate-500" />
                ) : (
                  <Smartphone className="w-6 h-6 text-slate-400" />
                )}
                <p className="text-[11px] text-slate-300 leading-snug max-w-[300px]">{message}</p>
              </div>
            )}
            {phase === 'streaming' && (
              <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-emerald-500/90 text-[9px] font-mono-tech font-bold text-[#0B0F17] flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-[#0B0F17] animate-pulse" />
                LIVE → LAPTOP
              </div>
            )}
            {previewSize && (
              <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-[#0B0F17]/80 text-[9px] font-mono-tech text-slate-300">
                {previewSize.width}×{previewSize.height}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-400/15 bg-[#111827] p-2.5 space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-mono-tech">
            <span className="text-slate-400">session</span>
            <span className="text-slate-200">{params.sessionId ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono-tech">
            <span className="text-slate-400">signalling</span>
            <span className="text-slate-300 truncate max-w-[240px]">{signalBaseUrl()}</span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono-tech">
            <span className="text-slate-400">state</span>
            <span className="text-cyan-300">{phase}</span>
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono-tech">
            <span className="text-slate-400">ticket</span>
            <span className="text-slate-300">{ticketValidated ? 'validated' : 'not validated'}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={startCamera}
            disabled={phase === 'joining' || phase === 'error'}
            className="px-3 py-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-40 border border-emerald-400/45 text-emerald-200 text-[12px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Camera className="w-4 h-4" />
            {snapshot.cameraLive ? 'Restart camera' : 'Start camera'}
          </button>
          <button
            onClick={switchFacing}
            disabled={!snapshot.cameraLive}
            className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-400/25 text-slate-200 text-[12px] font-medium flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <SwitchCamera className="w-4 h-4" />
            {facing === 'environment' ? 'Rear → Front' : 'Front → Rear'}
          </button>
          <button
            onClick={stopAll}
            className="px-3 py-2.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/45 text-rose-200 text-[12px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <WifiOff className="w-4 h-4" />
            Stop & disconnect
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-400/25 text-slate-200 text-[12px] font-medium flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            Reconnect
          </button>
        </div>

        <div className="rounded-xl border border-slate-400/15 bg-[#111827] p-2.5 text-[9.5px] text-slate-400 leading-relaxed">
          <p className="flex items-center gap-1 text-emerald-300 font-semibold text-[10px] mb-1">
            <CheckCircle2 className="w-3 h-3" />
            Privacy
          </p>
          No audio is captured. Video is sent peer-to-peer to your laptop only — nothing is uploaded
          or recorded. Closing this page or pressing stop ends the camera immediately.
        </div>
      </main>
    </div>
  );
};
