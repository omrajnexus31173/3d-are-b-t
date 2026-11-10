/**
 * Hybrid perception adapter.
 *
 * Bridges *real* camera detections into the *existing* simulation perception
 * types (`TrackedObject`, `TelemetryPoint`, log entries) so that the risk
 * analysis and UI can consume both worlds, while keeping provenance explicit.
 *
 * Design rules enforced here:
 *   1. A real camera detection never masquerades as a simulated ground-truth
 *      object: ids are prefixed `CAM-`, `detectedBy` only contains `Camera`,
 *      and every metric field that we cannot measure is left unusable
 *      (`dist = 0` is never reported — we use `Number.NaN`-free sentinels and an
 *      explicit provenance record instead).
 *   2. Simulated detections keep their own ids (`trackId` from the engine) and
 *      are never de-duplicated against camera detections: two different
 *      sensors observing different worlds must not be merged silently.
 *   3. Anything that *is* fused (counts, risk envelope) is labelled as fused.
 */
import type {
  AgentClass,
  PerceptionsSource,
  RiskLevel,
  SimLogEntry,
  TrackedObject,
} from '../types/hybrid';
import type { CameraDetection, VisionClassId } from './types';

export const CAMERA_ID_PREFIX = 'CAM-';

/** Map a camera traffic class onto the simulation's agent taxonomy. */
export function visionClassToAgentClass(classId: VisionClassId): AgentClass {
  switch (classId) {
    case 'pedestrian':
      return 'pedestrian';
    case 'cattle':
      return 'cattle';
    case 'animal_other':
      return 'cattle';
    case 'car':
      return 'car';
    case 'truck_bus':
      return 'bus_truck';
    case 'auto_rickshaw':
      return 'auto_rickshaw';
    case 'motorcycle':
      return 'two_wheeler';
    case 'bicycle':
      return 'two_wheeler';
    case 'pothole':
      return 'pothole';
    case 'traffic_sign':
      return 'barricade';
    default:
      return 'car';
  }
}

const RISK_ORDER: Record<RiskLevel, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * Convert camera detections into `TrackedObject`s that the existing telemetry
 * table / risk panel can render.
 *
 * IMPORTANT: the simulation `TrackedObject` is metre-based. For a monocular
 * camera we only have pixels, so:
 *   - `dist` is set to the *estimated* distance when calibration is available,
 *     otherwise to `Number.POSITIVE_INFINITY` (rendered as "—" by the UI).
 *   - `ttc` is always `Infinity` (unknown) for camera detections; we never
 *     invent a metric time-to-collision from pixel data.
 *   - `s`/`d` (Frenet coordinates of the simulated road) are 0 because a real
 *     camera is not on the simulated road. The UI hides those columns in
 *     camera/hybrid modes.
 */
export function cameraDetectionsToTrackedObjects(
  detections: CameraDetection[]
): TrackedObject[] {
  return detections.map((d) => {
    const distanceKnown = d.distance.provenance !== 'unavailable' && d.distance.value !== null;
    return {
      id: `${CAMERA_ID_PREFIX}${d.trackId}`,
      trackId: d.trackId,
      agentClass: visionClassToAgentClass(d.classId),
      x: d.box.x + d.box.width / 2,
      y: d.box.y + d.box.height,
      vx: 0,
      vy: 0,
      speed: 0,
      theta: 0,
      length: d.box.width,
      width: d.box.height,
      dist: distanceKnown ? (d.distance.value as number) : Number.POSITIVE_INFINITY,
      ttc: Number.POSITIVE_INFINITY,
      confidence: d.confidence,
      detectedBy: ['Camera'],
      riskLevel: d.riskLevel,
      behaviorHint:
        d.classId === 'pothole'
          ? 'ROAD DEFECT'
          : d.distance.provenance === 'estimated'
          ? 'CAM · EST RANGE'
          : 'CAM · RANGE UNKNOWN',
      s: 0,
      d: 0,
    };
  });
}

export interface PerceptionSummary {
  simulatedCount: number;
  cameraCount: number;
  fusedCount: number;
  criticalCount: number;
  highCount: number;
  vruCount: number;
  /** Highest risk across both worlds (never silently merged per-object). */
  overallRisk: RiskLevel;
  sources: PerceptionsSource[];
}

/**
 * Fused summary used by the sidebar when both worlds are present.
 * The per-object lists stay separate — only aggregate statistics are fused.
 */
export function summarisePerception(
  simulated: TrackedObject[],
  camera: TrackedObject[]
): PerceptionSummary {
  const all = [...simulated, ...camera];
  const criticalCount = all.filter((o) => o.riskLevel === 'CRITICAL').length;
  const highCount = all.filter((o) => o.riskLevel === 'HIGH').length;
  const vruCount = all.filter(
    (o) =>
      o.agentClass === 'pedestrian' || o.agentClass === 'cattle' || o.agentClass === 'two_wheeler'
  ).length;

  const overallRisk: RiskLevel = criticalCount > 0 ? 'CRITICAL' : highCount > 0 ? 'HIGH' : all.length ? 'MEDIUM' : 'LOW';

  const sources: PerceptionsSource[] = [];
  if (simulated.length || simulated.length === 0) sources.push('simulation');
  if (camera.length) sources.push('camera');

  return {
    simulatedCount: simulated.length,
    cameraCount: camera.length,
    fusedCount: all.length,
    criticalCount,
    highCount,
    vruCount,
    overallRisk,
    sources,
  };
}

/** Sort a mixed list with the highest risk first, preserving source identity. */
export function sortByRisk<T extends { riskLevel: RiskLevel }>(objects: T[]): T[] {
  return [...objects].sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]);
}

/** Build a simulation log entry for a camera-side event (same shape as engine logs). */
export function makeCameraLog(
  id: number,
  simTime: number,
  message: string,
  level: SimLogEntry['level'] = 'INFO'
): SimLogEntry {
  return { id, simTime, level, tag: 'CAMERA', message };
}
