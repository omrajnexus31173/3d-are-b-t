export type ScenarioId =
  | 'village_road'
  | 'urban_intersection'
  | 'highway_merge'
  | 'dense_market'
  | 'cattle_crossing'
  | 'infinite_drive';

/** True for experiences that never end (no goal line, no completion). */
export function isEndlessScenario(id: ScenarioId): boolean {
  return id === 'infinite_drive';
}

export type AgentClass =
  | 'car'
  | 'auto_rickshaw'
  | 'two_wheeler'
  | 'bus_truck'
  | 'pedestrian'
  | 'pushcart'
  | 'cattle'
  | 'pothole'
  | 'barricade';

export type AgentBehavior =
  | 'nominal_cruise'
  | 'oncoming'
  | 'slow_crawl'
  | 'informal_merge'
  | 'weaving_gap'
  | 'jaywalk_cross'
  | 'erratic_cattle'
  | 'wrong_way_edge'
  | 'stationary_encroach'
  | 'cross_traffic';

export type PlannerState =
  | 'CRUISE_NOMINAL'
  | 'ADAPTIVE_OVERTAKE'
  | 'YIELD_CREEP'
  | 'EMERGENCY_EVADE'
  | 'GOAL_REACHED';

export interface Vec2 {
  x: number;
  y: number;
}

export interface RoadSample {
  s: number; // arc length in meters
  x: number;
  y: number;
  theta: number; // tangent angle rad
  nx: number; // right normal x (-sin(theta))
  ny: number; // right normal y (cos(theta))
  leftWidth: number; // asphalt distance to left edge (> 0)
  rightWidth: number; // asphalt distance to right edge (> 0)
  shoulderLeft: number; // unpaved usable shoulder width on left
  shoulderRight: number; // unpaved usable shoulder width on right
  hasLaneMarks: boolean;
  /** Raised median width, 0 where there is none. Optional for backwards
   *  compatibility with the finite scenarios, which never use a median. */
  medianWidth?: number;
  /** Raised kerbed sidewalk width per side, 0 where there is none. */
  sidewalkWidth?: number;
}

export interface CrossRoadSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  label?: string;
}

export interface RoadProp {
  id: string;
  x: number;
  y: number;
  width: number;
  length: number;
  theta: number;
  kind: 'stall' | 'tree' | 'building' | 'divider' | 'sign_missing';
  label?: string;
}

export interface RoadAgent {
  id: string;
  trackId: string;
  agentClass: AgentClass;
  behavior: AgentBehavior;
  x: number;
  y: number;
  theta: number;
  speed: number; // m/s
  targetSpeed: number; // m/s
  vx: number;
  vy: number;
  length: number; // m
  width: number; // m
  isStatic: boolean;
  // Behavioral parameters for Indian irregular traffic
  nominalD: number; // Frenet offset if following road
  directionSign: 1 | -1; // +1 along s, -1 oncoming
  triggerDist?: number; // distance from ego when erratic behavior activates
  triggered?: boolean;
  crossAngle?: number;
  lateralDriftPhase?: number;
  waitTimer?: number;
  // Ground truth / script helpers
  mergeTargetD?: number;
  crossAxis?: 'north_south' | 'south_north' | 'diagonal_nw_se' | 'diagonal_sw_ne';
  colorHex: string;
  label: string;
}

export interface EgoVehicle {
  x: number;
  y: number;
  theta: number;
  speed: number; // m/s
  steerAngle: number; // rad (front wheel)
  accel: number; // m/s^2
  latAccel: number; // m/s^2
  jerk: number; // m/s^3
  wheelbase: number; // m
  length: number; // m
  width: number; // m
  maxSpeed: number; // m/s
  isBraking: boolean;
  blinker: 'none' | 'left' | 'right';
  s: number; // current road arc-length projection
  d: number; // current lateral offset (- left, + right)
}

export interface LidarHit {
  x: number;
  y: number;
  dist: number;
  angle: number;
  hitType: 'agent' | 'shoulder' | 'clear';
}

