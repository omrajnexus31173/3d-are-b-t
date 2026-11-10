import {
  CorridorBoundary,
  EgoVehicle,
  LidarHit,
  PerceptionOutput,
  RoadAgent,
  RoadSample,
  SensorNoiseConfig,
  TrackedObject,
  Vec2,
} from '../types/simulation';
import {
  approxObbDistance,
  clamp,
  frenetToWorld,
  normalizeAngle,
  rayIntersectObb,
  worldToFrenet,
} from './roadMath';

const LIDAR_NUM_BEAMS = 80;
const LIDAR_RANGE_M = 46;
const CAMERA_FOV_RAD = (116 * Math.PI) / 180;
const CAMERA_RANGE_M = 45;
const RADAR_FOV_RAD = (46 * Math.PI) / 180;
const RADAR_RANGE_M = 64;

function deterministicNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function getBehaviorHint(agent: RoadAgent): string {
  switch (agent.behavior) {
    case 'erratic_cattle':
      return agent.triggered ? 'BOLTING ACROSS' : 'LOITERING VERGE';
    case 'informal_merge':
      return 'NO-SIGNAL MERGE';
    case 'wrong_way_edge':
      return 'WRONG-WAY HAZARD';
    case 'jaywalk_cross':
      return agent.triggered ? 'CROSSING ROAD' : 'EDGE PEDESTRIAN';
    case 'weaving_gap':
      return 'GAP WEAVING';
    case 'cross_traffic':
      return 'CROSS JUNCTION';
    case 'slow_crawl':
      return 'SLOW MOVING';
    case 'oncoming':
      return 'ONCOMING';
    case 'stationary_encroach':
      return agent.agentClass === 'pothole' ? 'SURFACE CRATER' : 'STATIC OBSTACLE';
    default:
      return 'CRUISING';
  }
}

