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

export class SignalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalConfigError';
  }
}

/** Inputs that determine the signalling base URL. Gathered at runtime, pure to resolve. */
export interface SignalBaseInputs {
  /** VITE_SIGNAL_URL, already read from the build environment. */
  envUrl?: string;
  /** The page's `?signal=` parameter, if any. */
  signalParam?: string | null;
  /** True in a production bundle (Vite's import.meta.env.PROD). */
  isProd: boolean;
  /** window.location.origin, or undefined when not in a browser. */
  origin?: string;
  /** window.location.protocol, or undefined. */
  protocol?: string;
}

/**
 * Pure resolution of the signalling base URL.
 *
 * Split out from `signalBaseUrl()` so the production rules can be tested
 * directly instead of by stubbing `import.meta`, which is a per-module object
 * that cannot be reassigned.
 *
 * Resolution order:
 *   1. `?signal=` query parameter (a phone must reach the server that issued its QR)
 *   2. explicit `VITE_SIGNAL_URL` (compiled in at build time)
 *   3. development only: the same-origin Vite proxy `/signal-proxy/signal`
 *
 * In production with no configuration this throws rather than falling back. The
 * old behaviour returned `${origin}/signal-proxy/signal`, a path that only
 * exists inside the Vite dev server — on a static host it 404s, and the failure
 * surfaced to operators as a misleading "start it with npm run signal" message.
 */
export function resolveSignalBaseUrl(inputs: SignalBaseInputs): string {
  /*
   * `?signal=` wins over the compiled-in value.
   *
   * A phone that scanned a QR code carries the signalling URL of the server that
   * issued that token. If a stale `VITE_SIGNAL_URL` took precedence, a phone
   * paired to a self-hosted or LAN server would be sent to the wrong deployment
   * and its ticket would not exist there. The laptop never sends `?signal=` to
   * itself, so the explicit configuration still governs normal operation.
   */
  const param = inputs.signalParam;
  if (param) {
    const normalised = /^https?:/.test(param)
      ? param
      : `${inputs.protocol ?? 'https:'}//${param.replace(/^\/\//, '')}`;
    return normalised.replace(/\/$/, '');
  }

  const envUrl = inputs.envUrl?.trim();
  if (envUrl) return envUrl.replace(/\/$/, '');

  if (inputs.isProd) {
    throw new SignalConfigError(
      'VITE_SIGNAL_URL is not configured. Set it to the public URL of the ' +
        'signalling service (for example https://your-signal-service.onrender.com) ' +
        'and rebuild — it is compiled in at build time.'
    );
  }

  if (inputs.origin) return `${inputs.origin}/signal-proxy/signal`;
  return 'http://localhost:8787';
}

/** Resolve the signalling HTTP base URL (no trailing slash). */
export function signalBaseUrl(): string {
  const env = (import.meta.env ?? {}) as unknown as Record<string, string | boolean | undefined>;
  const search = typeof window !== 'undefined' ? window.location.search : '';
  return resolveSignalBaseUrl({
    envUrl: typeof env.VITE_SIGNAL_URL === 'string' ? env.VITE_SIGNAL_URL : undefined,
    signalParam: search ? new URLSearchParams(search).get('signal') : null,
    isProd: Boolean(env.PROD),
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
    protocol: typeof window !== 'undefined' ? window.location.protocol : undefined,
  });
}

/**
 * Resolves the signalling base URL, returning the configuration error instead of
 * throwing. UI call sites use this so a missing variable renders an actionable
 * message rather than an unhandled exception.
 */
export function resolveSignalBase(): { base: string } | { error: string } {
  try {
    return { base: signalBaseUrl() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Signalling is not configured.' };
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

/**
 * Build the WebSocket URL for a signalling role.
 *
 * The credential is deliberately NOT part of this URL. Query strings are
 * recorded by proxies, CDNs and platform access logs, which would leak a bearer
 * token; browsers also cannot set custom headers on a WebSocket handshake. The
 * ticket is instead sent as the first frame by `SignalSocket` (see
 * `SignalAuth` below), which the server requires before relaying anything.
 */
export function signalSocketUrl(
  base = signalBaseUrl()
): string {
  const wsBase = base.replace(/^http/, 'ws');
  return new URL(`${wsBase}/ws`).toString();
}

/** First-frame credential presented immediately after the socket opens. */
export interface SignalAuth {
  role: 'laptop' | 'phone';
  sessionId: string;
  ticket: string;
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
  private authSent = false;

  constructor(
    private readonly url: string,
    private readonly handlers: {
      onMessage: (msg: SignalMessage) => void;
      /**
       * Fired only after the server has ACCEPTED the first-frame credential,
       * not merely when the socket opens. Callers rely on this: the laptop sends
       * its SDP offer here, and sending before authorisation would be dropped
       * ("not_authenticated") on the new server.
       */
      onOpen?: () => void;
      onClose?: (code: number, reason: string) => void;
      onError?: (message: string) => void;
    },
    private readonly auth: SignalAuth
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open() {
    this.authSent = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.handlers.onError?.(err instanceof Error ? err.message : 'WebSocket failed');
      return;
    }
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      // Present the credential as the first frame. Never in the URL.
      this.authSent = true;
      this.ws?.send(
        JSON.stringify({
          type: 'auth',
          role: this.auth.role,
          sessionId: this.auth.sessionId,
          ticket: this.auth.ticket,
        })
      );
    };
    this.ws.onmessage = (event) => {
      let parsed: SignalMessage;
      try {
        parsed = JSON.parse(String(event.data)) as SignalMessage;
      } catch {
        this.handlers.onError?.('Malformed signalling message');
        return;
      }
      // The server answers the auth frame with `ready`; that is the real
      // "authorised" event for callers.
      if (parsed.type === 'ready') {
        this.handlers.onOpen?.();
      }
      this.handlers.onMessage(parsed);
    };
    this.ws.onerror = () => {
      this.handlers.onError?.('Signalling socket error');
    };
    this.ws.onclose = (event) => {
      this.handlers.onClose?.(event.code, event.reason || '');
      // 4401 = authentication failed/timed out. 4403/4503 = origin rejected or
      // misconfigured; 4029 = rate limited. Reconnecting immediately on any of
      // these just repeats the failure, so only transient codes retry.
      const terminal = [4000, 4001, 4401, 4403, 4503, 4029].includes(event.code);
      if (!this.closedByUser && !terminal) {
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

  /** True once the credential frame has been sent. */
  get isAuthenticated(): boolean {
    return this.authSent;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
