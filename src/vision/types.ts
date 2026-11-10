/**
 * BHARAT-AV — Real Camera / Computer Vision type contracts.
 *
 * These types are deliberately independent from `src/types/simulation.ts`.
 * The simulation data model describes ground-truth world state in metres;
 * camera perception is 2D image-space data whose metric values are either
 * measured, estimated or unknown. Adapters (see `hybrid.ts`) translate
 * between the two without pretending that one is the other.
 */

/** Where a frame came from. Never conflated with simulated sensors. */
export type CameraSourceKind = 'webcam' | 'usb_uvc' | 'mobile_webrtc';

/** Operating mode of the whole platform. */
export type OperatingMode = 'simulation' | 'camera' | 'hybrid';

/**
 * How trustworthy a numeric field is.
 * - measured  : from a calibrated sensor / explicit calibration
 * - estimated : derived from a heuristic (e.g. known object size)
 * - simulated : synthetic ground truth from the simulation engine
 * - unavailable: we do not know, and we say so
 */
export type ValueProvenance = 'measured' | 'estimated' | 'simulated' | 'unavailable';

export interface ProvenanceValue {
  value: number | null;
  provenance: ValueProvenance;
  /** Human readable explanation, shown in the UI. */
  basis?: string;
}

/** Traffic-semantics category used across camera + simulation. */
export type VisionClassId =
  | 'pedestrian'
  | 'cattle'
  | 'animal_other'
  | 'car'
  | 'truck_bus'
  | 'auto_rickshaw'
  | 'motorcycle'
  | 'bicycle'
  | 'pothole'
  | 'traffic_sign'
  | 'unknown';

/** Which sensor family produced a detection. Used to keep SIM and CAM separate. */
export type DetectionOrigin = 'camera' | 'simulation';

export interface BoundingBox {
  // Pixel coordinates in the *source frame* space (not the letterboxed model input).
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraDetection {
  /** Stable per-track id while the track lives, e.g. "CAM-7". */
  trackId: string;
  classId: VisionClassId;
  /** Raw model class label (e.g. "motorcycle" from COCO). */
  modelLabel: string;
  confidence: number;
  box: BoundingBox;
  /** Milliseconds since epoch when the frame was captured. */
  timestamp: number;
  /** Which camera produced this frame. */
  sourceId: string;
  sourceKind: CameraSourceKind;
  frameWidth: number;
  frameHeight: number;
  /** End-to-end processing time for this frame (pre + infer + post), ms. */
  processingMs: number;
  origin: DetectionOrigin;
  /**
   * Distance to the object. Camera-only distance is normally `unavailable`
   * unless a calibration / known-size estimate is configured.
   */
  distance: ProvenanceValue;
  /** Risk band derived from image-space geometry only (documented in risk.ts). */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Short explanation of why the risk band was chosen. */
  riskBasis: string;
}

export interface DetectionStats {
  /** Frames actually fed to the detector per second (rolling). */
  inferenceFps: number;
  /** Camera frames observed per second (rolling). */
  captureFps: number;
  /** Last inference latency in ms (pre + infer + post). */
  lastInferenceMs: number;
  avgInferenceMs: number;
  p95InferenceMs: number;
  /** Frames captured since start. */
  framesCaptured: number;
  /** Frames actually inferred since start. */
  framesInferred: number;
  /** Frames skipped because detection was throttled / busy. */
  framesSkipped: number;
  detectionCount: number;
  frameWidth: number;
  frameHeight: number;
}

export type ModelSupportLevel = 'ready' | 'not_configured' | 'loading' | 'error' | 'unsupported';

export interface ModelClassSupport {
  classId: VisionClassId;
  label: string;
  supported: boolean;
  /** Why a class is not supported (e.g. generic COCO model has no pothole class). */
  note?: string;
}

export interface ModelStatus {
  id: string;
  name: string;
  /** "yolov8" | "yolov11" | ... informational only. */
  family: string;
  /** Where the weights are expected. */
  url: string;
  /** Whether weights exist and were verified by the runtime. */
  state: ModelSupportLevel;
  /** Human readable message (errors, hints). */
  message?: string;
  inputSize: number;
  classCount: number;
  classSupport: ModelClassSupport[];
  loadMs?: number;
  /** Runtime execution provider actually used ("wasm" / "webgpu"). */
  executionProvider?: string;
  /** Model file size in bytes when known. */
  bytes?: number;
}

export interface DetectionFrame {
  detections: CameraDetection[];
  frameWidth: number;
  frameHeight: number;
  timestamp: number;
  sourceId: string;
  sourceKind: CameraSourceKind;
  stats: DetectionStats;
  /** null when no detector is active. */
  modelId: string | null;
}

export type CameraStatus =
  | 'idle'
  | 'requesting_permission'
  | 'connecting'
  | 'live'
  | 'error'
  | 'stopped';

export interface CameraError {
  code:
    | 'permission_denied'
    | 'no_device'
    | 'device_busy'
    | 'not_readable'
    | 'overconstrained'
    | 'security_context'
    | 'unsupported_browser'
    | 'signalling_unavailable'
    | 'pairing_expired'
    | 'peer_failed'
    | 'unknown';
  message: string;
  hint?: string;
}

export interface CameraCapability {
  width: number;
  height: number;
  /** Best frame rate the device reports for this mode, 0 when unknown. */
  maxFrameRate: number;
}

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
  kind: CameraSourceKind;
  groupId?: string;
  /**
   * Modes the device reports through `getCapabilities()`. Empty when the
   * browser does not expose capabilities (Safari, some Firefox builds) — in
   * that case the UI offers the common presets instead and the device decides.
   */
  capabilities?: CameraCapability[];
}

/** A selectable capture mode offered in the UI. */
export interface CameraResolutionOption {
  width: number;
  height: number;
  label: string;
  /** False when the device explicitly does not report this mode. */
  reported: boolean;
}

export interface DetectionConfig {
  /** Minimum confidence 0..1. */
  confidence: number;
  /** Max inferences per second (throttle). 0 = as fast as possible. */
  inferenceHz: number;
  /** IoU threshold for NMS. */
  nmsIou: number;
  /** Max detections kept per frame. */
  maxDetections: number;
  /** Enable IoU tracker. */
  tracking: boolean;
}
