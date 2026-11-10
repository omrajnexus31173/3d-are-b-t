/**
 * Monocular distance estimation.
 *
 * A single un-calibrated camera cannot measure metric distance. We therefore:
 *  1. Only report a number when the user has supplied calibration, and
 *  2. Tag every number with its provenance (`estimated`, never `measured`),
 *     and
 *  3. Fall back to `unavailable` (null) otherwise.
 *
 * The pinhole model used is the standard one used for ADAS monocular ranging:
 *
 *     Z = (f_px * H_real) / h_px
 *
 * where `f_px = f_mm / sensor_width_mm * frame_width_px` is derived from the
 * user's calibration (focal length + sensor width) or from a horizontal field
 * of view, `H_real` is the assumed real height of the object class, and `h_px`
 * is the observed pixel height of the bounding box.
 */
import { ProvenanceValue, VisionClassId } from './types';

export interface CameraCalibration {
  /** Focal length in millimetres. */
  focalLengthMm: number;
  /** Sensor width in millimetres (used to convert focal length to pixels). */
  sensorWidthMm: number;
}

/** A pragmatic set of priors for Indian mixed traffic (metres). */
export const CLASS_HEIGHT_PRIORS: Partial<Record<VisionClassId, { heightM: number; note: string }>> = {
  pedestrian: { heightM: 1.65, note: 'adult pedestrian standing height 1.65 m' },
  cattle: { heightM: 1.35, note: 'Indian cattle wither height ~1.35 m' },
  animal_other: { heightM: 0.8, note: 'generic animal 0.8 m' },
  car: { heightM: 1.5, note: 'hatchback/sedan body height ~1.5 m' },
  truck_bus: { heightM: 3.2, note: 'bus/lorry body height ~3.2 m' },
  motorcycle: { heightM: 1.1, note: 'rider height ~1.1 m above ground (approx.)' },
  bicycle: { heightM: 1.0, note: 'cyclist height ~1.0 m (approx.)' },
  auto_rickshaw: { heightM: 1.7, note: 'auto-rickshaw body height ~1.7 m' },
  traffic_sign: { heightM: 0.75, note: 'standard sign plate 0.75 m' },
};

export function focalLengthPx(
  calibration: CameraCalibration | null,
  frameWidthPx: number
): ProvenanceValue {
  if (!calibration || !(calibration.focalLengthMm > 0) || !(calibration.sensorWidthMm > 0)) {
    return { value: null, provenance: 'unavailable', basis: 'no calibration supplied' };
  }
  const f = (calibration.focalLengthMm / calibration.sensorWidthMm) * frameWidthPx;
  return {
    value: f,
    provenance: 'estimated',
    basis: `f=${calibration.focalLengthMm}mm, sensor=${calibration.sensorWidthMm}mm, ${Math.round(frameWidthPx)}px`,
  };
}

/**
 * Estimate distance to an object from its pixel height.
 * Always `estimated` — never presented as a measurement.
 */
export function estimateDistance(
  classId: VisionClassId,
  boxHeightPx: number,
  frameWidthPx: number,
  calibration: CameraCalibration | null
): ProvenanceValue {
  const prior = CLASS_HEIGHT_PRIORS[classId];
  if (!prior) {
    return {
      value: null,
      provenance: 'unavailable',
      basis: `no size prior for "${classId}"`,
    };
  }
  if (!(boxHeightPx > 2)) {
    return { value: null, provenance: 'unavailable', basis: 'box too small to range' };
  }
  const f = focalLengthPx(calibration, frameWidthPx);
  if (f.value === null) {
    return {
      value: null,
      provenance: 'unavailable',
      basis: 'monocular distance needs camera calibration (focal length + sensor width)',
    };
  }
  const z = (f.value * prior.heightM) / boxHeightPx;
  if (!Number.isFinite(z) || z <= 0) {
    return { value: null, provenance: 'unavailable', basis: 'degenerate geometry' };
  }
  return {
    value: Math.round(z * 10) / 10,
    provenance: 'estimated',
    basis: `Pinhole: (${f.value.toFixed(0)}px × ${prior.heightM}m) / ${boxHeightPx.toFixed(0)}px — ${prior.note}`,
  };
}

export interface RiskAssessment {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  basis: string;
}

/**
 * Image-space risk heuristic.
 *
 * This does NOT claim TTC. Without metric distance *and* relative velocity you
 * cannot compute a real TTC, so we expose a transparent, documented heuristic
 * built from what a monocular camera genuinely measures:
 *   - where the object is vertically in the frame (closer = lower),
 *   - how large it is relative to frame area,
 *   - whether the box is growing over time (approach) and how fast,
 *   - lateral proximity to the image centre (ego path proxy).
 *
 * The UI labels this as "image-space risk", never as a metric TTC.
 */
export function assessImageRisk(params: {
  classId: VisionClassId;
  box: { x: number; y: number; width: number; height: number };
  frameWidth: number;
  frameHeight: number;
  growthRatePerSec: number;
}): RiskAssessment {
  const { box, frameWidth, frameHeight, growthRatePerSec, classId } = params;
  const areaRatio = (box.width * box.height) / Math.max(1, frameWidth * frameHeight);
  const bottomY = (box.y + box.height) / Math.max(1, frameHeight);
  const centerX = (box.x + box.width / 2) / Math.max(1, frameWidth);
  const centerOffset = Math.abs(centerX - 0.5) * 2; // 0 centre, 1 edge

  // Vulnerable road users are weighted up: an ADAS stack must brake earlier for them.
  const vru = classId === 'pedestrian' || classId === 'cattle' || classId === 'animal_other';

  let score = 0;
  score += Math.min(1, areaRatio / 0.35) * 34; // size in frame
  score += Math.min(1, Math.max(0, bottomY - 0.45) / 0.55) * 26; // closeness in frame
  score += Math.min(1, Math.max(0, growthRatePerSec) / 0.6) * 28; // approach rate
  score += Math.max(0, 1 - centerOffset) * 12; // in ego path
  if (vru) score *= 1.18;

  const basis =
    `image-space: area ${(areaRatio * 100).toFixed(1)}%, bottom ${(bottomY * 100).toFixed(0)}%, ` +
    `approach ${growthRatePerSec >= 0 ? '+' : ''}${(growthRatePerSec * 100).toFixed(0)}%/s` +
    (vru ? ', VRU weight +18%' : '');

  if (score >= 62) return { riskLevel: 'CRITICAL', basis };
  if (score >= 42) return { riskLevel: 'HIGH', basis };
  if (score >= 24) return { riskLevel: 'MEDIUM', basis };
  return { riskLevel: 'LOW', basis };
}
