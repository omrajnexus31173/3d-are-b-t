/**
 * Hybrid-perception types.
 *
 * We deliberately re-export the simulation types rather than redefining them,
 * so a `TrackedObject` produced by the simulation engine and one produced by the
 * camera adapter are structurally identical (and therefore interchangeable in
 * the existing telemetry components), while their provenance is carried by id
 * prefix + a parallel provenance list.
 */
export type {
  AgentClass,
  TrackedObject,
  SimLogEntry,
} from './simulation';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Which perception sources are contributing data in the current mode. */
export type PerceptionsSource = 'simulation' | 'camera';

export interface HybridPerceptionState {
  /** Objects from the simulation engine (ground truth driven). */
  simulated: import('./simulation').TrackedObject[];
  /** Objects from the live camera detector (image-space derived). */
  camera: import('./simulation').TrackedObject[];
  /** Aggregate only — per-object lists stay separate. */
  summary: {
    simulatedCount: number;
    cameraCount: number;
    criticalCount: number;
    highCount: number;
    vruCount: number;
    overallRisk: RiskLevel;
  };
}
