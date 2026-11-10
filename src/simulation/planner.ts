import {
  AgentPrediction,
  CandidateTrajectory,
  EgoVehicle,
  PlannerOutput,
  PlannerState,
  RoadSample,
  TrackedObject,
  TrajectoryPoint,
} from '../types/simulation';
import {
  approxObbDistance,
  clamp,
  frenetToWorld,
  lerp,
  normalizeAngle,
  sampleRoadAtS,
} from './roadMath';

const PLAN_HORIZON_S = 3.2;
const PLAN_DT = 0.2; // 16 steps
const NUM_STEPS = Math.round(PLAN_HORIZON_S / PLAN_DT);

function interpolatePrediction(
  pred: AgentPrediction | undefined,
  obj: TrackedObject,
  t: number
): { x: number; y: number; theta: number; rx: number; ry: number } {
  if (!pred || pred.steps.length === 0) {
    return {
      x: obj.x + obj.vx * t,
      y: obj.y + obj.vy * t,
      theta: obj.theta,
      rx: obj.length * 0.5 + 0.15 * t,
      ry: obj.width * 0.5 + 0.15 * t,
    };
  }
  const steps = pred.steps;
  if (t <= steps[0].t) {
    const ratio = t / Math.max(0.01, steps[0].t);
    return {
      x: lerp(obj.x, steps[0].x, ratio),
      y: lerp(obj.y, steps[0].y, ratio),
      theta: steps[0].theta,
      rx: lerp(obj.length * 0.5, steps[0].rx, ratio),
      ry: lerp(obj.width * 0.5, steps[0].ry, ratio),
    };
  }
  for (let i = 0; i < steps.length - 1; i++) {
    if (t <= steps[i + 1].t) {
      const ratio = (t - steps[i].t) / Math.max(0.01, steps[i + 1].t - steps[i].t);
      return {
        x: lerp(steps[i].x, steps[i + 1].x, ratio),
        y: lerp(steps[i].y, steps[i + 1].y, ratio),
        theta: steps[i + 1].theta,
        rx: lerp(steps[i].rx, steps[i + 1].rx, ratio),
        ry: lerp(steps[i].ry, steps[i + 1].ry, ratio),
      };
    }
  }
  const last = steps[steps.length - 1];
  const extraT = t - last.t;
  return {
    x: last.x + obj.vx * extraT * 0.7,
    y: last.y + obj.vy * extraT * 0.7,
    theta: last.theta,
    rx: last.rx + 0.15 * extraT,
    ry: last.ry + 0.15 * extraT,
  };
}

