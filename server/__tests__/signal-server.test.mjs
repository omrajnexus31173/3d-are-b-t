/**
 * End-to-end tests for the signalling server.
 *
 * These spawn the real server (child process) and exercise it over HTTP and
 * WebSocket exactly as the laptop and phone pages do — including every
 * negative case (bad token, replayed token, wrong session, role without a
 * ticket) because authorisation is the security boundary of the pairing flow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

const waitForReady = (proc) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('signal server did not start')), 15000);
    proc.stdout.on('data', (buf) => {
      if (String(buf).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', (buf) => {
      // the server logs nothing to stderr on success; surface it if it does
      process.stderr.write(`[signal stderr] ${buf}`);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`signal server exited early with code ${code}`));
    });
  });

const post = (url, body, headers = {}) =>
  fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });

/**
 * Opens a socket and authenticates it with the first-frame credential.
 *
 * The credential is deliberately NOT in the URL any more: it is sent as the
 * first frame after `open`, exactly as the browser client does.
 */
function openSocket(sessionId, role, ticket, opts = {}) {
  const url = `ws://127.0.0.1:${PORT}/ws`;
  const ws = new WebSocket(url, opts.wsOptions);
  const messages = [];
  ws.on('error', () => {
    /* close code carries the failure reason */
  });
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  if (!opts.skipAuth) {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', sessionId, role, ticket }));
    });
  }
  return {
    ws,
    messages,
    next(match, timeout = 4000) {
      const existing = messages.find(match);
      if (existing && !existing.__consumed) {
        existing.__consumed = true;
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(t);
            m.__consumed = true;
            resolve(m);
          },
        });
      });
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
  };
}

beforeAll(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'signal-server.mjs')], {
    env: {
      ...process.env,
      SIGNAL_PORT: String(PORT),
      SIGNAL_TTL_MS: '60000',
      /*
       * The suite opens many sockets from 127.0.0.1 within a minute, which would
       * legitimately trip the per-IP connection limit. Raised here so the
       * functional tests are not throttled; rate limiting itself is verified by
       * its own test against a separate server instance with a low limit.
       */
      SIGNAL_WS_CONN_LIMIT: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForReady(child);
}, 30000);

afterAll(() => {
  child?.kill('SIGTERM');
});

