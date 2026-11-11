#!/usr/bin/env node
/**
 * BHARAT-AV signalling server.
 *
 * Purpose
 * -------
 * WebRTC needs out-of-band signalling. This server provides it for the
 * "mobile phone as camera" feature, with deliberate security properties:
 *
 *   1. A laptop creates a camera *session*; the server issues a 256-bit random
 *      token. The token is embedded in the QR code.
 *   2. The phone redeems the token once (single use) and receives a distinct,
 *      short-lived *join ticket* bound to that session.
 *   3. WebSocket roles are authorised by those tickets — never by a peer id or
 *      any client-supplied identifier.
 *   4. Sessions expire (default 10 minutes from creation, 5 minutes of idle).
 *   5. Only SDP / ICE payloads are relayed, only between the two peers of the
 *      same session, and nothing is persisted to disk.
 *   6. Either side can explicitly disconnect; the other side is notified and
 *      the session is destroyed.
 *
 * It also exposes the ICE configuration (STUN + optional TURN) so that the
 * browser does not need to hard-code credentials, and the LAN host candidates
 * so the UI can build a QR URL that a phone on the same Wi-Fi can actually open.
 *
 * Run:  node server/signal-server.mjs        (or: npm run signal)
 * Env:  SIGNAL_PORT=8787
 *       SIGNAL_TTL_MS=600000
 *       TURN_URL=turn:turn.example.org:3478
 *       TURN_USERNAME=...
 *       TURN_CREDENTIAL=...
 *       STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
 *       ALLOWED_ORIGINS=http://localhost:5173,https://xxxx.e2b.app   (optional)
 */
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

/*
 * PORT first, SIGNAL_PORT second.
 *
 * Render (and Heroku-style hosts) inject a dynamic PORT and health-check that
 * exact port. Reading only SIGNAL_PORT made the service bind 8787 while the
 * platform probed PORT, so the deploy was marked unhealthy even though the
 * process was running.
 */
const PORT = Number(process.env.PORT ?? process.env.SIGNAL_PORT ?? 8787);
const TTL_MS = Number(process.env.SIGNAL_TTL_MS ?? 10 * 60 * 1000);
const IDLE_MS = Number(process.env.SIGNAL_IDLE_MS ?? 5 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.SIGNAL_MAX_SESSIONS ?? 200);

/** How long an unauthenticated socket may stay connected before it is closed. */
const AUTH_TIMEOUT_MS = Number(process.env.SIGNAL_AUTH_TIMEOUT_MS ?? 5000);
/** Close code for a socket that failed to authenticate in time. */
const CLOSE_UNAUTHENTICATED = 4401;
/** Connection attempts allowed per client IP per window. */
const WS_CONN_LIMIT = Number(process.env.SIGNAL_WS_CONN_LIMIT ?? 20);
const WS_CONN_WINDOW_MS = Number(process.env.SIGNAL_WS_CONN_WINDOW_MS ?? 60_000);

/**
 * Whether to trust `X-Forwarded-For` for the client IP.
 *
 * Opt-in only. A forwarded header is client-controlled unless a proxy you
 * operate overwrites or appends it, so trusting it unconditionally would let
 * anyone bypass the connection rate limit by spoofing a header. Render appends
 * the real peer address, so when this is enabled the *right-most* entry is used
 * — that is the value our proxy wrote, not anything the client supplied.
 */
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '');

const IS_PRODUCTION =
  process.env.NODE_ENV === 'production' || /^(1|true|yes)$/i.test(process.env.SIGNAL_PRODUCTION ?? '');

