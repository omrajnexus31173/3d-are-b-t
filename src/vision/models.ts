/**
 * Model registry: which detection models exist, which traffic classes they can
 * genuinely detect, and where their weights are expected.
 *
 * IMPORTANT — no fabricated capability:
 * A generic COCO detector (YOLOv8n / YOLO11n) has classes person, bicycle, car,
 * motorcycle, bus, truck, cow ... but *no* pothole class. Pothole detection is
 * therefore reported as NOT CONFIGURED until the user installs a purpose-trained
 * model, and the UI shows that state explicitly.
 *
 * Weights are NOT bundled in the repository (they are 10-40 MB binaries).
 * `npm run setup:models` downloads them into `public/models/`.
 */
import { ModelClassSupport, ModelStatus, VisionClassId } from './types';

export type ModelBackend = 'onnxruntime-web' | 'tfjs';


export interface ModelDefinition {
  id: string;
  name: string;
  family: string;
  backend: ModelBackend;
  /** Path relative to the app base URL. */
  url: string;
  /** Alternative file names accepted when weights were placed manually. */
  altUrls?: string[];
  /**
   * Browser-only fallback used when ONNX Runtime Web cannot initialise in the
   * current environment (e.g. wasm instantiation blocked by policy).
   */
  fallback?: ModelDefinition;
  inputSize: number;
  labels: readonly string[];
  /** Format hint for the backend loader. */
  description: string;
  /** Env-var style override key documented in the README. */
  overrideKey: string;
  /**
   * Classes this model family is *architecturally* capable of, given its label
   * table. Actual availability still depends on the weights being installed.
   */
  supportedClasses: VisionClassId[];
  /** Classes this model can never provide regardless of installation. */
  unsupportedClasses: { classId: VisionClassId; note: string }[];
  /** Approximate download size, displayed in the setup UI. */
  approxBytes: number;
  /** Where to obtain it. */
  source: string;
}

const GENERIC_UNSUPPORTED = [
  {
    classId: 'pothole' as VisionClassId,
    note: 'COCO detection models have no pothole/road-damage class — use the pothole model adapter',
  },
  {
    classId: 'auto_rickshaw' as VisionClassId,
    note: 'COCO has no auto-rickshaw class; three-wheelers usually surface as "car"/"truck"',
  },
];

export const POTHOLE_UNSUPPORTED_FOR_GENERIC = GENERIC_UNSUPPORTED[0];

export const PRIMARY_MODEL: ModelDefinition = {
  id: 'yolo11n-coco',
  name: 'YOLO11n (COCO)',
  family: 'yolo11',
  backend: 'onnxruntime-web',
  url: 'models/yolo11n.onnx',
  altUrls: ['models/yolov8n.onnx', 'models/yolo11n-fp16.onnx'],
  inputSize: 640,
  labels: [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
    'toothbrush',
  ],
  description:
    'Ultralytics YOLO11n exported to ONNX (COCO-80). Person, bicycle, car, motorcycle, bus, truck and cow/animal classes.',
  overrideKey: 'VITE_YOLO_MODEL_URL',
  supportedClasses: [
    'pedestrian',
    'bicycle',
    'car',
    'motorcycle',
    'truck_bus',
    'cattle',
    'animal_other',
    'traffic_sign',
  ],
  unsupportedClasses: GENERIC_UNSUPPORTED,
  approxBytes: 10_700_000,
  source:
    'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n.onnx',
};

/** TF.js NanoDet-m fallback (COCO-80) — see src/vision/tfjsDetector.ts. */
export const FALLBACK_MODEL: ModelDefinition = {
  id: 'nanodet-m-tfjs',
  name: 'NanoDet-m (TF.js fallback)',
  family: 'nanodet',
  backend: 'tfjs',
  url: 'models/nanodet/model.json',
  inputSize: 416,
  labels: [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
    'toothbrush',
  ],
  description:
    'Browser fallback detector (TensorFlow.js). Same COCO-80 class set; used only when ONNX Runtime Web cannot start.',
  overrideKey: 'VITE_TFJS_MODEL_URL',
  supportedClasses: [
    'pedestrian',
    'bicycle',
    'car',
    'motorcycle',
    'truck_bus',
    'cattle',
    'animal_other',
    'traffic_sign',
  ],
  unsupportedClasses: GENERIC_UNSUPPORTED,
  approxBytes: 7_600_000,
  source: 'npm package @vladmandic/human-models (models/nanodet.json + nanodet.bin)',
};

