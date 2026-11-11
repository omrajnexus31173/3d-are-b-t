import { describe, expect, it } from 'vitest';
import {
  SignalConfigError,
  normaliseSignalBase,
  resolveSignalBaseUrl,
  signalHealthUrl,
  signalSocketUrl,
  type SignalBaseInputs,
} from '../signalClient';

/**
 * Production signalling URL construction.
 *
 * These test the pure resolvers directly. The resolution rules exist because of
 * two real production failures, both silent:
 *
 *  1. A same-origin `/signal-proxy/signal` fallback — a Vite DEV proxy path that
 *     404s on any static host. Fixed by requiring explicit configuration in
 *     production.
 *  2. A bare origin in `VITE_SIGNAL_URL` producing `/health` instead of
 *     `/signal/health`. Every consumer appends a route to the base, so the base
 *     must include the `/signal` mount point. Fixed by normalising the value.
 */

const DEV: SignalBaseInputs = {
  envUrl: undefined,
  signalParam: null,
  isProd: false,
  origin: 'http://localhost:5173',
  protocol: 'http:',
};

const PROD: SignalBaseInputs = {
  envUrl: undefined,
  signalParam: null,
  isProd: true,
  origin: 'https://app.vercel.app',
  protocol: 'https:',
};

const RENDER = 'https://bharat-av-signaling.onrender.com';