const STUN_URLS = (process.env.STUN_URLS ??
  'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TURN = process.env.TURN_URL
  ? {
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME ?? '',
      credential: process.env.TURN_CREDENTIAL ?? '',
    }
  : null;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

/**
 * In production an explicit allowlist is mandatory.
 *
 * The previous behaviour treated an empty allowlist as "allow every origin",
 * which is fine for local development and unacceptable in production: any site
 * could mint pairing sessions against the public signalling service and use it
 * as a relay. Missing configuration now fails closed instead of open.
 */
const ORIGIN_CONFIG_MISSING = IS_PRODUCTION && ALLOWED_ORIGINS.length === 0;

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * @typedef {Object} Peer
 * @property {import('ws').WebSocket} ws
 * @property {'laptop'|'phone'} role
 * @property {string} ticketHash
 * @property {number} connectedAt
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} tokenHash
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {number} lastActivity
 * @property {boolean} tokenRedeemed
 * @property {Peer|null} laptop
 * @property {Peer|null} phone
 * @property {number} relayed
 */

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Usable addresses for a phone on the same network.
 *
 * Link-local APIPA addresses (169.254.0.0/16) are excluded: they appear when a
 * container/NIC has no DHCP lease and are never reachable from a phone, yet
 * they are exactly the address a naive "first non-internal IPv4" pick returns.
 * Private ranges are ranked first, then any other routable address.
 */
function usableAddress(address) {
  if (address.startsWith('169.254.')) return false;
  if (address.startsWith('127.')) return false;
  return true;
}

function addressRank(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

function lanUrls() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!usableAddress(addr.address)) continue;
      out.push({ name, address: addr.address });
    }
  }
  out.sort((a, b) => addressRank(a.address) - addressRank(b.address));
  return out;
}

/**
 * Resolves the client IP used for rate limiting.
 *
 * `X-Forwarded-For` is only consulted when TRUST_PROXY is enabled, and then the
 * *right-most* entry is taken: that is the hop appended by the proxy we operate.
 * The left-most entry is the one a client can forge by sending its own header.
 * Without TRUST_PROXY the real socket address is used, which cannot be spoofed.
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    if (raw) {
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Rolling per-IP connection counter for the WebSocket endpoint. */
const connWindows = new Map();

/**
 * Counts a connection attempt and reports whether it is allowed.
 * Window size and limit are configurable; entries expire lazily.
 */
function allowConnection(ip, now = Date.now()) {
  if (WS_CONN_LIMIT <= 0) return { allowed: true, retryAfterMs: 0 };
  const entry = connWindows.get(ip);
  if (!entry || now - entry.startedAt > WS_CONN_WINDOW_MS) {
    connWindows.set(ip, { count: 1, startedAt: now });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (entry.count >= WS_CONN_LIMIT) {
    return { allowed: false, retryAfterMs: Math.max(0, WS_CONN_WINDOW_MS - (now - entry.startedAt)) };
  }
  entry.count += 1;
  return { allowed: true, retryAfterMs: 0 };
}

function sweepRateLimits(now = Date.now()) {
  for (const [ip, entry] of connWindows) {
    if (now - entry.startedAt > WS_CONN_WINDOW_MS) connWindows.delete(ip);
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const expired = now > s.expiresAt;
    const idle = now - s.lastActivity > IDLE_MS;
    const abandoned = !s.laptop && !s.phone && now - s.createdAt > 60_000;
    if (expired || idle || abandoned) {
      closeSession(id, expired ? 'pairing_expired' : 'session_idle');
    }
  }
}
setInterval(() => {
  sweep();
  sweepRateLimits();
}, 15_000).unref?.();

function destroySession(id) {
  sessions.delete(id);
}

function closeSession(id, reason) {
  const s = sessions.get(id);
  if (!s) return;
  for (const peer of [s.laptop, s.phone]) {
    if (peer && peer.ws.readyState === peer.ws.OPEN) {
      sendJson(peer.ws, { type: 'session_closed', reason });
      try {
        peer.ws.close(4000, reason);
      } catch {
        /* ignore */
      }
    }
  }
  destroySession(id);
}

function sendJson(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* socket already gone */
  }
}

/** Request classes with different origin rules. */
const ORIGIN_CLASS = {
  /** Laptop-only, always same-origin from a known deployment. */
  LAPTOP: 'laptop',
  /** Phone join / WebSocket. A native mobile app webview may send `Origin: null`. */
  PHONE: 'phone',
  /** Read-only discovery endpoints (health, info); never privileged. */
  PUBLIC: 'public',
};

