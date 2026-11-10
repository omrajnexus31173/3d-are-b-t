/**
 * HTTP + WebSocket client for the BHARAT-AV signalling server.
 *
 * The server URL is resolved from `VITE_SIGNAL_URL` when provided; otherwise we
 * derive it from a `signal` query parameter (used by the mobile pairing page so
 * the phone does not need build-time configuration) and finally fall back to
 * the dev-server proxy path `/signal`.
 */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CreateSessionResult {
  sessionId: string;
  sessionToken: string;
  expiresAt: number;
  ttlMs: number;
  iceServers: IceServerConfig[];
  turnConfigured: boolean;
  lanAddresses: { name: string; address: string }[];
}

export interface JoinResult {
  sessionId: string;
  joinTicket: string;
  iceServers: IceServerConfig[];
  turnConfigured: boolean;
}

export class SignalError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = 'SignalError';
  }
}

/** Resolve the signalling HTTP base URL (no trailing slash). */
export function signalBaseUrl(): string {
  const fromEnv = readEnv('VITE_SIGNAL_URL');
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (typeof window !== 'undefined') {
    const param = new URLSearchParams(window.location.search).get('signal');
    if (param) {
      const normalised = /^https?:/.test(param)
        ? param
        : `${window.location.protocol}//${param.replace(/^\/\//, '')}`;
      return normalised.replace(/\/$/, '');
    }
    // Same-origin path — proxied by Vite in development. The proxy strips
    // "/signal-proxy", so the effective server path stays "/signal/...".
    return `${window.location.origin}/signal-proxy/signal`;
  }
  return 'http://localhost:8787';
}

function readEnv(key: string): string | undefined {
  try {
    const env = import.meta.env as unknown as Record<string, string | undefined>;
    const v = env?.[key];
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new SignalError(
      `Cannot reach the signalling server at ${url}. ${
        err instanceof Error ? err.message : ''
      }`,
      0
    );
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const reason = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new SignalError(reason, res.status);
  }
  return parsed as T;
}

export async function checkSignalHealth(base = signalBaseUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function createCameraSession(label?: string): Promise<CreateSessionResult> {
  return postJson<CreateSessionResult>(`${signalBaseUrl()}/session`, { label });
}

export async function joinSession(sessionId: string, token: string): Promise<JoinResult> {
  return postJson<JoinResult>(`${signalBaseUrl()}/session/${sessionId}/join`, {
    token,
    device: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  });
}

export async function closeCameraSession(sessionId: string, token: string): Promise<void> {
  const base = signalBaseUrl();
  try {
    await fetch(`${base}/session/${sessionId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': token },
    });
  } catch {
    /* the socket close path also tears the session down */
  }
}

/** Build the WebSocket URL for a signalling role. */
export function signalSocketUrl(
  sessionId: string,
  role: 'laptop' | 'phone',
  credential: string,
  base = signalBaseUrl()
): string {
  const wsBase = base.replace(/^http/, 'ws');
  const url = new URL(`${wsBase}/ws`);
  url.searchParams.set('sid', sessionId);
  url.searchParams.set('role', role);
  url.searchParams.set('ticket', credential);
  return url.toString();
}

export type SignalMessage =
  | { type: 'ready'; role: 'laptop' | 'phone'; sessionId: string; expiresAt: number; peerPresent: boolean }
  | { type: 'peer_joined'; role: 'laptop' | 'phone' }
  | { type: 'peer_left'; role: 'laptop' | 'phone' }
  | { type: 'peer_absent' }
  | { type: 'session_closed'; reason: string }
  | { type: 'error'; reason: string }
  | { type: 'offer'; sdp: string; from?: string }
  | { type: 'answer'; sdp: string; from?: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit; from?: string }
  | { type: 'bye'; from?: string }
  | { type: 'meta'; payload: Record<string, unknown>; from?: string };

/**
 * Minimal reconnecting WebSocket wrapper with typed messages and an explicit
 * close that does not reconnect.
 */
export class SignalSocket {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: {
      onMessage: (msg: SignalMessage) => void;
      onOpen?: () => void;
      onClose?: (code: number, reason: string) => void;
      onError?: (message: string) => void;
    }
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.handlers.onError?.(err instanceof Error ? err.message : 'WebSocket failed');
      return;
    }
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onOpen?.();
    };
    this.ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as SignalMessage;
        this.handlers.onMessage(parsed);
      } catch {
        this.handlers.onError?.('Malformed signalling message');
      }
    };
    this.ws.onerror = () => {
      this.handlers.onError?.('Signalling socket error');
    };
    this.ws.onclose = (event) => {
      this.handlers.onClose?.(event.code, event.reason || '');
      if (!this.closedByUser && event.code !== 4000 && event.code !== 4001) {
        // Bounded exponential backoff (max ~8s) while the pairing page is open.
        if (this.reconnectAttempt < 4) {
          const delay = Math.min(8000, 600 * 2 ** this.reconnectAttempt);
          this.reconnectAttempt += 1;
          this.reconnectTimer = window.setTimeout(() => this.open(), delay);
        }
      }
    };
  }

  send(msg: Omit<SignalMessage, 'from'>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      try {
        this.ws.close(1000, 'client closed');
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
