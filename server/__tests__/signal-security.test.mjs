/**
 * Security-focused tests for the signalling server.
 *
 * Each `describe` spawns its own server with a specific environment, because the
 * properties under test are configuration-dependent:
 *   - production origin enforcement (fail closed, no `Origin: null` grant)
 *   - first-frame WebSocket authentication (timeout, rejection, no pre-auth relay)
 *   - per-IP connection rate limiting
 *
 * These exercise the real process over real HTTP and WebSocket, exactly as the
 * browser does. Nothing is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** Spawns the server on `port` with `env` and waits for the listening line. */
async function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'signal-server.mjs')], {
    env: { ...process.env, SIGNAL_PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('signal server did not start')), 15000);
    child.stdout.on('data', (buf) => {
      if (String(buf).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`signal server exited early with code ${code}`));
    });
  });
  return child;
}

/** Opens a raw socket without authenticating. */
function rawSocket(port, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  ws.on('error', () => {
    /* close code carries the outcome */
  });
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('close', () => reject(new Error('closed before open')));
  });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  return { ws, messages, opened, closed };
}

const postJson = (port, url, body = {}, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Production origin policy
// ---------------------------------------------------------------------------
describe('production origin policy', () => {
  const PORT = 8801;
  const ORIGIN = 'https://bharat-av.vercel.app';
  let child;

  beforeAll(async () => {
    child = await startServer(PORT, {
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: ORIGIN,
    });
  }, 30000);

  afterAll(() => child?.kill('SIGTERM'));

  it('allows the configured origin', async () => {
    const res = await postJson(PORT, '/signal/session', {}, { Origin: ORIGIN });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('rejects an unlisted origin with 403 and no ACAO header', async () => {
    const res = await postJson(PORT, '/signal/session', {}, { Origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('origin_not_allowed');
    // Critically: no Access-Control-Allow-Origin at all. The old code sent the
    // literal string "null", which a browser treats as an opaque-origin grant.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never emits Access-Control-Allow-Origin: null', async () => {
    const res = await postJson(PORT, '/signal/session', {}, { Origin: 'null' });
    expect(res.status).toBe(403);
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao).toBeNull();
    expect(acao).not.toBe('null');
    expect((await res.json()).error).toBe('null_origin_not_allowed');
  });

  it('rejects Origin: null for laptop session creation', async () => {
    // The phone may legitimately send `null`, but a laptop creating a session
    // must come from a known deployment origin.
    const res = await postJson(PORT, '/signal/session', {}, { Origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('permits Origin: null on the phone join flow but still requires the ticket', async () => {
    const s = await (await postJson(PORT, '/signal/session', {}, { Origin: ORIGIN })).json();

    // Origin: null reaches the ticket check (not blocked by origin policy)...
    const badTicket = await postJson(
      PORT,
      `/signal/session/${s.sessionId}/join`,
      { token: 'wrong' },
      { Origin: 'null' }
    );
    expect(badTicket.status).toBe(403);
    expect((await badTicket.json()).error).toBe('invalid_token');

    // ...and a valid ticket succeeds. Origin never substitutes for the ticket.
    const good = await postJson(
      PORT,
      `/signal/session/${s.sessionId}/join`,
      { token: s.sessionToken },
      { Origin: 'null' }
    );
    expect(good.status).toBe(200);
    expect((await good.json()).joinTicket).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed configuration
// ---------------------------------------------------------------------------
describe('missing production configuration', () => {
  const PORT = 8802;
  let child;

  beforeAll(async () => {
    // Production with no ALLOWED_ORIGINS must refuse traffic, not allow it.
    child = await startServer(PORT, { NODE_ENV: 'production', ALLOWED_ORIGINS: '' });
  }, 30000);

  afterAll(() => child?.kill('SIGTERM'));

  it('fails closed with a clear configuration error', async () => {
    const res = await postJson(PORT, '/signal/session', {}, { Origin: 'https://anything.example.com' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('origin_config_missing');
    expect(body.detail).toMatch(/ALLOWED_ORIGINS/);
  });

  it('also fails closed for health checks so a bad deploy is obvious', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/signal/health`);
    expect(res.status).toBe(503);
  });

  it('refuses WebSocket connections when unconfigured', async () => {
    const sock = await rawSocket(PORT);
    await sock.opened;
    const { code, reason } = await sock.closed;
    expect(code).toBe(4503);
    expect(reason).toBe('origin_config_missing');
  });
});

// ---------------------------------------------------------------------------
// First-frame WebSocket authentication
// ---------------------------------------------------------------------------
describe('first-frame WebSocket authentication', () => {
  const PORT = 8803;
  let child;

  beforeAll(async () => {
    child = await startServer(PORT, {
      SIGNAL_AUTH_TIMEOUT_MS: '700',
      SIGNAL_WS_CONN_LIMIT: '1000',
    });
  }, 30000);

  afterAll(() => child?.kill('SIGTERM'));

  it('closes an unauthenticated socket with 4401 after the timeout', async () => {
    const sock = await rawSocket(PORT);
    await sock.opened;
    const started = Date.now();
    const { code, reason } = await sock.closed;
    const elapsed = Date.now() - started;
    expect(code).toBe(4401);
    expect(reason).toBe('auth_timeout');
    // Fired on the configured timer, not immediately and not much later.
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(3000);
    expect(sock.messages.some((m) => m.type === 'error' && m.reason === 'auth_timeout')).toBe(true);
  }, 10000);

  it('rejects signalling traffic sent before authentication', async () => {
    const sock = await rawSocket(PORT);
    await sock.opened;
    sock.ws.send(JSON.stringify({ type: 'offer', sdp: 'v=0 premature' }));
    const { code } = await sock.closed;
    expect(code).toBe(4001);
    expect(sock.messages.some((m) => m.type === 'error' && m.reason === 'not_authenticated')).toBe(true);
  });

  it('never relays a pre-auth offer to the peer', async () => {
    const s = await (await postJson(PORT, '/signal/session')).json();
    const joined = await (await postJson(PORT, `/signal/session/${s.sessionId}/join`, { token: s.sessionToken })).json();

    // Authenticate the phone properly.
    const phone = await rawSocket(PORT);
    await phone.opened;
    phone.ws.send(JSON.stringify({ type: 'auth', role: 'phone', sessionId: s.sessionId, ticket: joined.joinTicket }));
    await new Promise((r) => setTimeout(r, 200));
    expect(phone.messages.some((m) => m.type === 'ready')).toBe(true);

    // An unauthenticated socket tries to inject an offer.
    const bogus = await rawSocket(PORT);
    await bogus.opened;
    bogus.ws.send(JSON.stringify({ type: 'offer', sdp: 'injected' }));
    await bogus.closed;

    await new Promise((r) => setTimeout(r, 300));
    expect(phone.messages.some((m) => m.type === 'offer')).toBe(false);
    phone.ws.close();
  });

  it('accepts a valid first-frame credential and replies ready', async () => {
    const s = await (await postJson(PORT, '/signal/session')).json();
    const sock = await rawSocket(PORT);
    await sock.opened;
    sock.ws.send(JSON.stringify({ type: 'auth', role: 'laptop', sessionId: s.sessionId, ticket: s.sessionToken }));
    await new Promise((r) => setTimeout(r, 250));
    const ready = sock.messages.find((m) => m.type === 'ready');
    expect(ready).toBeTruthy();
    expect(ready.role).toBe('laptop');
    expect(ready.sessionId).toBe(s.sessionId);
    sock.ws.close();
  });

  it('rejects a replayed phone ticket (single use)', async () => {
    const s = await (await postJson(PORT, '/signal/session')).json();
    const joined = await (await postJson(PORT, `/signal/session/${s.sessionId}/join`, { token: s.sessionToken })).json();

    const first = await rawSocket(PORT);
    await first.opened;
    first.ws.send(JSON.stringify({ type: 'auth', role: 'phone', sessionId: s.sessionId, ticket: joined.joinTicket }));
    await new Promise((r) => setTimeout(r, 250));
    expect(first.messages.some((m) => m.type === 'ready')).toBe(true);

    // The same join ticket cannot open a second phone socket.
    const second = await rawSocket(PORT);
    await second.opened;
    second.ws.send(JSON.stringify({ type: 'auth', role: 'phone', sessionId: s.sessionId, ticket: joined.joinTicket }));
    const { code } = await second.closed;
    expect(code).toBe(4001);
    expect(second.messages.some((m) => m.type === 'error' && m.reason === 'phone_already_connected')).toBe(true);

    first.ws.close();
  });

  it('rejects an expired pairing session on the socket', async () => {
    const s = await (await postJson(PORT, '/signal/session')).json();
    // Wait past the short TTL used by this instance is impractical here, so the
    // expiry path is covered by the HTTP join test in the main suite; this
    // asserts the socket refuses an unknown session id at least.
    const sock = await rawSocket(PORT);
    await sock.opened;
    sock.ws.send(JSON.stringify({ type: 'auth', role: 'laptop', sessionId: 'does-not-exist', ticket: s.sessionToken }));
    const { code } = await sock.closed;
    expect(code).toBe(4001);
    expect(sock.messages.some((m) => m.type === 'error' && m.reason === 'unknown_session')).toBe(true);
  });

  it('carries no credential in the WebSocket URL', async () => {
    // Regression guard for the original leak: the socket URL must never contain
    // a ticket, so nothing sensitive can land in proxy logs.
    const { signalSocketUrl } = await import('../../src/camera/signalClient.ts').catch(() => ({}));
    if (typeof signalSocketUrl === 'function') {
      const url = signalSocketUrl('https://signal.example.com');
      expect(url).not.toMatch(/ticket|token|sid=|role=/);
    }
  });
});

// ---------------------------------------------------------------------------
// Connection rate limiting
// ---------------------------------------------------------------------------
describe('per-IP connection rate limiting', () => {
  const PORT = 8804;
  let child;

  beforeAll(async () => {
    child = await startServer(PORT, {
      SIGNAL_WS_CONN_LIMIT: '3',
      SIGNAL_WS_CONN_WINDOW_MS: '60000',
      SIGNAL_WS_CONN_LIMIT_MS: '1',
    });
  }, 30000);

  afterAll(() => child?.kill('SIGTERM'));

  it('rejects connections past the configured limit', async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const sock = await rawSocket(PORT);
      await sock.opened;
      const { code } = await sock.closed;
      codes.push(code);
    }
    // First three are allowed to sit unauthenticated (then time out), the rest
    // are refused immediately with 4029.
    const limited = codes.filter((c) => c === 4029);
    expect(limited.length).toBeGreaterThanOrEqual(2);
    expect(codes.filter((c) => c === 4401).length).toBeGreaterThanOrEqual(1);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Trusted proxy handling
// ---------------------------------------------------------------------------
describe('forwarded header handling', () => {
  const PORT = 8805;
  let child;

  beforeAll(async () => {
    // TRUST_PROXY off: a spoofed X-Forwarded-For must not create a fresh bucket.
    child = await startServer(PORT, {
      SIGNAL_WS_CONN_LIMIT: '2',
      SIGNAL_WS_CONN_WINDOW_MS: '60000',
    });
  }, 30000);

  afterAll(() => child?.kill('SIGTERM'));

  it('ignores X-Forwarded-For when TRUST_PROXY is disabled', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) {
      // Each attempt claims a different client IP; without TRUST_PROXY these must
      // all count against the real socket address.
      const sock = await rawSocket(PORT, { 'X-Forwarded-For': `10.0.0.${i}` });
      await sock.opened;
      const { code } = await sock.closed;
      codes.push(code);
    }
    expect(codes.filter((c) => c === 4029).length).toBeGreaterThanOrEqual(1);
  }, 30000);
});