/**
 * Decides whether a request origin may receive CORS headers.
 *
 * Rules (approved design: B + C):
 *  - A missing allowlist is a configuration error in production. Fail closed.
 *  - `Origin: null` is never allowed for laptop session creation, and always
 *    rejected when the allowlist is enforced.
 *  - `Origin: null` may pass on PHONE-class requests, because some mobile
 *    browsers/webviews send it, but only as far as the *origin* check: the
 *    single-use ticket is still required on those endpoints. Origin validation
 *    never substitutes for ticket authentication.
 *  - We never emit `Access-Control-Allow-Origin: null`. When an origin is not
 *    allowed no ACAO header is sent at all, which is what actually blocks the
 *    response; sending the literal string "null" invited the browser to treat
 *    it as an opaque-origin grant.
 */
function evaluateOrigin(origin, requestClass = ORIGIN_CLASS.PUBLIC) {
  if (ORIGIN_CONFIG_MISSING) {
    return { allowed: false, reason: 'origin_config_missing', status: 503 };
  }

  const isNull = origin === 'null' || origin === undefined || origin === '';
  const allowlistEnforced = ALLOWED_ORIGINS.length > 0;

  if (origin === 'null') {
    if (requestClass === ORIGIN_CLASS.PHONE) return { allowed: true, reason: 'phone_null_origin' };
    return { allowed: false, reason: 'null_origin_not_allowed', status: 403 };
  }

  if (allowlistEnforced) {
    if (ALLOWED_ORIGINS.includes(origin)) return { allowed: true, reason: 'allowlisted' };
    return { allowed: false, reason: 'origin_not_allowed', status: 403 };
  }

  // No allowlist and not production (i.e. local development).
  if (isNull) return { allowed: true, reason: 'dev_no_origin' };
  return { allowed: true, reason: 'dev_allow_all' };
}

function corsHeaders(origin, requestClass = ORIGIN_CLASS.PUBLIC) {
  const verdict = evaluateOrigin(origin, requestClass);
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Session-Token',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
  };
  // Only ever echo a concrete, allowed origin. Never "null", never "*" when an
  // allowlist is configured.
  if (verdict.allowed && typeof origin === 'string' && origin !== 'null') {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return { allowed: verdict.allowed, reason: verdict.reason, status: verdict.status, headers };
}

