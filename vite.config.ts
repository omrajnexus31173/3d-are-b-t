import path from 'path';
import { fileURLToPath } from 'url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import basicSsl from '@vitejs/plugin-basic-ssl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * BHARAT-AV Vite configuration.
 *
 * Notes
 *  - `viteSingleFile` inlines JS/CSS into dist/index.html so the existing
 *    deployment story (open one HTML file) keeps working.
 *  - Detection model weights and the ONNX Runtime wasm files deliberately stay
 *    as *separate* files in public/: they are fetched at runtime by the
 *    detection worker so the single-file bundle stays small. Fetching them
 *    requires the assets directory to be served alongside index.html.
 *  - A dev proxy forwards /signal-proxy → the signalling server so the browser
 *    never needs to know its URL (and so it works behind the preview host).
 *  - https is enabled when BHARAT_HTTPS=1 because getUserMedia requires a
 *    secure context on non-localhost origins (phones on the LAN).
 */
const signalPort = process.env.SIGNAL_PORT ?? '8787';
const useHttps = process.env.BHARAT_HTTPS === '1';
const enableSingleFile = process.env.BHARAT_SINGLEFILE !== '0';

const proxy = {
  '/signal-proxy': {
    target: `http://127.0.0.1:${signalPort}`,
    changeOrigin: true,
    ws: true,
    secure: false,
    rewrite: (p: string) => p.replace(/^\/signal-proxy/, ''),
  },
};

// Keep the single-file plugin from choking on the runtime-fetched assets.
const logger = createLogger();

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(useHttps ? [basicSsl()] : []),
    ...(enableSingleFile ? [viteSingleFile({ removeViteModuleLoader: true })] : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  customLogger: {
    ...logger,
    warn(msg, options) {
      // wasm/model files are thousands of KB by design; do not spam the build.
      if (/Some chunks are larger than/.test(msg)) return;
      logger.warn(msg, options);
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
    proxy,
    // The preview host proxies through e2b.app; allow it plus LAN origins.
    cors: true,
    headers: {
      'Permissions-Policy': 'camera=*, microphone=()',
    },
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PREVIEW_PORT ?? 4173),
    proxy,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
});
