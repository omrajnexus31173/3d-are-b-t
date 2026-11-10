import React, { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Copy, QrCode, RefreshCw, ShieldCheck, Smartphone, Timer, Wifi, X } from 'lucide-react';
import type { PairingState } from '../../camera/useCameraSystem';

interface Props {
  pairing: PairingState;
  signalAvailable: boolean | null;
  onStart: () => void;
  onConnect: () => void;
  onCancel: () => void;
}

/** Render a QR code as an inline SVG path — no external image service. */
function useQrSvg(text: string | null): string | null {
  return useMemo(() => {
    if (!text) return null;
    try {
      // typeNumber 0 = auto-size; 'M' error correction keeps the code readable
      // on a phone screen while staying small.
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    } catch {
      return null;
    }
  }, [text]);
}

function useCountdown(expiresAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const remaining = Math.max(0, expiresAt - now);
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);
  return { remaining, label: `${mm}:${ss.toString().padStart(2, '0')}`, expired: remaining <= 0 };
}

export const QrPairingPanel: React.FC<Props> = ({ pairing, signalAvailable, onStart, onConnect, onCancel }) => {
  const svg = useQrSvg(pairing.pairingUrl);
  const countdown = useCountdown(pairing.expiresAt);
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    if (!pairing.pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairing.pairingUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  if (signalAvailable === false && pairing.status === 'idle') {
    return (
      <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[10.5px] leading-snug">
        <div className="flex items-center gap-1.5 text-amber-300 font-semibold mb-1">
          <Wifi className="w-3.5 h-3.5" />
          <span>Signalling server not reachable</span>
        </div>
        <p className="text-slate-300">
          Phone pairing needs the signalling server. Start it in a second terminal:
        </p>
        <code className="mt-1 block rounded bg-[#0B0F17] px-1.5 py-1 font-mono-tech text-[10px] text-cyan-300">
          npm run signal<span className="text-slate-500"> (or)</span> npm run dev:signal
        </code>
        <button
          onClick={onStart}
          className="mt-2 px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 text-[10px] font-semibold cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  if (pairing.status === 'idle' || pairing.status === 'error') {
    return (
      <div className="rounded-lg border border-slate-400/15 bg-[#0B0F17] p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10.5px] font-semibold text-slate-200 flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
            Mobile camera via QR
          </span>
          <span className="text-[9px] font-mono-tech text-slate-500">WebRTC</span>
        </div>
        <p className="text-[10px] text-slate-400 leading-snug mb-2">
          Stream a phone camera into BHARAT-AV. Uses a single-use, expiring pairing token; the
          phone keeps its own camera permission prompt.
        </p>
        {pairing.error && (
          <p className="text-[10px] text-rose-300 mb-2 leading-snug">{pairing.error}</p>
        )}
        <button
          onClick={onStart}
          className="w-full px-2 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/40 text-cyan-200 text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <QrCode className="w-3.5 h-3.5" />
          Generate pairing QR
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-[#0B0F17] p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10.5px] font-semibold text-cyan-200 flex items-center gap-1.5">
          <QrCode className="w-3.5 h-3.5" />
          Scan with your phone
        </span>
        <button onClick={onCancel} className="text-slate-400 hover:text-rose-300 cursor-pointer" title="Cancel pairing">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {pairing.status === 'creating' && (
        <div className="h-[132px] flex items-center justify-center text-[10.5px] text-slate-400">
          <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" />
          Creating a secure session…
        </div>
      )}

      {svg && pairing.status !== 'creating' && (
        <div
          className="mx-auto w-[132px] h-[132px] bg-white rounded-md p-1 [&>svg]:w-full [&>svg]:h-full"
          // QR markup is generated locally from the pairing URL (no HTML input).
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      <div className="mt-1.5 space-y-1 text-[9.5px] font-mono-tech">
        <div className="flex items-center justify-between text-slate-400">
          <span className="flex items-center gap-1">
            <Timer className="w-3 h-3" />
            {countdown ? (
              countdown.expired ? (
                <span className="text-rose-300">expired</span>
              ) : (
                <span className={countdown.remaining < 60000 ? 'text-amber-300' : 'text-slate-300'}>
                  {countdown.label} left
                </span>
              )
            ) : (
              '—'
            )}
          </span>
          <span className="flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-400" />
            single-use token
          </span>
        </div>
        <div className="flex items-center justify-between text-slate-400">
          <span>session</span>
          <span className="text-slate-300 truncate max-w-[110px]" title={pairing.session?.sessionId}>
            {pairing.session?.sessionId}
          </span>
        </div>
        <div className="flex items-center justify-between text-slate-400">
          <span>TURN relay</span>
          <span className={pairing.session?.turnConfigured ? 'text-emerald-300' : 'text-amber-300'}>
            {pairing.session?.turnConfigured ? 'configured' : 'LAN only'}
          </span>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <button
          onClick={copyLink}
          className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-400/25 text-slate-200 text-[10px] font-medium flex items-center justify-center gap-1 cursor-pointer"
        >
          <Copy className="w-3 h-3" />
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button
          onClick={onConnect}
          className="px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/45 text-emerald-200 text-[10px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
        >
          <Smartphone className="w-3 h-3" />
          Connect
        </button>
      </div>

      <p className="mt-1.5 text-[9px] text-slate-500 leading-snug">
        Phone must be on the same network as this laptop (or the server must have TURN
        configured for internet pairing). Audio is never requested.
      </p>
      <div className="mt-1 flex items-center gap-1 text-[9px] font-mono-tech">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            pairing.peerState === 'connected'
              ? 'bg-emerald-400'
              : pairing.peerState === 'connecting'
              ? 'bg-amber-400 animate-pulse'
              : 'bg-slate-500'
          }`}
        />
        <span className="text-slate-400">peer: {pairing.peerState}</span>
      </div>
    </div>
  );
};