function json(res, status, body, origin, requestClass = ORIGIN_CLASS.PUBLIC) {
  const { headers } = corsHeaders(origin, requestClass);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Emits a readable configuration error rather than silently allowing traffic. */
function configError(res, origin, detail) {
  json(res, 503, { error: 'origin_config_missing', detail }, origin, ORIGIN_CLASS.PUBLIC);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  /*
   * Classify the request before checking its origin, because the rules differ:
   * laptop session creation must never accept `Origin: null`, while the phone
   * join/websocket path may (some mobile webviews send it) - and even then the
   * single-use ticket is still enforced separately below.
   */
  const isPhoneJoin = /^\/signal\/session\/[A-Za-z0-9_-]+\/join$/.test(url.pathname);
  const isLaptopCreate = req.method === 'POST' && url.pathname === '/signal/session';
  const requestClass = isPhoneJoin
    ? ORIGIN_CLASS.PHONE
    : isLaptopCreate
    ? ORIGIN_CLASS.LAPTOP
    : ORIGIN_CLASS.PUBLIC;

  if (req.method === 'OPTIONS') {
    const { headers } = corsHeaders(origin, requestClass);
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (ORIGIN_CONFIG_MISSING) {
    configError(res, origin, 'ALLOWED_ORIGINS must be set when running in production.');
    return;
  }

  const verdict = evaluateOrigin(origin, requestClass);
  if (origin && !verdict.allowed) {
    json(res, verdict.status ?? 403, { error: verdict.reason }, origin, requestClass);
    return;
  }

  // --- discovery -------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/signal/health') {
    json(res, 200, { ok: true, sessions: sessions.size, ttlMs: TTL_MS }, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/signal/info') {
    json(
      res,
      200,
      {
        service: 'bharat-av-signalling',
        ttlMs: TTL_MS,
        iceServers: buildIceServers(),
        turnConfigured: Boolean(TURN),
        stunUrls: STUN_URLS,
        lanAddresses: lanUrls(),
        activeSessions: sessions.size,
      },
      origin
    );
    return;
  }

  // --- create a camera session (laptop) --------------------------------
  if (req.method === 'POST' && url.pathname === '/signal/session') {
    if (sessions.size >= MAX_SESSIONS) {
      json(res, 429, { error: 'too_many_sessions' }, origin);
      return;
    }
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: 'bad_request' }, origin);
      return;
    }
    const id = randomToken(12);
    const token = randomToken(32);
    const now = Date.now();
    /** @type {Session} */
    const session = {
      id,
      tokenHash: hash(token),
      createdAt: now,
      expiresAt: now + TTL_MS,
      lastActivity: now,
      tokenRedeemed: false,
      laptop: null,
      phone: null,
      relayed: 0,
    };
    sessions.set(id, session);
    json(
      res,
      201,
      {
        sessionId: id,
        sessionToken: token,
        expiresAt: session.expiresAt,
        ttlMs: TTL_MS,
        iceServers: buildIceServers(),
        turnConfigured: Boolean(TURN),
        lanAddresses: lanUrls(),
        suggestedLabel: typeof body?.label === 'string' ? body.label.slice(0, 40) : undefined,
      },
      origin
    );
    return;
  }

  // --- redeem the pairing token (phone) --------------------------------
  const joinMatch = url.pathname.match(/^\/signal\/session\/([A-Za-z0-9_-]+)\/join$/);
  if (req.method === 'POST' && joinMatch) {
    const session = sessions.get(joinMatch[1]);
    if (!session) {
      json(res, 404, { error: 'unknown_session' }, origin, ORIGIN_CLASS.PHONE);
      return;
    }
    if (Date.now() > session.expiresAt) {
      closeSession(session.id, 'pairing_expired');
      json(res, 410, { error: 'pairing_expired' }, origin, ORIGIN_CLASS.PHONE);
      return;
    }
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: 'bad_request' }, origin, ORIGIN_CLASS.PHONE);
      return;
    }
    const presented = String(body?.token ?? req.headers['x-session-token'] ?? '');
    if (!presented || !safeEqualHex(hash(presented), session.tokenHash)) {
      json(res, 403, { error: 'invalid_token' }, origin, ORIGIN_CLASS.PHONE);
      return;
    }
    if (session.tokenRedeemed) {
      json(res, 409, { error: 'token_already_used' }, origin, ORIGIN_CLASS.PHONE);
      return;
    }
    session.tokenRedeemed = true;
    session.lastActivity = Date.now();
    const joinTicket = randomToken(24);
    // Store the ticket on the session; the phone must present it on the socket.
    session.phoneTicketHash = hash(joinTicket);
    session.phoneTicketExpiresAt = Date.now() + 60_000;
    json(
      res,
      200,
      {
        sessionId: session.id,
        joinTicket,
        iceServers: buildIceServers(),
        turnConfigured: Boolean(TURN),
        deviceHint: typeof body?.device === 'string' ? body.device.slice(0, 80) : undefined,
      },
      origin,
      ORIGIN_CLASS.PHONE
    );
    return;
  }

  // --- explicit disconnect -------------------------------------------
  const delMatch = url.pathname.match(/^\/signal\/session\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && delMatch) {
    const session = sessions.get(delMatch[1]);
    if (!session) {
      json(res, 404, { error: 'unknown_session' }, origin);
      return;
    }
    const presented = String(req.headers['x-session-token'] ?? '');
    if (!presented || !safeEqualHex(hash(presented), session.tokenHash)) {
      json(res, 403, { error: 'invalid_token' }, origin);
      return;
    }
    closeSession(session.id, 'closed_by_host');
    json(res, 200, { closed: true }, origin);
    return;
  }

  json(res, 404, { error: 'not_found' }, origin);
});

