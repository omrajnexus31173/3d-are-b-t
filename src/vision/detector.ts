/**
 * Pure (DOM-free) detection math: letterbox geometry, YOLO output decoding,
 * class-agnostic NMS and class mapping.
 *
 * Everything in this file is unit-testable in Node — see
 * `src/vision/__tests__/detector.test.ts`.
 */
import { BoundingBox, VisionClassId } from './types';

export interface LetterboxGeometry {
  /** Model input edge length (square input). */
  inputSize: number;
  /** Scale applied to the source frame. */
  scale: number;
  /** Padding, in model-input pixels. */
  padX: number;
  padY: number;
  /** Source frame size. */
  frameWidth: number;
  frameHeight: number;
  /** Size actually filled by the image inside the model input. */
  contentWidth: number;
  contentHeight: number;
}

/** Compute the letterbox geometry used to fit a frame into a square model input. */
export function computeLetterbox(
  frameWidth: number,
  frameHeight: number,
  inputSize: number
): LetterboxGeometry {
  const safeW = Math.max(1, frameWidth);
  const safeH = Math.max(1, frameHeight);
  const scale = Math.min(inputSize / safeW, inputSize / safeH);
  const contentWidth = safeW * scale;
  const contentHeight = safeH * scale;
  return {
    inputSize,
    scale,
    padX: (inputSize - contentWidth) / 2,
    padY: (inputSize - contentHeight) / 2,
    frameWidth: safeW,
    frameHeight: safeH,
    contentWidth,
    contentHeight,
  };
}

