import { describe, expect, it } from 'vitest';
import {
  SignalConfigError,
  resolveSignalBaseUrl,
  signalSocketUrl,
  type SignalBaseInputs,
} from '../signalClient';

/**
 * Production signalling URL resolution.
 *
 * These test the pure resolver directly. The original production bug was
 * precisely a wrong fallback: in production the app silently used the Vite dev
 * proxy path `/signal-proxy/signal`, which only exists inside `vite dev` and
 * 404s on any static host.
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

describe('explicit production configuration', () => {
  it('uses VITE_SIGNAL_URL when provided', () => {
    expect(resolveSignalBaseUrl({ ...PROD, envUrl: 'https://signal.example.com' })).toBe(
      'https://signal.example.com'
    );
  });

  it('strips a trailing slash', () => {
    expect(resolveSignalBaseUrl({ ...PROD, envUrl: 'https://signal.example.com/' })).toBe(
      'https://signal.example.com'
    );
  });

  it('treats a blank value as unset', () => {
    expect(resolveSignalBaseUrl({ ...DEV, envUrl: '   ' })).toBe(
      'http://localhost:5173/signal-proxy/signal'
    );
  });

  it('accepts a path-prefixed service URL unchanged', () => {
    // Some deployments mount the service behind a path; the resolver must not
    // rewrite it (the server accepts /signal/... natively).
    expect(resolveSignalBaseUrl({ ...PROD, envUrl: 'https://example.com/signal' })).toBe(
      'https://example.com/signal'
    );
  });
});

describe('production without configuration', () => {
  it('throws SignalConfigError instead of using the dev proxy path', () => {
    expect(() => resolveSignalBaseUrl(PROD)).toThrow(SignalConfigError);
  });

  it('explains what to set and that it is build-time', () => {
    let message = '';
    try {
      resolveSignalBaseUrl(PROD);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/VITE_SIGNAL_URL/);
    expect(message).toMatch(/build/i);
    expect(message).toMatch(/https?:\/\//);
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

  it('is a SignalConfigError instance so the UI can distinguish it', () => {
    try {
      resolveSignalBaseUrl(PROD);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SignalConfigError);
      expect((err as Error).name).toBe('SignalConfigError');
    }
  });
});

describe('phone-supplied ?signal= parameter', () => {
  it('is honoured even in production (phone needs no build config)', () => {
    expect(
      resolveSignalBaseUrl({ ...PROD, signalParam: 'https://other.example.com' })
    ).toBe('https://other.example.com');
  });

  it('takes precedence over VITE_SIGNAL_URL', () => {
    // The phone must talk to whichever server issued its QR code.
    expect(
      resolveSignalBaseUrl({
        ...PROD,
        envUrl: 'https://signal.example.com',
        signalParam: 'https://other.example.com',
      })
    ).toBe('https://other.example.com');
  });

  it('normalises a bare host to the page protocol', () => {
    expect(resolveSignalBaseUrl({ ...PROD, signalParam: 'signal.example.com' })).toBe(
      'https://signal.example.com'
    );
  });

  it('strips a trailing slash', () => {
    expect(resolveSignalBaseUrl({ ...PROD, signalParam: 'https://signal.example.com/' })).toBe(
      'https://signal.example.com'
    );
  });

  it('does not bypass the production error when empty', () => {
    expect(() => resolveSignalBaseUrl({ ...PROD, signalParam: '' })).toThrow(SignalConfigError);
  });
});

describe('development fallback', () => {
  it('uses the Vite proxy path', () => {
    expect(resolveSignalBaseUrl(DEV)).toBe('http://localhost:5173/signal-proxy/signal');
  });

  it('keeps working without a browser (e.g. node)', () => {
    expect(
      resolveSignalBaseUrl({ envUrl: undefined, signalParam: null, isProd: false })
    ).toBe('http://localhost:8787');
  });
});

describe('WebSocket URL', () => {
  it('is a bare /ws URL with no query string', () => {
    const url = signalSocketUrl('https://signal.example.com');
    expect(url).toBe('wss://signal.example.com/ws');
    expect(url).not.toContain('?');
  });

  it('never contains a credential', () => {
    const url = signalSocketUrl('https://signal.example.com');
    expect(url).not.toMatch(/ticket|token|sid|role/);
  });

  it('upgrades http to ws', () => {
    expect(signalSocketUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/ws');
  });

  it('takes no credential argument at all', () => {
    // The signature changed deliberately so a future refactor cannot reintroduce
    // the query-string credential leak.
    expect(signalSocketUrl.length).toBeLessThanOrEqual(1);
  });

  it('preserves a path-prefixed base', () => {
    expect(signalSocketUrl('https://example.com/signal')).toBe('wss://example.com/signal/ws');
  });
});
