/**
 * ONNX Runtime Web backend (primary detector runtime).
 *
 * Loaded lazily from `public/vendor/ort/` (copied by `npm run setup:models`) so
 * that the main bundle — which is inlined into a single HTML file — does not
 * carry a 10 MB wasm payload.
 *
 * Note on robustness: ORT Web can fail to initialise in some locked-down
 * browsers (wasm instantiation restrictions). We surface that as a typed error
 * so the caller can fall back to the TF.js backend instead of showing a broken
 * "detecting" state.
 */
import type * as OrtNamespace from 'onnxruntime-web';

export class OnnxUnavailableError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`ONNX Runtime Web unavailable: ${detail}`);
    this.name = 'OnnxUnavailableError';
    this.detail = detail;
  }
}

type OrtModule = typeof OrtNamespace;

let ortPromise: Promise<OrtModule> | null = null;

export interface OrtRuntimeInfo {
  version: string;
  wasmDirectory: string;
}

/**
 * Dynamically import ONNX Runtime Web. Uses a browser-native dynamic import of
 * the ESM build placed in `public/vendor/ort/ort.min.mjs`.
 */
export async function loadOrtRuntime(): Promise<OrtRuntimeInfo> {
  const ort = await getOrt();
  return {
    version: String(ort.env?.versions?.web ?? 'unknown'),
    wasmDirectory: wasmDirectory(),
  };
}

function wasmDirectory(): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return `${base}/vendor/ort/`;
}

async function getOrt(): Promise<OrtModule> {
  if (ortPromise) return ortPromise;
  ortPromise = (async () => {
    const dir = wasmDirectory();
    // @vite-ignore keeps this a runtime-only import (the file is not bundled).
    const mod = (await import(/* @vite-ignore */ `${dir}ort.min.mjs`)) as unknown as OrtModule;
    if (!mod || typeof mod.InferenceSession?.create !== 'function') {
      throw new OnnxUnavailableError('ort.min.mjs did not expose InferenceSession.create');
    }
    mod.env.wasm.wasmPaths = dir;
    mod.env.wasm.numThreads = 1;
    return mod;
  })();
  return ortPromise;
}

export interface OnnxSession {
  ort: OrtModule;
  session: OrtNamespace.InferenceSession;
  inputName: string;
  outputNames: string[];
}

/**
 * Create an inference session from raw model bytes.
 * Throws `OnnxUnavailableError` with a readable reason on failure.
 */
export async function createOnnxSession(bytes: Uint8Array): Promise<OnnxSession> {
  const ort = await getOrt();
  let session: OrtNamespace.InferenceSession;
  try {
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  } catch (err) {
    const detail =
      typeof err === 'number'
        ? `wasm runtime error code ${err} (WebAssembly initialisation blocked)`
        : err instanceof Error
        ? err.message
        : String(err);
    throw new OnnxUnavailableError(detail);
  }
  return {
    ort,
    session,
    inputName: session.inputNames[0],
    outputNames: Array.from(session.outputNames),
  };
}

/** Lightweight model metadata probe used by the model-status panel. */
export function describeSession(s: OnnxSession): { inputs: string[]; outputs: string[] } {
  return {
    inputs: Array.from(s.session.inputNames),
    outputs: Array.from(s.session.outputNames),
  };
}