export function runPerception(
  ego: EgoVehicle,
  agents: RoadAgent[],
  roadSamples: RoadSample[],
  simTime: number,
  noiseConfig: SensorNoiseConfig
): PerceptionOutput {
  const tStart = performance.now();
  const noiseScale = noiseConfig.noiseMultiplier;

  // 1. Pre-filter nearby agents within sensor envelope for O(k) raycasting
  const nearbyAgents = agents.filter((a) => {
    const d = Math.hypot(a.x - ego.x, a.y - ego.y);
    return d <= RADAR_RANGE_M + 8;
  });

  // 2. 360-degree LiDAR Raycasting (intersecting non-pothole OBBs + road outer boundary)
  const lidarHits: LidarHit[] = [];
  const lidarDetectedIds = new Set<string>();

  for (let i = 0; i < LIDAR_NUM_BEAMS; i++) {
    const relAngle = (i / LIDAR_NUM_BEAMS) * Math.PI * 2;
    const worldAngle = ego.theta + relAngle;
    const dx = Math.cos(worldAngle);
    const dy = Math.sin(worldAngle);

    let bestDist = LIDAR_RANGE_M;
    let hitType: LidarHit['hitType'] = 'clear';
    let hitAgentId: string | null = null;

    // Check agent OBB intersections (potholes are depressed below LiDAR plane -> camera detects potholes)
    for (let j = 0; j < nearbyAgents.length; j++) {
      const ag = nearbyAgents[j];
      if (ag.agentClass === 'pothole') continue;
      const dist = rayIntersectObb(
        ego.x,
        ego.y,
        dx,
        dy,
        bestDist,
        ag.x,
        ag.y,
        ag.theta,
        ag.length,
        ag.width
      );
      if (dist !== null && dist < bestDist) {
        bestDist = dist;
        hitType = 'agent';
        hitAgentId = ag.id;
      }
    }

    // Ray-march slightly to catch outer unpaved boundary / roadside wall when no vehicle hit earlier
    if (hitType === 'clear') {
      for (let r = 6; r <= LIDAR_RANGE_M; r += 3.5) {
        const px = ego.x + dx * r;
        const py = ego.y + dy * r;
        const proj = worldToFrenet(roadSamples, px, py, ego.s);
        const maxLeft = -(proj.sample.leftWidth + proj.sample.shoulderLeft);
        const maxRight = proj.sample.rightWidth + proj.sample.shoulderRight;
        if (proj.d < maxLeft || proj.d > maxRight) {
          bestDist = r;
          hitType = 'shoulder';
          break;
        }
      }
    }

    if (hitAgentId) {
      lidarDetectedIds.add(hitAgentId);
    }

    const jitter = deterministicNoise(i * 7.1 + simTime * 19.3) * 0.14 * noiseScale;
    const finalDist = clamp(bestDist + jitter, 0.5, LIDAR_RANGE_M);

    lidarHits.push({
      x: ego.x + dx * finalDist,
      y: ego.y + dy * finalDist,
      dist: finalDist,
      angle: worldAngle,
      hitType,
    });
  }

  // 3. Sensor Fusion: Camera (IDD semantic classes + potholes) + Radar (Doppler TTC) + LiDAR
  const trackedObjects: TrackedObject[] = [];

  for (let i = 0; i < nearbyAgents.length; i++) {
    const ag = nearbyAgents[i];
    const dx = ag.x - ego.x;
    const dy = ag.y - ego.y;
    const centerDist = Math.hypot(dx, dy);
    const bearing = normalizeAngle(Math.atan2(dy, dx) - ego.theta);
    const absBearing = Math.abs(bearing);

    const detectedBy: TrackedObject['detectedBy'] = [];
    if (lidarDetectedIds.has(ag.id) || (centerDist < 12 && ag.agentClass !== 'pothole')) {
      detectedBy.push('LiDAR');
    }
    if (absBearing <= CAMERA_FOV_RAD * 0.5 && centerDist <= CAMERA_RANGE_M) {
      detectedBy.push('Camera');
    }
    if (absBearing <= RADAR_FOV_RAD * 0.5 && centerDist <= RADAR_RANGE_M && ag.agentClass !== 'pothole') {
      detectedBy.push('Radar');
    }

    // Also keep backward close-proximity awareness (blind-spot / rear bumper sensors within 14m)
    if (detectedBy.length === 0 && centerDist < 14) {
      detectedBy.push('LiDAR');
    }

    if (detectedBy.length === 0) continue;

    // Surface clearance distance
    const clearance = Math.max(
      0,
      approxObbDistance(
        ego.x,
        ego.y,
        ego.theta,
        ego.length,
        ego.width,
        ag.x,
        ag.y,
        ag.theta,
        ag.length,
        ag.width
      )
    );

    // Relative closing rate along line of sight
    const egoVx = Math.cos(ego.theta) * ego.speed;
    const egoVy = Math.sin(ego.theta) * ego.speed;
    const relVx = egoVx - ag.vx;
    const relVy = egoVy - ag.vy;
    const ux = centerDist > 1e-4 ? dx / centerDist : 1;
    const uy = centerDist > 1e-4 ? dy / centerDist : 0;
    const closingSpeed = relVx * ux + relVy * uy;
    const ttc = closingSpeed > 0.35 ? clearance / closingSpeed : Infinity;

    const proj = worldToFrenet(roadSamples, ag.x, ag.y, ego.s);

    // Confidence modeled after IDD detector attenuated by fog/dust & range
    const baseConf =
      ag.agentClass === 'pothole'
        ? 0.87
        : ag.agentClass === 'cattle' || ag.agentClass === 'pedestrian'
        ? 0.91
        : 0.95;
    const rangePenalty = (centerDist / RADAR_RANGE_M) * 0.08 * noiseScale;
    const multiSensorBoost = detectedBy.length >= 2 ? 0.03 : -0.04;
    const confidence = clamp(baseConf - rangePenalty + multiSensorBoost, 0.72, 0.99);

    let riskLevel: TrackedObject['riskLevel'] = 'LOW';
    if (ttc < 1.8 || (clearance < 3.2 && absBearing < 0.75)) {
      riskLevel = 'CRITICAL';
    } else if (ttc < 3.4 || (clearance < 6.5 && absBearing < 1.0)) {
      riskLevel = 'HIGH';
    } else if (ttc < 6.0 || clearance < 14.0) {
      riskLevel = 'MEDIUM';
    }

    // Small measurement jitter for realism
    const measJitter = 0.05 * noiseScale;
    trackedObjects.push({
      id: ag.id,
      trackId: ag.trackId,
      agentClass: ag.agentClass,
      x: ag.x + deterministicNoise(i + simTime * 7) * measJitter,
      y: ag.y + deterministicNoise(i * 3 + simTime * 5) * measJitter,
      vx: ag.vx,
      vy: ag.vy,
      speed: ag.speed,
      theta: ag.theta,
      length: ag.length,
      width: ag.width,
      dist: clearance,
      ttc,
      confidence,
      detectedBy,
      riskLevel,
      behaviorHint: getBehaviorHint(ag),
      s: proj.s,
      d: proj.d,
    });
  }

  // Sort by risk priority (TTC / distance)
  trackedObjects.sort((a, b) => {
    const scoreA = (Number.isFinite(a.ttc) ? a.ttc : 30) + a.dist * 0.22;
    const scoreB = (Number.isFinite(b.ttc) ? b.ttc : 30) + b.dist * 0.22;
    return scoreA - scoreB;
  });

  // 4. Lane-free Drivable Corridor Estimation from local LiDAR shoulder + road perception
  const leftPoints: Vec2[] = [];
  const rightPoints: Vec2[] = [];
  const centerPoints: Vec2[] = [];
  const maxS = roadSamples[roadSamples.length - 1]?.s ?? 200;

  for (let ds = -8; ds <= 44; ds += 4) {
    const s = clamp(ego.s + ds, 0, maxS);
    const leftEdge = frenetToWorld(roadSamples, s, 0);
    const lOff = -(leftEdge.sample.leftWidth + leftEdge.sample.shoulderLeft * 0.45);
    const rOff = leftEdge.sample.rightWidth + leftEdge.sample.shoulderRight * 0.45;
    leftPoints.push({
      x: leftEdge.sample.x + lOff * leftEdge.sample.nx,
      y: leftEdge.sample.y + lOff * leftEdge.sample.ny,
    });
    rightPoints.push({
      x: leftEdge.sample.x + rOff * leftEdge.sample.nx,
      y: leftEdge.sample.y + rOff * leftEdge.sample.ny,
    });
    centerPoints.push({
      x: leftEdge.sample.x,
      y: leftEdge.sample.y,
    });
  }

  const corridor: CorridorBoundary = { leftPoints, rightPoints, centerPoints };
  const sensorLatencyMs = Math.max(0.8, performance.now() - tStart + 1.4 * noiseScale);

  return {
    lidarHits,
    trackedObjects,
    corridor,
    sensorLatencyMs,
    cameraFovRad: CAMERA_FOV_RAD,
    cameraRangeM: CAMERA_RANGE_M,
    lidarRangeM: LIDAR_RANGE_M,
    radarRangeM: RADAR_RANGE_M,
  };
}
