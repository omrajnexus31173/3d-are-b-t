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

export type ModelBackend = 'onnxruntime-web' | 'tfjs' | 'mediapipe';

/**
 * Detector the operator can choose.
 *
 * YOLO11n remains the default; D-FINE-N and MediaPipe are opt-in. Having one name
 * for this union keeps the engine, the hook and the panel from drifting apart -
 * previously each redeclared it as a literal union.
 */
export type DetectorId = 'yolo11n' | 'dfine-n' | 'mediapipe';

/**
 * ONNX I/O contract a model speaks.
 *
 * 'yolo'  - single `images` input, N outputs, decoded + NMS'd in the worker.
 * 'dfine' - `images` + int64 `orig_target_sizes` inputs; `labels`, `boxes`,
 *           `scores` outputs; NMS-free with the decoder inside the graph.
 *
 * Declared here for documentation and selection UI, but the worker re-detects
 * the contract from the session's own input names, so a mislabelled registry
 * entry cannot route a model down the wrong path.
 */
export type ModelOnnxFamily = 'yolo' | 'dfine';


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
  /** ONNX I/O contract. Defaults to 'yolo' when omitted. */
  onnxFamily?: ModelOnnxFamily;
  /**
   * Minimum confidence this model family needs to behave sanely.
   *
   * A DETR/D-FINE graph always emits `num_top_queries` rows (300) regardless of
   * scene content, so a YOLO-tuned threshold (~0.35) admits a large share of
   * low-scoring query slots that scatter across the frame. This floor is applied
   * when the detector is selected so the operator gets D-FINE's own operating
   * point rather than YOLO's. Omitted for YOLO, whose behaviour is unchanged.
   */
  minConfidence?: number;
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

/**
 * COCO-80 label table in contiguous 0..79 order.
 *
 * Shared by every COCO model here. D-FINE's deploy-mode postprocessor returns
 * `index % num_classes` BEFORE `remap_mscoco_category`, so its labels are
 * contiguous 0..79 rather than sparse 1..90 COCO category ids - the same
 * ordering this table already uses. One copy, so the two cannot drift apart.
 */
export const COCO_LABELS: readonly string[] = [
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
];

export const PRIMARY_MODEL: ModelDefinition = {
  id: 'yolo11n-coco',
  name: 'YOLO11n (COCO)',
  family: 'yolo11',
  backend: 'onnxruntime-web',
  url: 'models/yolo11n.onnx',
  altUrls: ['models/yolov8n.onnx', 'models/yolo11n-fp16.onnx'],
  inputSize: 640,
  labels: COCO_LABELS,
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

/**
 * D-FINE-N (COCO). Selectable alternative to YOLO11n - NOT the default.
 *
 * Needs a 2-input / 3-output ONNX graph exported by the D-FINE authors' own
 * `tools/deployment/export_onnx.py` (opset 16, decoder baked in). Install it
 * with `npm run setup:models -- --dfine` or drop the file at
 * `public/models/dfine_n_coco.onnx`.
 *
 * Deliberately not wired into PRIMARY_MODEL: if the asset is missing, YOLO11n
 * keeps working. `dfineAvailable()` gates the selection UI on presence.
 */
export const DFINE_MODEL: ModelDefinition = {
  id: 'dfine-n-coco',
  name: 'D-FINE-N (COCO)',
  family: 'dfine',
  backend: 'onnxruntime-web',
  url: 'models/dfine_n_coco.onnx',
  altUrls: ['models/dfine_n.onnx', 'models/model.onnx'],
  onnxFamily: 'dfine',
  /*
   * 0.5, not the 0.35 default. D-FINE's reference demo draws at 0.40
   * (onnx_inf.py `thrh=0.4`), and its 300 queries are NOT pre-filtered, so the
   * default must be at least as strict as the reference. 0.35 sits below the
   * reference operating point and is what produced an over-dense overlay.
   */
  minConfidence: 0.5,
  inputSize: 640,
  labels: COCO_LABELS,
  description:
    'D-FINE-N DETR-family detector, NMS-free, decoder inside the ONNX graph. ' +
    'Requires a 2-input (images + orig_target_sizes) / 3-output export.',
  overrideKey: 'VITE_DFINE_MODEL_URL',
  supportedClasses: [
    'pedestrian',
    'cattle',
    'animal_other',
    'car',
    'truck_bus',
    'motorcycle',
    'bicycle',
  ],
  unsupportedClasses: GENERIC_UNSUPPORTED,
  approxBytes: 12 * 1024 * 1024,
  source: 'D-FINE official release → tools/deployment/export_onnx.py (opset 16)',
};

/**
 * MediaPipe Tasks Vision + EfficientDet-Lite0 (COCO-80).
 *
 * Selectable alternative alongside YOLO11n and D-FINE-N; NOT the default, so a
 * deployment without the asset keeps working exactly as before.
 *
 * Chosen because MediaPipe does its own resize/normalise internally and returns
 * boxes in source-frame pixels - there is no letterbox to invert and no query
 * decode to get wrong. EfficientDet-Lite0 already NMS's inside the graph, so the
 * output is one box per object rather than a ranked query set.
 *
 * Assets are not committed (`.gitignore`: public/models, public/vendor). Install
 * with `npm run setup:models -- --only=mediapipe`.
 */
export const MEDIAPIPE_MODEL: ModelDefinition = {
  id: 'mediapipe-efficientdet-lite0',
  name: 'MediaPipe EfficientDet-Lite0',
  family: 'mediapipe',
  backend: 'mediapipe',
  url: 'models/efficientdet_lite0.tflite',
  altUrls: ['models/efficientdet_lite0_fp16.tflite'],
  /*
   * EfficientDet-Lite0 is 320x320 internally, but MediaPipe accepts any input
   * resolution and handles the scaling itself, so this is informational: nothing
   * in the MediaPipe path preprocesses to this size.
   */
  inputSize: 320,
  labels: COCO_LABELS,
  /*
   * 0.3 is the published MediaPipe sample's operating point. Safe to be lower
   * than the DETR thresholds because EfficientDet's output is already NMS'd -
   * a low cut adds genuine weak detections, not rows of background queries.
   */
  minConfidence: 0.3,
  description:
    'Google MediaPipe Tasks Vision ObjectDetector with EfficientDet-Lite0 (COCO-80). ' +
    'Handles its own preprocessing; boxes come back in source-frame pixels.',
  overrideKey: 'VITE_MEDIAPIPE_MODEL_URL',
  supportedClasses: [
    'pedestrian',
    'bicycle',
    'car',
    'motorcycle',
    'truck_bus',
    'cattle',
    'animal_other',
  ],
  unsupportedClasses: GENERIC_UNSUPPORTED,
  approxBytes: 4_500_000,
  source:
    'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite',
};

/** Optional fp16 / nanodet-style browser fallback (see README). */
export const ALL_MODELS: ModelDefinition[] = [
  PRIMARY_MODEL,
  DFINE_MODEL,
  MEDIAPIPE_MODEL,
  POTHOLE_MODEL,
];

/** The model actually used when the primary backend is unavailable. */
export function withBackendOverride(
  def: ModelDefinition,
  backend: ModelBackend
): ModelDefinition {
  if (backend === 'onnxruntime-web' || backend === 'mediapipe') return def;
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

/**
 * True when the D-FINE asset is actually installed. Used to gate the selection
 * UI so a missing optional model never looks like a broken app.
 */
export async function dfineAssetAvailable(): Promise<boolean> {
  if (readEnv('VITE_DFINE_MODEL_URL')) return true;
  try {
    const res = await fetch(resolveModelUrl(DFINE_MODEL), { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}
