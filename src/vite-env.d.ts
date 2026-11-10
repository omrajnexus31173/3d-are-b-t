/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNAL_URL?: string;
  readonly VITE_YOLO_MODEL_URL?: string;
  readonly VITE_POTHOLE_MODEL_URL?: string;
  readonly VITE_TFJS_MODEL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