function buildIceServers() {
  const servers = [{ urls: STUN_URLS }];
  if (TURN) {
    servers.push({ urls: TURN.urls, username: TURN.username, credential: TURN.credential });
  }
  return servers;
}

// ---------------------------------------------------------------------------
// WebSocket relay
// ---------------------------------------------------------------------------
// The socket endpoint is accepted on /ws (direct) and /signal/ws (when the
// server is mounted behind a path-prefixed reverse proxy).
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

/**
 * WebSocket authentication: first frame, not the URL.
 *
 * The ticket used to be a `?ticket=` query parameter. Query strings are logged
 * verbatim by proxies, CDNs and platform access logs, so a bearer credential
 * ended up in third-party logs. Browsers cannot set custom headers on a
 * WebSocket handshake, so the credential now travels as the first frame:
 *
 *   1. connect to /ws (no credentials in the URL)
 *   2. client sends { type: 'auth', role, sessionId, ticket }
 *   3. server validates against the single-use ticket / session token
 *   4. server replies { type: 'ready', ... } and only then relays signalling
 *
 * Until step 3 succeeds nothing is relayed, and a socket that has not
 * authenticated within AUTH_TIMEOUT_MS is closed with 4401.
 */
wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (!/^\/(signal\/)?ws$/.test(url.pathname)) {
    try {
      ws.close(4004, 'bad_path');
    } catch {
      /* ignore */
    }
    return;
  }

  const ip = clientIp(req);
  const gate = allowConnection(ip);
  if (!gate.allowed) {
    sendJson(ws, { type: 'error', reason: 'rate_limited', retryAfterMs: gate.retryAfterMs });
    try {
      ws.close(4029, 'rate_limited');
    } catch {
      /* ignore */
    }
    return;
  }

  // Origin is checked here too, but only as a *precondition*: it never
  // authorises anything on its own. The ticket below is the security boundary.
  const originVerdict = evaluateOrigin(req.headers.origin, ORIGIN_CLASS.PHONE);
  if (ORIGIN_CONFIG_MISSING) {
    sendJson(ws, { type: 'error', reason: 'origin_config_missing' });
    try {
      ws.close(4503, 'origin_config_missing');
    } catch {
      /* ignore */
    }
    return;
  }
  if (req.headers.origin && !originVerdict.allowed) {
    sendJson(ws, { type: 'error', reason: originVerdict.reason });
    try {
      ws.close(4403, originVerdict.reason);
    } catch {
      /* ignore */
    }
    return;
  }

  /** @type {{role:'laptop'|'phone', session:string}|null} */
  let auth = null;
  let authedSession = null;

  const fail = (reason, code = 4001) => {
    sendJson(ws, { type: 'error', reason });
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  };

  /** Authenticates the socket. Returns true when the socket is authorised. */
  const authenticate = (msg) => {
    if (auth) return false;
    const role = msg.role;
    const sessionId = String(msg.sessionId ?? '');
    const ticket = String(msg.ticket ?? '');

    if (role !== 'laptop' && role !== 'phone') {
      fail('bad_role');
      return false;
    }
    if (!sessionId || !ticket) {
      fail('missing_credentials');
      return false;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      fail('unknown_session');
      return false;
    }
    if (Date.now() > session.expiresAt) {
      closeSession(session.id, 'pairing_expired');
      fail('pairing_expired');
      return false;
    }

    if (role === 'laptop') {
      if (!safeEqualHex(hash(ticket), session.tokenHash)) {
        fail('invalid_token');
        return false;
      }
      if (session.laptop) {
        fail('laptop_already_connected');
        return false;
      }
      session.laptop = { ws, role, ticketHash: '', connectedAt: Date.now() };
    } else {
      if (!session.phoneTicketHash) {
        fail('join_not_redeemed');
        return false;
      }
      if (!safeEqualHex(hash(ticket), session.phoneTicketHash)) {
        fail('invalid_ticket');
        return false;
      }
      if (Date.now() > (session.phoneTicketExpiresAt ?? 0)) {
        fail('ticket_expired');
        return false;
      }
      if (session.phone) {
        fail('phone_already_connected');
        return false;
      }
      session.phone = { ws, role, ticketHash: session.phoneTicketHash, connectedAt: Date.now() };
    }

    auth = { role, session: session.id };
    authedSession = session;
    session.lastActivity = Date.now();
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }

    sendJson(ws, {
      type: 'ready',
      role,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      peerPresent: role === 'laptop' ? Boolean(session.phone) : Boolean(session.laptop),
    });

    const counterpart = role === 'laptop' ? session.phone : session.laptop;
    if (counterpart) {
      sendJson(counterpart.ws, { type: 'peer_joined', role });
    }
    return true;
  };

  // Unauthenticated sockets are closed promptly, with a distinct code so the
  // client can tell "never authenticated" from "session rejected".
  let authTimer = setTimeout(() => {
    if (!auth) {
      sendJson(ws, { type: 'error', reason: 'auth_timeout' });
      try {
        ws.close(CLOSE_UNAUTHENTICATED, 'auth_timeout');
      } catch {
        /* ignore */
      }
    }
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: 'error', reason: 'bad_json' });
      return;
    }

    // Only the auth frame is accepted before authentication.
    if (!auth) {
      if (msg?.type !== 'auth') {
        fail('not_authenticated');
        return;
      }
      authenticate(msg);
      return;
    }

    const session = authedSession;
    const role = auth.role;
    session.lastActivity = Date.now();

    // Only relay a fixed allow-list of signalling payloads.
    const allowed = ['offer', 'answer', 'ice', 'bye', 'meta'];
    if (!allowed.includes(msg?.type)) {
      sendJson(ws, { type: 'error', reason: 'message_type_not_allowed' });
      return;
    }
    const target = role === 'laptop' ? session.phone : session.laptop;
    if (!target || target.ws.readyState !== target.ws.OPEN) {
      sendJson(ws, { type: 'peer_absent' });
      return;
    }
    session.relayed += 1;
    sendJson(target.ws, { ...msg, type: msg.type, from: role });
  });

  ws.on('close', () => {
    if (authTimer) clearTimeout(authTimer);
    if (!auth) return;
    const session = sessions.get(auth.session);
    if (!session) return;
    if (auth.role === 'laptop' && session.laptop?.ws === ws) session.laptop = null;
    if (auth.role === 'phone' && session.phone?.ws === ws) session.phone = null;
    const other = auth.role === 'laptop' ? session.phone : session.laptop;
    if (other && other.ws.readyState === other.ws.OPEN) {
      sendJson(other.ws, { type: 'peer_left', role: auth.role });
    }
    if (!session.laptop && !session.phone) {
      // Keep an empty session for a short grace period so a phone reconnect can
      // still redeem within the ticket window; the sweeper cleans it up.
      session.lastActivity = Date.now();
    }
  });

  ws.on('error', () => {
    /* socket errors surface via close */
  });
});

server.listen(PORT, process.env.SIGNAL_HOST ?? '0.0.0.0', () => {
  const addrs = lanUrls()
    .map((a) => `http://${a.address}:${PORT}`)
    .join(', ');
  console.log(`[bharat-av] signalling server listening on 0.0.0.0:${PORT}`);
  console.log(`[bharat-av] health:    http://localhost:${PORT}/signal/health`);
  if (addrs) console.log(`[bharat-av] LAN hints: ${addrs}`);
  console.log(
    `[bharat-av] TURN: ${TURN ? TURN.urls.join(', ') : 'not configured (LAN / same-network only)'}`
  );
});

function shutdown() {
  for (const id of [...sessions.keys()]) closeSession(id, 'server_shutdown');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