export function runAdaptivePlanner(
  ego: EgoVehicle,
  trackedObjects: TrackedObject[],
  predictions: AgentPrediction[],
  roadSamples: RoadSample[],
  speedLimitKmh: number,
  goalS: number,
  prevTargetD: number
): PlannerOutput {
  const tStart = performance.now();

  // Check goal completion
  if (ego.s >= goalS - 2.0) {
    return {
      state: 'GOAL_REACHED',
      reason: 'Destination corridor reached safely',
      selectedTrajectory: null,
      candidates: [],
      replanLatencyMs: Math.max(0.4, performance.now() - tStart),
      targetSpeed: 0,
    };
  }

  const predMap = new Map<string, AgentPrediction>();
  for (const p of predictions) predMap.set(p.trackId, p);

  const curSample = sampleRoadAtS(roadSamples, ego.s);
  const aheadSample = sampleRoadAtS(roadSamples, ego.s + 18);

  // Nominal Indian LHT cruise offset (left half of carriageway)
  const nominalD = -clamp(curSample.leftWidth * 0.46, 1.35, 2.45);
  const minDrivableD = -(
    Math.min(curSample.leftWidth, aheadSample.leftWidth) +
    curSample.shoulderLeft * 0.42 -
    ego.width * 0.5 -
    0.18
  );
  const maxDrivableD =
    Math.min(curSample.rightWidth, aheadSample.rightWidth) +
    curSample.shoulderRight * 0.25 -
    ego.width * 0.5 -
    0.18;

  // Modulate desired speed based on nearby VRU / erratic threats & road curvature
  const roadHeadingDiff = Math.abs(normalizeAngle(aheadSample.theta - curSample.theta));
  const curveCapMs = roadHeadingDiff > 0.22 ? 8.5 : 18.0;
  let desiredSpeedMs = Math.min(speedLimitKmh / 3.6, curveCapMs);

  let closestThreatTtc = Infinity;
  let closestFrontDist = Infinity;
  let hasOncomingRight = false;
  let primaryHazard: TrackedObject | null = null;

  for (const obj of trackedObjects) {
    const ds = obj.s - ego.s;
    if (ds > -3 && ds < 64) {
      if (obj.ttc < closestThreatTtc) {
        closestThreatTtc = obj.ttc;
        primaryHazard = obj;
      }
      if (ds > 0 && Math.abs(obj.d - ego.d) < 2.4 && ds < closestFrontDist) {
        closestFrontDist = ds;
        if (!primaryHazard) primaryHazard = obj;
      }
      // Check oncoming vehicle in right lane (+d) up to 64m ahead
      const headingDiff = Math.abs(normalizeAngle(obj.theta - curSample.theta));
      if (headingDiff > Math.PI * 0.62 && obj.d > -0.4 && ds > -2 && ds < 64) {
        hasOncomingRight = true;
      }
      // Caution near cattle or crossing pedestrians
      if (
        (obj.agentClass === 'cattle' || obj.agentClass === 'pedestrian') &&
        obj.dist < 26
      ) {
        desiredSpeedMs = Math.min(desiredSpeedMs, 6.0);
      }
    }
  }

  // Generate lateral target offsets across drivable corridor
  const lateralSamples = 13;
  const targetDs: number[] = [];
  for (let i = 0; i < lateralSamples; i++) {
    const ratio = i / (lateralSamples - 1);
    targetDs.push(lerp(minDrivableD, maxDrivableD, ratio));
  }
  // Ensure exact nominalD is included in candidates
  targetDs.push(nominalD);

  // Target speeds to sample
  const speedRatios = [1.0, 0.65, 0.28, 0.0];
  const candidateSpeeds = speedRatios.map((r) => desiredSpeedMs * r);

  // Filter nearby relevant obstacles once for speed
  const relevantObjects = trackedObjects.filter((o) => o.dist < 62);

  const candidates: CandidateTrajectory[] = [];
  const maxS = roadSamples[roadSamples.length - 1]?.s ?? goalS + 20;

  let candIdx = 0;
  for (let di = 0; di < targetDs.length; di++) {
    const targetD = targetDs[di];
    const dDelta = Math.abs(targetD - ego.d);
    const transDist = clamp(ego.speed * 1.05 + 5.5 + dDelta * 0.9, 8.0, 15.5);

    for (let vi = 0; vi < candidateSpeeds.length; vi++) {
      const targetV = candidateSpeeds[vi];
      const points: TrajectoryPoint[] = [];

      let simS = ego.s;
      let simD = ego.d;
      let simV = ego.speed;
      let prevX = ego.x;
      let prevY = ego.y;
      let prevTheta = ego.theta;

      let feasible = true;
      let collisionCost = 0;
      let smoothnessCost = 0;
      let corridorCost = 0;
      let minObsClearance = Infinity;

      const maxAccel = targetV >= simV ? 2.1 : targetV < 0.2 ? -5.8 : -3.4;

      for (let step = 1; step <= NUM_STEPS; step++) {
        const t = step * PLAN_DT;

        // Longitudinal speed evolution
        if (simV < targetV) {
          simV = Math.min(targetV, simV + maxAccel * PLAN_DT);
        } else if (simV > targetV) {
          simV = Math.max(targetV, simV + maxAccel * PLAN_DT);
        }
        simS = Math.min(maxS, simS + simV * PLAN_DT);

        // Quintic minimum-jerk lateral transition from ego.d to targetD
        const u = clamp((simS - ego.s) / transDist, 0, 1);
        const u3 = u * u * u;
        const quintic = u3 * (10 - 15 * u + 6 * u * u);
        simD = lerp(ego.d, targetD, quintic);

        const pose = frenetToWorld(roadSamples, simS, simD);
        // Tangent yaw includes lateral slope atan2(dd, ds)
        const dPrime =
          ((targetD - ego.d) * (30 * u * u * (1 - 2 * u + u * u))) /
          Math.max(1.0, transDist);
        const ptTheta = normalizeAngle(pose.theta + Math.atan(dPrime));

        const dsStep = Math.hypot(pose.x - prevX, pose.y - prevY);
        const dTheta = Math.abs(normalizeAngle(ptTheta - prevTheta));
        const kappa = dsStep > 0.08 ? dTheta / dsStep : 0;

        points.push({
          x: pose.x,
          y: pose.y,
          theta: ptTheta,
          s: simS,
          d: simD,
          t,
          v: simV,
          kappa,
        });

        // Smoothness penalty (curvature + lateral acceleration)
        smoothnessCost += kappa * kappa * 26 + simV * simV * kappa * 0.45;

        // Corridor boundary & Indian LHT compliance penalty
        const sample = pose.sample;
        const pavedLeft = -(sample.leftWidth - ego.width * 0.5);
        const pavedRight = sample.rightWidth - ego.width * 0.5;
        if (simD < pavedLeft) {
          // Using left mud shoulder -> soft penalty unless evading
          corridorCost += Math.pow(pavedLeft - simD, 2) * 14.0;
        }
        if (simD > pavedRight) {
          corridorCost += Math.pow(simD - pavedRight, 2) * 28.0;
        }
        // Oncoming right-side awareness penalty
        if (simD > 0.25) {
          corridorCost += (hasOncomingRight ? 18.0 : 3.2) * (simD - 0.25);
        }

        // Obstacle & Prediction Tube checks
        for (let oi = 0; oi < relevantObjects.length; oi++) {
          const obj = relevantObjects[oi];
          const pred = predMap.get(obj.trackId);
          const pObs = interpolatePrediction(pred, obj, t);

          if (obj.agentClass === 'pothole') {
            // Surface hazard: strong lateral steering repulsion, never emergency-stop lockup
            const potClearance = approxObbDistance(
              pose.x,
              pose.y,
              ptTheta,
              ego.length,
              ego.width,
              pObs.x,
              pObs.y,
              pObs.theta,
              obj.length + 0.4,
              obj.width + 0.4
            );
            if (potClearance < 0.8) {
              const pen = 0.8 - potClearance;
              collisionCost += 650 * pen * pen + (potClearance < 0 ? 1200 : 0);
            }
            continue;
          }

          // 1. Physical clearance check (for hard feasibility)
          const physMargin = 0.42;
          const physClearance = approxObbDistance(
            pose.x,
            pose.y,
            ptTheta,
            ego.length,
            ego.width,
            pObs.x,
            pObs.y,
            pObs.theta,
            obj.length + physMargin * 2,
            obj.width + physMargin * 2
          );

          if (physClearance < minObsClearance) {
            minObsClearance = physClearance;
          }

          if (physClearance < 0.0) {
            feasible = false;
            collisionCost += 14000 + Math.abs(physClearance) * 2800;
          }

          // 2. Soft uncertainty-tube potential field cost
          const tubeClearance = approxObbDistance(
            pose.x,
            pose.y,
            ptTheta,
            ego.length,
            ego.width,
            pObs.x,
            pObs.y,
            pObs.theta,
            pObs.rx * 2,
            pObs.ry * 2
          );

          const isVru =
            obj.agentClass === 'cattle' ||
            obj.agentClass === 'pedestrian' ||
            obj.agentClass === 'two_wheeler';
          const weight = isVru ? 44 : 24;

          if (tubeClearance < 1.55) {
            const pen = Math.max(0, 1.55 - tubeClearance);
            const timeDiscount = 1.0 / (1.0 + 0.3 * t);
            collisionCost += weight * pen * pen * timeDiscount;
          }
        }

        prevX = pose.x;
        prevY = pose.y;
        prevTheta = ptTheta;
      }

      // Reference LHT offset preference + temporal hysteresis against prevTargetD
      const refPenalty = Math.pow(targetD - nominalD, 2) * 3.6;
      const hystPenalty = Math.pow(targetD - prevTargetD, 2) * 6.2;
      corridorCost += refPenalty + hystPenalty;

      // Progress cost: favor maintaining desiredSpeedMs
      const speedDeficit = Math.max(0, desiredSpeedMs - targetV);
      const progressCost = speedDeficit * speedDeficit * 3.4;

      const totalCost = collisionCost + smoothnessCost + corridorCost + progressCost;

      let reasonTag = 'CRUISE';
      if (!feasible) reasonTag = 'COLLISION_REJECT';
      else if (targetV < 0.3) reasonTag = 'EMERGENCY_STOP';
      else if (targetV < desiredSpeedMs * 0.5) reasonTag = 'YIELD_CREEP';
      else if (Math.abs(targetD - nominalD) > 0.85) reasonTag = 'LATERAL_EVADE';

      candidates.push({
        id: `cand-${candIdx++}`,
        targetD,
        targetV,
        points,
        totalCost,
        collisionCost,
        smoothnessCost,
        corridorCost,
        progressCost,
        feasible,
        isSelected: false,
        reasonTag,
      });
    }
  }

  // Select best feasible trajectory; if none feasible, select minimum collisionCost emergency stop
  const feasibleCands = candidates.filter((c) => c.feasible);
  let selected: CandidateTrajectory;

  if (feasibleCands.length > 0) {
    feasibleCands.sort((a, b) => a.totalCost - b.totalCost);
    selected = feasibleCands[0];
  } else {
    // Emergency fallback: prioritize stopping / maximizing clearance
    const stopCands = candidates.filter((c) => c.targetV < 0.5);
    const pool = stopCands.length > 0 ? stopCands : candidates;
    pool.sort((a, b) => a.totalCost - b.totalCost);
    selected = pool[0];
  }

  selected.isSelected = true;

  // Determine high-level decision state & diagnostic reason
  let state: PlannerState = 'CRUISE_NOMINAL';
  let reason = 'Nominal LHT corridor tracking';

  const lateralShift = Math.abs(selected.targetD - nominalD);
  const speedRatio = selected.targetV / Math.max(0.5, desiredSpeedMs);

  if (!selected.feasible || selected.targetV < 0.4 || closestThreatTtc < 1.6) {
    state = 'EMERGENCY_EVADE';
    reason = primaryHazard
      ? `Emergency evasion / braking for ${primaryHazard.trackId} (${primaryHazard.agentClass.replace('_', ' ')}, TTC ${
          Number.isFinite(closestThreatTtc) ? closestThreatTtc.toFixed(1) + 's' : 'CLOSE'
        })`
      : 'Critical corridor conflict — emergency braking engaged';
  } else if (speedRatio < 0.55) {
    state = 'YIELD_CREEP';
    reason = primaryHazard
      ? `Yielding & creeping safely past ${primaryHazard.trackId} (${primaryHazard.behaviorHint.toLowerCase()})`
      : 'Narrow mixed-traffic corridor — adaptive speed yield';
  } else if (lateralShift > 0.78) {
    state = 'ADAPTIVE_OVERTAKE';
    const side = selected.targetD > nominalD ? 'right' : 'left shoulder';
    reason = primaryHazard
      ? `Adaptive ${side} corridor shift around ${primaryHazard.trackId} (${primaryHazard.agentClass.replace('_', ' ')})`
      : `Adaptive ${side} path offset (${selected.targetD.toFixed(1)}m)`;
  } else {
    state = 'CRUISE_NOMINAL';
    reason = 'Clear drivable corridor — smooth nominal cruise';
  }

  const replanLatencyMs = Math.max(0.9, performance.now() - tStart);

  return {
    state,
    reason,
    selectedTrajectory: selected,
    candidates,
    replanLatencyMs,
    targetSpeed: selected.targetV,
  };
}