PRIMARY_MODEL.fallback = FALLBACK_MODEL;

export const POTHOLE_MODEL: ModelDefinition = {
  id: 'pothole-custom',
  name: 'Pothole detector (custom)',
  family: 'yolo-custom',
  backend: 'onnxruntime-web',
  url: 'models/pothole.onnx',
  altUrls: ['models/pothole_yolo.onnx'],
  inputSize: 640,
  labels: ['pothole'],
  description:
    'Purpose-trained single-class road-damage detector. You must supply your own weights (see README "Pothole model").',
  overrideKey: 'VITE_POTHOLE_MODEL_URL',
  supportedClasses: ['pothole'],
  unsupportedClasses: [],
  approxBytes: 0,
  source: 'user-supplied (RDD2022 / custom pothole dataset)',
};

/** Optional fp16 / nanodet-style browser fallback (see README). */
export const ALL_MODELS: ModelDefinition[] = [PRIMARY_MODEL, POTHOLE_MODEL];

/** The model actually used when the primary backend is unavailable. */
export function withBackendOverride(
  def: ModelDefinition,
  backend: ModelBackend
): ModelDefinition {
  if (backend === 'onnxruntime-web') return def;
  if (def.fallback) return def.fallback;
  return def;
}

export function classSupportFor(
  def: ModelDefinition,
  installed: boolean,
  state: ModelStatus['state'],
  message?: string
): ModelClassSupport[] {
  const all: VisionClassId[] = [
    'pedestrian',
    'cattle',
    'animal_other',
    'car',
    'truck_bus',
    'auto_rickshaw',
    'motorcycle',
    'bicycle',
    'pothole',
    'traffic_sign',
  ];
  return all.map((classId) => {
    const unsupported = def.unsupportedClasses.find((u) => u.classId === classId);
    if (unsupported) {
      return {
        classId,
        label: classId,
        supported: false,
        note: unsupported.note,
      };
    }
    const capable = def.supportedClasses.includes(classId);
    if (!capable) {
      return { classId, label: classId, supported: false, note: 'not in this model label table' };
    }
    if (!installed || state === 'not_configured') {
      return {
        classId,
        label: classId,
        supported: false,
        note: message ?? `install ${def.url} (npm run setup:models)`,
      };
    }
    if (state === 'error') {
      return { classId, label: classId, supported: false, note: message ?? 'model failed to load' };
    }
    return { classId, label: classId, supported: true };
  });
}

export function blankModelStatus(def: ModelDefinition, message?: string): ModelStatus {
  return {
    id: def.id,
    name: def.name,
    family: def.family,
    url: def.url,
    state: 'not_configured',
    message: message ?? 'weights not installed',
    inputSize: def.inputSize,
    classCount: def.labels.length,
    classSupport: classSupportFor(def, false, 'not_configured', message),
  };
}

/** Directory that contains all weight assets for a definition. */
export function modelAssetUrl(def: ModelDefinition): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  return `${base}/${def.url.replace(/^\//, '')}`;
}

/** Model URL resolution honouring an operator override (build-time env). */
export function resolveModelUrl(def: ModelDefinition): string {
  const envValue = readEnv(def.overrideKey);
  if (envValue) return envValue;
  const base = import.meta.env.BASE_URL ?? '/';
  return `${base.replace(/\/$/, '')}/${def.url.replace(/^\//, '')}`;
}

function readEnv(key: string): string | undefined {
  try {
    const env = import.meta.env as unknown as Record<string, string | undefined>;
    const v = env?.[key];
    return v && v.trim().length > 0 ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Alternative URLs to probe when the primary weights are absent (dev convenience). */
export function resolveModelCandidates(def: ModelDefinition): string[] {
  const out: string[] = [];
  const envValue = readEnv(def.overrideKey);
  if (envValue) out.push(envValue);
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  out.push(`${base}/${def.url.replace(/^\//, '')}`);
  for (const alt of def.altUrls ?? []) out.push(`${base}/${alt.replace(/^\//, '')}`);
  return Array.from(new Set(out));
}