// ---------------------------------------------------------------------------
// The reported production bug
// ---------------------------------------------------------------------------
describe('production health URL (reported 404)', () => {
  it('routes a bare origin to /signal/health, not /health', () => {
    // This is the exact failure from DevTools: the browser requested
    // https://…onrender.com/health and got 404 while /signal/health was 200.
    const base = resolveSignalBaseUrl({ ...PROD, envUrl: RENDER });
    expect(signalHealthUrl(base)).toBe(`${RENDER}/signal/health`);
    expect(signalHealthUrl(base)).not.toBe(`${RENDER}/health`);
  });

  it('routes an explicitly prefixed origin to the same health URL', () => {
    const base = resolveSignalBaseUrl({ ...PROD, envUrl: `${RENDER}/signal` });
    expect(signalHealthUrl(base)).toBe(`${RENDER}/signal/health`);
  });

  it('never produces a double /signal in the health URL', () => {
    for (const value of [RENDER, `${RENDER}/`, `${RENDER}/signal`, `${RENDER}/signal/`, `${RENDER}/signal/signal`]) {
      const health = signalHealthUrl(resolveSignalBaseUrl({ ...PROD, envUrl: value }));
      expect(health).toBe(`${RENDER}/signal/health`);
      expect(health).not.toContain('/signal/signal');
    }
  });

  it('keeps the session endpoints consistent with the health path', () => {
    // health and session are built from the same base; if one is right they
    // both are. Asserted explicitly because the bug looked health-specific.
    const base = resolveSignalBaseUrl({ ...PROD, envUrl: RENDER });
    expect(`${base}/session`).toBe(`${RENDER}/signal/session`);
    expect(`${base}/session/abc/join`).toBe(`${RENDER}/signal/session/abc/join`);
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
describe('normaliseSignalBase', () => {
  const cases: Array<[string, string]> = [
    [RENDER, `${RENDER}/signal`],
    [`${RENDER}/`, `${RENDER}/signal`],
    [`${RENDER}/signal`, `${RENDER}/signal`],
    [`${RENDER}/signal/`, `${RENDER}/signal`],
    [`${RENDER}/signal/signal`, `${RENDER}/signal`],
    [`${RENDER}/signal/signal/signal/`, `${RENDER}/signal`],
  ];

  it.each(cases)('normalises %s', (input, expected) => {
    expect(normaliseSignalBase(input)).toBe(expected);
  });

  it('leaves the development proxy path untouched', () => {
    // `/signal-proxy` must not be treated as a repeated mount point.
    const dev = 'http://localhost:5173/signal-proxy/signal';
    expect(normaliseSignalBase(dev)).toBe(dev);
  });

  it('appends the mount point to the local server default', () => {
    expect(normaliseSignalBase('http://localhost:8787')).toBe('http://localhost:8787/signal');
  });

  it('drops query strings and fragments pasted from a browser', () => {
    expect(normaliseSignalBase(`${RENDER}/signal?foo=1#bar`)).toBe(`${RENDER}/signal`);
  });

  it('preserves the protocol and port', () => {
    expect(normaliseSignalBase('http://192.168.1.20:8787')).toBe('http://192.168.1.20:8787/signal');
  });

  it('is idempotent', () => {
    const once = normaliseSignalBase(RENDER);
    expect(normaliseSignalBase(once)).toBe(once);
    expect(normaliseSignalBase(normaliseSignalBase(once))).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// Production WebSocket URL
// ---------------------------------------------------------------------------
describe('production WebSocket URL', () => {
  it('derives wss from the Render origin with the mount path', () => {
    const url = signalSocketUrl(resolveSignalBaseUrl({ ...PROD, envUrl: RENDER }));
    expect(url).toBe(`wss://bharat-av-signaling.onrender.com/signal/ws`);
  });

  it('gives the same socket URL for bare and prefixed configuration', () => {
    // A mismatch here would pair over HTTP but fail the socket, which is harder
    // to diagnose than a flat 404.
    const bare = signalSocketUrl(resolveSignalBaseUrl({ ...PROD, envUrl: RENDER }));
    const prefixed = signalSocketUrl(resolveSignalBaseUrl({ ...PROD, envUrl: `${RENDER}/signal` }));
    expect(bare).toBe(prefixed);
  });

  it('produces a URL the server accepts', () => {
    // The server accepts /ws and /signal/ws; assert we emit one of those.
    const url = new URL(signalSocketUrl(resolveSignalBaseUrl({ ...PROD, envUrl: RENDER })));
    expect(['/ws', '/signal/ws']).toContain(url.pathname);
  });

  it('carries no credential in the URL', () => {
    const url = signalSocketUrl(resolveSignalBaseUrl({ ...PROD, envUrl: RENDER }));
    expect(url).not.toContain('?');
    expect(url).not.toMatch(/ticket|token|sid|role/i);
  });

  it('upgrades http to ws in development', () => {
    expect(signalSocketUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/signal/ws');
  });

  it('keeps the development proxy base intact', () => {
    const url = signalSocketUrl('http://localhost:5173/signal-proxy/signal');
    expect(url).toBe('ws://localhost:5173/signal-proxy/signal/ws');
  });

  it('takes no credential argument at all', () => {
    // The signature changed deliberately so a future refactor cannot reintroduce
    // the query-string credential leak.
    expect(signalSocketUrl.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Explicit configuration
// ---------------------------------------------------------------------------
describe('explicit production configuration', () => {
  it('uses VITE_SIGNAL_URL when provided', () => {
    expect(resolveSignalBaseUrl({ ...PROD, envUrl: RENDER })).toBe(`${RENDER}/signal`);
  });

  it('treats a blank value as unset', () => {
    expect(resolveSignalBaseUrl({ ...DEV, envUrl: '   ' })).toBe(
      'http://localhost:5173/signal-proxy/signal'
    );
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------
describe('production without configuration', () => {
  it('throws SignalConfigError instead of using the dev proxy path', () => {
    expect(() => resolveSignalBaseUrl(PROD)).toThrow(SignalConfigError);
  });

  it('explains what to set, that it is build-time, and both accepted forms', () => {
    let message = '';
    try {
      resolveSignalBaseUrl(PROD);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/VITE_SIGNAL_URL/);
    expect(message).toMatch(/build/i);
    expect(message).toMatch(/https?:\/\//);
    expect(message).toContain('/signal');
  });

  it('never returns a /signal-proxy path in production', () => {
    let result = '';
    try {
      result = resolveSignalBaseUrl(PROD);
    } catch {
      result = '<threw>';
    }
    expect(result).not.toContain('signal-proxy');
  });
});

// ---------------------------------------------------------------------------
// Phone-supplied ?signal=
// ---------------------------------------------------------------------------
describe('phone-supplied ?signal= parameter', () => {
  it('is honoured even in production (phone needs no build config)', () => {
    expect(resolveSignalBaseUrl({ ...PROD, signalParam: RENDER })).toBe(`${RENDER}/signal`);
  });

  it('takes precedence over VITE_SIGNAL_URL', () => {
    // The phone must talk to whichever server issued its QR.
    expect(
      resolveSignalBaseUrl({
        ...PROD,
        envUrl: 'https://signal.example.com',
        signalParam: 'https://other.example.com',
      })
    ).toBe('https://other.example.com/signal');
  });

  it('normalises a bare host to the page protocol', () => {
    expect(resolveSignalBaseUrl({ ...PROD, signalParam: 'signal.example.com' })).toBe(
      'https://signal.example.com/signal'
    );
  });

  it('does not bypass the production error when empty', () => {
    expect(() => resolveSignalBaseUrl({ ...PROD, signalParam: '' })).toThrow(SignalConfigError);
  });
});

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------
describe('development fallback', () => {
  it('uses the Vite proxy path', () => {
    expect(resolveSignalBaseUrl(DEV)).toBe('http://localhost:5173/signal-proxy/signal');
  });

  it('keeps the proxy path free of a duplicated mount point', () => {
    // The proxy rewrites /signal-proxy → '', so the remaining path is
    // /signal/session. A second /signal here would 404 in development.
    const base = resolveSignalBaseUrl(DEV);
    expect(base).toBe('http://localhost:5173/signal-proxy/signal');
    expect(`${base}/session`).toBe('http://localhost:5173/signal-proxy/signal/session');
  });

  it('keeps working without a browser (e.g. node)', () => {
    expect(
      resolveSignalBaseUrl({ envUrl: undefined, signalParam: null, isProd: false })
    ).toBe('http://localhost:8787/signal');
  });
});