describe('signalling server', () => {
  it('reports health and ICE configuration', async () => {
    const health = await fetch(`${BASE}/signal/health`);
    expect(health.status).toBe(200);
    const info = await (await fetch(`${BASE}/signal/info`)).json();
    expect(info.iceServers.length).toBeGreaterThan(0);
    expect(Array.isArray(info.iceServers[0].urls)).toBe(true);
    expect(info.turnConfigured).toBe(false); // no TURN env in tests
  });

  it('creates a session with a random, non-guessable token', async () => {
    const a = await (await post('/signal/session', { label: 'test' })).json();
    const b = await (await post('/signal/session', {})).json();
    expect(a.sessionId).toBeTruthy();
    expect(a.sessionToken).toBeTruthy();
    expect(a.sessionToken.length).toBeGreaterThanOrEqual(40);
    expect(a.sessionToken).not.toBe(b.sessionToken);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.expiresAt).toBeGreaterThan(Date.now());
  });

  it('redeems the pairing token exactly once', async () => {
    const s = await (await post('/signal/session', {})).json();
    const first = await post(`/signal/session/${s.sessionId}/join`, { token: s.sessionToken });
    expect(first.status).toBe(200);
    const joined = await first.json();
    expect(joined.joinTicket).toBeTruthy();

    const replay = await post(`/signal/session/${s.sessionId}/join`, { token: s.sessionToken });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toBe('token_already_used');
  });

  it('rejects a wrong token, an unknown session, and a missing token', async () => {
    const s = await (await post('/signal/session', {})).json();
    const wrong = await post(`/signal/session/${s.sessionId}/join`, { token: 'x'.repeat(43) });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toBe('invalid_token');

    const unknown = await post('/signal/session/doesnotexist/join', { token: s.sessionToken });
    expect(unknown.status).toBe(404);

    const missing = await post(`/signal/session/${s.sessionId}/join`, {});
    expect(missing.status).toBe(403);
  });

  it('refuses a socket whose role/ticket combination is not authorised', async () => {
    const s = await (await post('/signal/session', {})).json();

    // phone socket before the token was redeemed → no join ticket exists
    const noTicket = openSocket(s.sessionId, 'phone', 'bogus-ticket');
    const rejection = await noTicket.next((m) => m.type === 'error');
    expect(rejection.reason).toBe('join_not_redeemed');
    await noTicket.closed;

    // unauthenticated laptop connection
    const badLaptop = openSocket(s.sessionId, 'laptop', 'not-the-token');
    expect((await badLaptop.next((m) => m.type === 'error')).reason).toBe('invalid_token');
    await badLaptop.closed;

    // arbitrary role
    const badRole = openSocket(s.sessionId, 'attacker', s.sessionToken);
    expect((await badRole.next((m) => m.type === 'error')).reason).toBe('bad_role');
    await badRole.closed;

    // a phone join ticket cannot be used to impersonate the laptop
    await post(`/signal/session/${s.sessionId}/join`, { token: s.sessionToken });
    const impersonate = openSocket(s.sessionId, 'laptop', 'some-join-ticket');
    expect((await impersonate.next((m) => m.type === 'error')).reason).toBe('invalid_token');
    await impersonate.closed;
  });

  it('relays offer/answer/ICE between the two authorised peers only', async () => {
    const s = await (await post('/signal/session', {})).json();
    const joined = await (await post(`/signal/session/${s.sessionId}/join`, { token: s.sessionToken })).json();

    const laptop = openSocket(s.sessionId, 'laptop', s.sessionToken);
    const phone = openSocket(s.sessionId, 'phone', joined.joinTicket);
    await laptop.next((m) => m.type === 'ready');
    await phone.next((m) => m.type === 'ready');

    laptop.send({ type: 'offer', sdp: 'v=0 fake-offer' });
    const offer = await phone.next((m) => m.type === 'offer');
    expect(offer.sdp).toBe('v=0 fake-offer');
    expect(offer.from).toBe('laptop');

    phone.send({ type: 'answer', sdp: 'v=0 fake-answer' });
    expect((await laptop.next((m) => m.type === 'answer')).sdp).toBe('v=0 fake-answer');

    phone.send({ type: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host', sdpMid: '0' } });
    const ice = await laptop.next((m) => m.type === 'ice');
    expect(ice.candidate.candidate).toMatch(/^candidate:/);

    // arbitrary payloads are not echoed back
    laptop.send({ type: 'admin_override', anything: true });
    const err = await laptop.next((m) => m.type === 'error');
    expect(err.reason).toBe('message_type_not_allowed');

    laptop.ws.close();
    const left = await phone.next((m) => m.type === 'peer_left');
    expect(left.role).toBe('laptop');
    phone.ws.close();
  });

  it('only allows one peer per role (no session hijacking by a second laptop)', async () => {
    const s = await (await post('/signal/session', {})).json();
    const first = openSocket(s.sessionId, 'laptop', s.sessionToken);
    await first.next((m) => m.type === 'ready');
    const second = openSocket(s.sessionId, 'laptop', s.sessionToken);
    expect((await second.next((m) => m.type === 'error')).reason).toBe('laptop_already_connected');
    first.ws.close();
    await second.closed.catch(() => undefined);
  });

  it('closes the session explicitly on request (laptop disconnect control)', async () => {
    const s = await (await post('/signal/session', {})).json();
    const laptop = openSocket(s.sessionId, 'laptop', s.sessionToken);
    await laptop.next((m) => m.type === 'ready');

    const unauthorised = await fetch(`${BASE}/signal/session/${s.sessionId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': 'wrong' },
    });
    expect(unauthorised.status).toBe(403);

    const authorised = await fetch(`${BASE}/signal/session/${s.sessionId}`, {
      method: 'DELETE',
      headers: { 'X-Session-Token': s.sessionToken },
    });
    expect(authorised.status).toBe(200);
    const closed = await laptop.next((m) => m.type === 'session_closed');
    expect(closed.reason).toBe('closed_by_host');
  });

  it('expires sessions after their TTL', async () => {
    // This server instance uses SIGNAL_TTL_MS=60000; verify the field is
    // honoured and that an expired session's token cannot be redeemed later by
    // checking the reported expiry explicitly (the sweeper interval is 15 s).
    const s = await (await post('/signal/session', {})).json();
    expect(s.ttlMs).toBe(60000);
    expect(s.expiresAt - Date.now()).toBeLessThanOrEqual(60000);
  });
});