/** Map a box expressed in model-input pixels back into source-frame pixels. */
export function unletterboxBox(
  box: BoundingBox,
  geo: LetterboxGeometry,
  frameWidth = geo.frameWidth,
  frameHeight = geo.frameHeight
): BoundingBox {
  const scale = geo.scale || 1;
  const x = (box.x - geo.padX) / scale;
  const y = (box.y - geo.padY) / scale;
  const width = box.width / scale;
  const height = box.height / scale;
  // Clamp to the frame; keep a minimum 1px extent so boxes remain visible.
  const x0 = Math.max(0, Math.min(frameWidth - 1, x));
  const y0 = Math.max(0, Math.min(frameHeight - 1, y));
  const x1 = Math.max(x0 + 1, Math.min(frameWidth, x + width));
  const y1 = Math.max(y0 + 1, Math.min(frameHeight, y + height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface RawDetection {
  /** Model-space box (input pixels, top-left origin). */
  box: BoundingBox;
  /** Class index inside the model's label table. */
  classIndex: number;
  label: string;
  confidence: number;
}

export interface DecodeOptions {
  inputSize: number;
  labels: readonly string[];
  /** Minimum confidence. */
  threshold: number;
  /** Some exporters already apply sigmoid; detect via value range. Defaults to auto. */
  applySigmoid?: boolean;
}

type TensorLike = { dims: readonly number[]; data: Float32Array | number[] };

function toSortedDims(t: TensorLike): number[] {
  return Array.from(t.dims);
}

/** Swap (cx,cy,w,h) → (x,y,w,h). */
function cxcywhToXywh(cx: number, cy: number, w: number, h: number): BoundingBox {
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

function sigmoid(v: number): number {
  return 1 / (1 + Math.exp(-v));
}

/**
 * True when the probability vector looks like raw logits (any value outside
 * [-0.001, 1.001]) — then a sigmoid is required.
 */
function needsSigmoid(values: ArrayLike<number>, count: number, offset: number): boolean {
  for (let i = 0; i < count; i++) {
    const v = values[offset + i];
    if (v < -0.001 || v > 1.001) return true;
  }
  return false;
}

/**
 * Decode YOLOv8 / YOLO11 style detector output.
 *
 * Supported layouts:
 *  A. single tensor `[1, 4 + nc, N]` (Ultralytics default export)
 *  B. single tensor `[1, N, 4 + nc]`
 *  C. multiple tensors `[1, N_i, 5 + nc]` (YOLOv5/v7 style `x,y,w,h,obj,cls...`)
 *  D. multiple tensors `[1, N_i, 4 + nc]`
 *
 * Boxes are returned in model-input pixel coordinates.
 */
export function decodeYoloOutput(outputs: TensorLike[], opts: DecodeOptions): RawDetection[] {
  const { labels, threshold } = opts;
  const numClasses = labels.length;
  const results: RawDetection[] = [];

  for (const tensor of outputs) {
    const dims = toSortedDims(tensor);
    if (dims.length !== 3) continue;
    const [, d1, d2] = dims;
    const data = tensor.data;

    let numAnchors: number;
    let channels: number;
    let transposed: boolean;

    if (d1 === 4 + numClasses || d1 === 5 + numClasses) {
      // layout A / C-major: [1, C, N]
      channels = d1;
      numAnchors = d2;
      transposed = true;
    } else if (d2 === 4 + numClasses || d2 === 5 + numClasses) {
      channels = d2;
      numAnchors = d1;
      transposed = false;
    } else {
      continue;
    }

    const hasObjectness = channels === 5 + numClasses;
    const classOffset = hasObjectness ? 5 : 4;

    for (let a = 0; a < numAnchors; a++) {
      const at = (c: number) => (transposed ? data[c * numAnchors + a] : data[a * channels + c]);
      const cx = at(0);
      const cy = at(1);
      const w = at(2);
      const h = at(3);
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(w > 0) || !(h > 0)) continue;

      let obj = 1;
      if (hasObjectness) {
        obj = at(4);
        if (obj < -0.001 || obj > 1.001) obj = sigmoid(obj);
        if (obj < threshold) continue;
      }

      // Find best class. Use the auto-sigmoid rule once per anchor row.
      const rawScoresStart = transposed
        ? // class scores are strided across the anchor dimension
          Number.NaN
        : a * channels + classOffset;
      let useSigmoid = opts.applySigmoid ?? false;
      if (opts.applySigmoid === undefined && !Number.isNaN(rawScoresStart)) {
        useSigmoid = needsSigmoid(data, numClasses, rawScoresStart);
      }

      let bestIdx = -1;
      let bestScore = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        let score = at(classOffset + c);
        if (useSigmoid) score = sigmoid(score);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = c;
        }
      }
      if (bestIdx < 0) continue;
      const confidence = bestScore * obj;
      if (confidence < threshold) continue;

      results.push({
        box: cxcywhToXywh(cx, cy, w, h),
        classIndex: bestIdx,
        label: labels[bestIdx] ?? `class_${bestIdx}`,
        confidence,
      });
    }
  }

  return results;
}

export function iou(a: BoundingBox, b: BoundingBox): number {
  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = ix2 - ix1;
  const ih = iy2 - iy1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Per-class non-maximum suppression. Keeps output deterministic (sorted by
 * confidence, ties broken by original order) so tests and tracking are stable.
 */
export function nonMaxSuppression(
  dets: RawDetection[],
  iouThreshold: number,
  maxDetections: number
): RawDetection[] {
  const order = dets
    .map((d, i) => ({ d, i }))
    .sort((p, q) => q.d.confidence - p.d.confidence || p.i - q.i);

  const kept: RawDetection[] = [];
  const suppressed = new Set<number>();

  for (const { d, i } of order) {
    if (kept.length >= maxDetections) break;
    if (suppressed.has(i)) continue;
    kept.push(d);
    for (const other of order) {
      if (other.i === i || suppressed.has(other.i)) continue;
      if (other.d.classIndex !== d.classIndex) continue; // per-class NMS
      if (iou(d.box, other.d.box) > iouThreshold) suppressed.add(other.i);
    }
  }

  return kept;
}

/** COCO-80 labels in model order (Ultralytics YOLOv8/YOLO11 default training set). */
export const COCO_LABELS: readonly string[] = [
  'person',
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'traffic light',
  'fire hydrant',
  'stop sign',
  'parking meter',
  'bench',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'backpack',
  'umbrella',
  'handbag',
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard',
  'sports ball',
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard',
  'surfboard',
  'tennis racket',
  'bottle',
  'wine glass',
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl',
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli',
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake',
  'chair',
  'couch',
  'potted plant',
  'bed',
  'dining table',
  'toilet',
  'tv',
  'laptop',
  'mouse',
  'remote',
  'keyboard',
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink',
  'refrigerator',
  'book',
  'clock',
  'vase',
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
];

/** Mapping from a model label to a BHARAT-AV traffic class. */
export function mapLabelToVisionClass(label: string): VisionClassId {
  const l = label.trim().toLowerCase();
  switch (l) {
    case 'person':
    case 'pedestrian':
    case 'people':
      return 'pedestrian';
    case 'cow':
    case 'cattle':
    case 'bull':
    case 'buffalo':
      return 'cattle';
    case 'horse':
    case 'sheep':
    case 'dog':
    case 'goat':
    case 'elephant':
    case 'zebra':
    case 'giraffe':
    case 'cat':
    case 'bird':
    case 'animal':
      return 'animal_other';
    case 'car':
    case 'van':
    case 'suv':
      return 'car';
    case 'bus':
    case 'truck':
    case 'lorry':
      return 'truck_bus';
    case 'motorcycle':
    case 'motorbike':
    case 'bike':
    case 'scooter':
    case 'two_wheeler':
      return 'motorcycle';
    case 'bicycle':
    case 'cycle':
      return 'bicycle';
    case 'auto':
    case 'auto_rickshaw':
    case 'autorickshaw':
    case 'three_wheeler':
    case 'rickshaw':
      return 'auto_rickshaw';
    case 'pothole':
    case 'road_damage':
    case 'crater':
      return 'pothole';
    case 'traffic light':
    case 'stop sign':
    case 'traffic sign':
      return 'traffic_sign';
    default:
      return 'unknown';
  }
}

/**
 * Deterministic colour per traffic class (shared by HTML overlay and canvas).
 * Kept as Tailwind-ish hex values so the existing dark UI identity is preserved.
 */
export const VISION_CLASS_COLORS: Record<VisionClassId, string> = {
  pedestrian: '#F472B6',
  cattle: '#FB923C',
  animal_other: '#FDBA74',
  car: '#22D3EE',
  truck_bus: '#60A5FA',
  auto_rickshaw: '#FBBF24',
  motorcycle: '#34D399',
  bicycle: '#A3E635',
  pothole: '#C084FC',
  traffic_sign: '#FDE68A',
  unknown: '#94A3B8',
};

export const VISION_CLASS_LABELS: Record<VisionClassId, string> = {
  pedestrian: 'Pedestrian',
  cattle: 'Cattle',
  animal_other: 'Animal',
  car: 'Car',
  truck_bus: 'Truck / Bus',
  auto_rickshaw: 'Auto rickshaw',
  motorcycle: 'Motorcycle',
  bicycle: 'Bicycle',
  pothole: 'Pothole',
  traffic_sign: 'Traffic sign',
  unknown: 'Unclassified',
};
