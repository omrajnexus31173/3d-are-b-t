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

const PORT = Number(process.env.SIGNAL_PORT ?? 8787);
const TTL_MS = Number(process.env.SIGNAL_TTL_MS ?? 10 * 60 * 1000);
const IDLE_MS = Number(process.env.SIGNAL_IDLE_MS ?? 5 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.SIGNAL_MAX_SESSIONS ?? 200);

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
  .map((s) => s.trim())
  .filter(Boolean);

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
setInterval(sweep, 15_000).unref?.();

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

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin ?? '');
  return {
    allowed,
    headers: {
      'Access-Control-Allow-Origin': allowed ? origin || '*' : 'null',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Session-Token',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
      'Cache-Control': 'no-store',
    },
  };
}

function json(res, status, body, origin) {
  const { headers } = corsHeaders(origin);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
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

  if (req.method === 'OPTIONS') {
    const { headers } = corsHeaders(origin);
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const { allowed } = corsHeaders(origin);
  if (origin && !allowed) {
    json(res, 403, { error: 'origin_not_allowed' }, origin);
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
      json(res, 404, { error: 'unknown_session' }, origin);
      return;
    }
    if (Date.now() > session.expiresAt) {
      closeSession(session.id, 'pairing_expired');
      json(res, 410, { error: 'pairing_expired' }, origin);
      return;
    }
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, { error: 'bad_request' }, origin);
      return;
    }
    const presented = String(body?.token ?? req.headers['x-session-token'] ?? '');
    if (!presented || !safeEqualHex(hash(presented), session.tokenHash)) {
      json(res, 403, { error: 'invalid_token' }, origin);
      return;
    }
    if (session.tokenRedeemed) {
      json(res, 409, { error: 'token_already_used' }, origin);
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
      origin
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

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const role = url.searchParams.get('role');
  const sessionId = url.searchParams.get('sid') ?? '';
  const credential = url.searchParams.get('ticket') ?? '';
  const session = sessions.get(sessionId);

  if (!/^\/(signal\/)?ws$/.test(url.pathname)) {
    try {
      ws.close(4004, 'bad_path');
    } catch {
      /* ignore */
    }
    return;
  }

  const fail = (reason) => {
    sendJson(ws, { type: 'error', reason });
    try {
      ws.close(4001, reason);
    } catch {
      /* ignore */
    }
  };

  if (role !== 'laptop' && role !== 'phone') return fail('bad_role');
  if (!session) return fail('unknown_session');
  if (Date.now() > session.expiresAt) {
    closeSession(session.id, 'pairing_expired');
    return fail('pairing_expired');
  }
  if (!credential) return fail('missing_ticket');

  if (role === 'laptop') {
    if (!safeEqualHex(hash(credential), session.tokenHash)) return fail('invalid_token');
    if (session.laptop) return fail('laptop_already_connected');
    session.laptop = { ws, role, ticketHash: '', connectedAt: Date.now() };
  } else {
    if (!session.phoneTicketHash) return fail('join_not_redeemed');
    if (!safeEqualHex(hash(credential), session.phoneTicketHash)) return fail('invalid_ticket');
    if (Date.now() > (session.phoneTicketExpiresAt ?? 0)) return fail('ticket_expired');
    if (session.phone) return fail('phone_already_connected');
    session.phone = { ws, role, ticketHash: session.phoneTicketHash, connectedAt: Date.now() };
  }

  session.lastActivity = Date.now();
  sendJson(ws, {
    type: 'ready',
    role,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    peerPresent: role === 'laptop' ? Boolean(session.phone) : Boolean(session.laptop),
  });

  // Notify the counterpart that a peer arrived.
  const counterpart = role === 'laptop' ? session.phone : session.laptop;
  if (counterpart) {
    sendJson(counterpart.ws, { type: 'peer_joined', role });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: 'error', reason: 'bad_json' });
      return;
    }
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
    if (role === 'laptop' && session.laptop?.ws === ws) session.laptop = null;
    if (role === 'phone' && session.phone?.ws === ws) session.phone = null;
    const other = role === 'laptop' ? session.phone : session.laptop;
    if (other && other.ws.readyState === other.ws.OPEN) {
      sendJson(other.ws, { type: 'peer_left', role });
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