export interface TrackedObject {
  id: string;
  trackId: string;
  agentClass: AgentClass;
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  theta: number;
  length: number;
  width: number;
  dist: number;
  ttc: number; // seconds (Infinity if not closing)
  confidence: number; // 0..1 IDD perception confidence
  detectedBy: ('LiDAR' | 'Camera' | 'Radar')[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  behaviorHint: string;
  s: number;
  d: number;
}

export interface PredictedStep {
  t: number; // seconds ahead
  x: number;
  y: number;
  rx: number; // longitudinal uncertainty radius (m)
  ry: number; // lateral uncertainty radius (m)
  theta: number;
}

export interface AgentPrediction {
  trackId: string;
  agentClass: AgentClass;
  steps: PredictedStep[];
  entropyScore: number; // higher for cattle/pedestrians/auto-rickshaws
}

export interface TrajectoryPoint {
  x: number;
  y: number;
  theta: number;
  s: number;
  d: number;
  t: number;
  v: number;
  kappa: number; // curvature 1/m
}

export interface CandidateTrajectory {
  id: string;
  targetD: number;
  targetV: number;
  points: TrajectoryPoint[];
  totalCost: number;
  collisionCost: number;
  smoothnessCost: number;
  corridorCost: number;
  progressCost: number;
  feasible: boolean;
  isSelected: boolean;
  reasonTag: string;
}

export interface CorridorBoundary {
  leftPoints: Vec2[];
  rightPoints: Vec2[];
  centerPoints: Vec2[];
}

export interface PerceptionOutput {
  lidarHits: LidarHit[];
  trackedObjects: TrackedObject[];
  corridor: CorridorBoundary;
  sensorLatencyMs: number;
  cameraFovRad: number;
  cameraRangeM: number;
  lidarRangeM: number;
  radarRangeM: number;
}

export interface PlannerOutput {
  state: PlannerState;
  reason: string;
  selectedTrajectory: CandidateTrajectory | null;
  candidates: CandidateTrajectory[];
  replanLatencyMs: number;
  targetSpeed: number;
}

export interface TelemetryPoint {
  t: number;
  speedKmh: number;
  replanMs: number;
  jerk: number;
  minClearance: number;
  minTtc: number;
  curvature: number;
}

export interface SimLogEntry {
  id: number;
  simTime: number;
  level: 'INFO' | 'ADAPT' | 'WARN' | 'CRITICAL' | 'SUCCESS';
  tag: string;
  message: string;
}

export interface ScenarioDefinition {
  id: ScenarioId;
  code: string;
  title: string;
  shortTitle: string;
  description: string;
  roadType: string;
  keyChallenges: string[];
  speedLimitKmh: number;
  totalLengthM: number;
  roadSamples: RoadSample[];
  crossRoads: CrossRoadSegment[];
  props: RoadProp[];
  initialAgents: RoadAgent[];
  initialEgoS: number;
  initialEgoD: number;
  initialEgoSpeed: number;
  goalS: number;
  surfaceTint: string;
  terrainTint: string;
  shoulderTint: string;
}

export interface SimulationMetrics {
  simTime: number;
  progressPct: number;
  collisions: number;
  nearMisses: number; // clearance < 0.85m
  minClearanceM: number;
  minTtcS: number;
  meanReplanMs: number;
  p95ReplanMs: number;
  maxReplanMs: number;
  lastReplanMs: number;
  rmsJerk: number;
  meanCurvature: number;
  meanSpeedKmh: number;
  totalReplans: number;
  obstacleDetections: number;
  completed: boolean;
  passed: boolean;
}

export interface LayerVisibility {
  lidar: boolean;
  cameraFov: boolean;
  radar: boolean;
  predictions: boolean;
  candidates: boolean;
  corridor: boolean;
  labels: boolean;
}

export interface SensorNoiseConfig {
  weatherMode: 'clear' | 'monsoon_haze' | 'dust_glare';
  noiseMultiplier: number;
}

export interface ScenarioBenchmarkResult {
  scenarioId: ScenarioId;
  scenarioCode: string;
  title: string;
  completed: boolean;
  passed: boolean;
  collisions: number;
  nearMisses: number;
  durationS: number;
  meanSpeedKmh: number;
  minClearanceM: number;
  meanReplanMs: number;
  p95ReplanMs: number;
  rmsJerk: number;
  meanCurvature: number;
  progressPct: number;
  stateTransitions: number;
}

export interface SimulationState {
  scenario: ScenarioDefinition;
  ego: EgoVehicle;
  agents: RoadAgent[];
  perception: PerceptionOutput;
  predictions: AgentPrediction[];
  planner: PlannerOutput;
  metrics: SimulationMetrics;
  telemetryHistory: TelemetryPoint[];
  logs: SimLogEntry[];
  running: boolean;
  simSpeed: number;
  lidarSpinAngle: number;
  replanLatencies: number[];
  jerkSqSum: number;
  curvatureSum: number;
  speedSum: number;
  sampleCount: number;
  lastPlannerState: PlannerState;
  nextLogId: number;
  injectedCount: number;
  /**
   * Present only in endless experiences. The scenario's `roadSamples` is a live
   * window into this, refreshed every step, and `agents` is the active traffic
   * set that spawns ahead of the ego and despawns behind it.
   */
  roadWindow?: InfiniteRoadSnapshot;
}

export interface InfiniteRoadSnapshot {
  activeChunks: number;
  coveredLengthM: number;
  windowStartS: number;
  windowEndS: number;
  chunksGenerated: number;
  chunksRecycled: number;
  currentEnvironment: string;
  sceneryItems: number;
  hazardItems: number;
  seed: number;
  /** Traffic agents spawned / despawned so far. */
  vehiclesSpawned: number;
  vehiclesDespawned: number;
  activeAgents: number;
}
