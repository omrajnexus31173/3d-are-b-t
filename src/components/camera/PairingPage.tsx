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
import {
  joinSession,
  signalBaseUrl,
  signalSocketUrl,
  SignalSocket,
  type IceServerConfig,
  type SignalMessage,
} from '../../camera/signalClient';
import { observeVideoReady } from '../../camera/videoReady';

type Phase = 'preflight' | 'joining' | 'permission' | 'waiting' | 'streaming' | 'ended' | 'error';

interface PairingParams {
  sessionId: string | null;
  token: string | null;
}

function readParams(): PairingParams {
  if (typeof window === 'undefined') return { sessionId: null, token: null };
  const p = new URLSearchParams(window.location.search);
  return { sessionId: p.get('pair'), token: p.get('token') };
}

/**
 * Dedicated mobile camera page.
 *
 * Opened by scanning the laptop's QR code. It:
 *   1. redeems the single-use pairing token (server-validated),
 *   2. asks the user for camera permission explicitly (button press, never auto),
 *   3. streams the camera to the waiting laptop via WebRTC,
 *   4. shows front/rear switching, live state and an explicit stop button.
 *
 * No audio is requested and no video is recorded or uploaded.
 */
export const PairingPage: React.FC = () => {
  const params = useMemo(readParams, []);
  const [phase, setPhase] = useState<Phase>('preflight');
  const [message, setMessage] = useState('');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [iceServers, setIceServers] = useState<IceServerConfig[]>([]);
  const [joinTicket, setJoinTicket] = useState<string | null>(null);
  const [stats, setStats] = useState<{ width: number; height: number } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<SignalSocket | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const remoteSet = useRef(false);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    for (const sender of pcRef.current?.getSenders() ?? []) {
      try {
        pcRef.current?.removeTrack(sender);
      } catch {
        /* ignore */
      }
    }
    try {
      pcRef.current?.close();
    } catch {
      /* ignore */
    }
    pcRef.current = null;
    socketRef.current?.send({ type: 'bye' });
    socketRef.current?.close();
    socketRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStats(null);
  }, []);

  // Exponential back-off for ICE / STUN is handled by the browser; we only log.
  const startCamera = useCallback(
    async (mode: 'environment' | 'user') => {
      setPhase('permission');
      setMessage('Requesting camera permission…');
      try {
        if (!window.isSecureContext) {
          throw new Error(
            'Camera access requires HTTPS. Re-open this link over https:// (the dev server can use `npm run dev:https`).'
          );
        }
        streamRef.current?.getTracks().forEach((t) => t.stop());
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: mode === 'environment' ? { ideal: 'environment' } : { ideal: 'user' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
        });
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await video.play().catch(() => undefined);
          await observeVideoReady(video);
          setStats({ width: video.videoWidth, height: video.videoHeight });
        }
        // Replace the outgoing video track on an existing connection when the
        // user switches front/rear, without renegotiating the whole session.
        const track = stream.getVideoTracks()[0];
        const pc = pcRef.current;
        if (pc && track) {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(track);
          else pc.addTrack(track, stream);
        }
        setPhase(pc?.connectionState === 'connected' ? 'streaming' : 'waiting');
        setMessage('Camera ready — connecting to the laptop…');
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        setPhase('error');
        setMessage(
          name === 'NotAllowedError'
            ? 'Camera permission was denied on this phone. Allow camera access in the browser settings and reload this page.'
            : name === 'NotFoundError'
            ? 'No camera found on this device.'
            : err instanceof Error
            ? err.message
            : 'Could not start the camera.'
        );
      }
    },
    []
  );

  const connect = useCallback(async () => {
    if (!params.sessionId || !params.token) {
      setPhase('error');
      setMessage('This pairing link is incomplete. Generate a new QR code on the laptop.');
      return;
    }
    setPhase('joining');
    setMessage('Validating pairing token…');
    try {
      const joined = await joinSession(params.sessionId, params.token);
      setJoinTicket(joined.joinTicket);
      setIceServers(joined.iceServers);
      setMessage('Token accepted. Waiting for the laptop to negotiate…');

      // Open the signalling socket as the phone peer.
      const socket = new SignalSocket(
        signalSocketUrl(params.sessionId, 'phone', joined.joinTicket),
        {
          onMessage: (msg) => void handleSignal(msg),
          onOpen: () => setPhase((p) => (p === 'joining' ? 'waiting' : p)),
          onError: (m) => setMessage((prev) => `${prev} (${m})`),
          onClose: (code, reason) => {
            if (code === 4000 || code === 4001) {
              setPhase('ended');
              setMessage(`Session ended by the laptop (${reason || 'session closed'}).`);
              cleanup();
            }
          },
        }
      );
      socketRef.current = socket;
      socket.connect();
    } catch (err) {
      setPhase('error');
      const msg = err instanceof Error ? err.message : 'Could not validate the pairing link.';
      setMessage(
        msg === 'unknown_session' || msg === 'invalid_token'
          ? 'This pairing link is invalid or has already been used. Scan a fresh QR code from the laptop.'
          : msg === 'pairing_expired'
          ? 'This pairing session expired. Scan a fresh QR code from the laptop.'
          : msg.startsWith('Cannot reach')
          ? `${msg} — the phone must be able to reach the laptop/signalling server. Use the same Wi-Fi or configure a public host with TURN.`
          : msg
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.sessionId, params.token, cleanup]);

  const handleSignal = useCallback(
    async (msg: SignalMessage) => {
      if (msg.type === 'offer') {
        try {
          const pc = new RTCPeerConnection({
            iceServers: iceServers.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
          });
          pcRef.current = pc;
          remoteSet.current = false;

          pc.onicecandidate = (e) => {
            if (e.candidate) socketRef.current?.send({ type: 'ice', candidate: e.candidate.toJSON() } as unknown as SignalMessage);
          };
          pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
              setPhase('streaming');
              setMessage('Streaming to the laptop.');
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
              setPhase('error');
              setMessage(
                'The connection to the laptop dropped. If you are not on the same Wi-Fi, the server needs TURN configured.'
              );
            }
          };

          const stream = streamRef.current;
          if (stream) {
            for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
          }
          await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          remoteSet.current = true;
          for (const c of pendingCandidates.current.splice(0)) {
            await pc.addIceCandidate(c).catch(() => undefined);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socketRef.current?.send({ type: 'answer', sdp: answer.sdp ?? '' } as unknown as SignalMessage);
          setPhase('waiting');
          setMessage('Answer sent — establishing the video link…');
        } catch (err) {
          setPhase('error');
          setMessage(err instanceof Error ? err.message : 'Negotiation failed.');
        }
        return;
      }
      if (msg.type === 'ice') {
        const pc = pcRef.current;
        if (!pc) return;
        if (!remoteSet.current) pendingCandidates.current.push(msg.candidate);
        else await pc.addIceCandidate(msg.candidate).catch(() => undefined);
        return;
      }
      if (msg.type === 'bye' || msg.type === 'session_closed') {
        setPhase('ended');
        setMessage('The laptop ended the camera session.');
        cleanup();
      }
    },
    [iceServers, cleanup]
  );

  // Validate the token immediately, but do NOT touch the camera until the user
  // presses the button (explicit permission, never automatic activation).
  useEffect(() => {
    void connect();
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchFacing = async () => {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    await startCamera(next);
  };

  const stopAll = () => {
    cleanup();
    setPhase('ended');
    setMessage('Camera stopped. You can close this page.');
  };

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
            {stats && (
              <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-[#0B0F17]/80 text-[9px] font-mono-tech text-slate-300">
                {stats.width}×{stats.height}
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
            <span className="text-slate-300">{joinTicket ? 'validated' : 'not validated'}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => void startCamera(facing)}
            disabled={phase === 'joining' || phase === 'error'}
            className="px-3 py-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-40 border border-emerald-400/45 text-emerald-200 text-[12px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Camera className="w-4 h-4" />
            {streamRef.current ? 'Restart camera' : 'Start camera'}
          </button>
          <button
            onClick={() => void switchFacing()}
            disabled={!streamRef.current}
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
