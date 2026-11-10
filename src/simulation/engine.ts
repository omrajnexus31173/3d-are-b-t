import { runPerception } from './perception';
import { runAdaptivePlanner } from './planner';
import { predictAgentMotions } from './prediction';
import {
  approxObbDistance,
  clamp,
  frenetToWorld,
  lerp,
  lerpAngle,
  normalizeAngle,
  sampleRoadAtS,
  worldToFrenet,
} from './roadMath';
import { createRoadAgent, createScenario, SCENARIO_IDS } from './scenarios';
import {
  EgoVehicle,
  RoadAgent,
  RoadSample,
  ScenarioBenchmarkResult,
  ScenarioId,
  SensorNoiseConfig,
  SimLogEntry,
  SimulationState,
} from '../types/simulation';

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function createInitialSimulationState(
  scenarioId: ScenarioId,
  running = true
): SimulationState {
  const scenario = createScenario(scenarioId);
  const startPose = frenetToWorld(
    scenario.roadSamples,
    scenario.initialEgoS,
    scenario.initialEgoD
  );

  const ego: EgoVehicle = {
    x: startPose.x,
    y: startPose.y,
    theta: startPose.theta,
    speed: scenario.initialEgoSpeed,
    steerAngle: 0,
    accel: 0,
    latAccel: 0,
    jerk: 0,
    wheelbase: 2.75,
    length: 4.4,
    width: 1.9,
    maxSpeed: scenario.speedLimitKmh / 3.6,
    isBraking: false,
    blinker: 'none',
    s: scenario.initialEgoS,
    d: scenario.initialEgoD,
  };

  const agents = scenario.initialAgents.map((a) => ({ ...a }));
  const defaultNoise: SensorNoiseConfig = { weatherMode: 'clear', noiseMultiplier: 1.0 };

  const perception = runPerception(ego, agents, scenario.roadSamples, 0, defaultNoise);
  const predictions = predictAgentMotions(perception.trackedObjects, scenario.roadSamples);
  const planner = runAdaptivePlanner(
    ego,
    perception.trackedObjects,
    predictions,
    scenario.roadSamples,
    scenario.speedLimitKmh,
    scenario.goalS,
    ego.d
  );

  const initialLog: SimLogEntry = {
    id: 1,
    simTime: 0,
    level: 'INFO',
    tag: scenario.code,
    message: `Initialized ${scenario.title} — Multi-sensor fusion active (${perception.trackedObjects.length} tracks)`,
  };

  return {
    scenario,
    ego,
    agents,
    perception,
    predictions,
    planner,
    metrics: {
      simTime: 0,
      progressPct: 0,
      collisions: 0,
      nearMisses: 0,
      minClearanceM: 99,
      minTtcS: Infinity,
      meanReplanMs: planner.replanLatencyMs,
      p95ReplanMs: planner.replanLatencyMs,
      maxReplanMs: planner.replanLatencyMs,
      lastReplanMs: planner.replanLatencyMs,
      rmsJerk: 0,
      meanCurvature: 0,
      meanSpeedKmh: ego.speed * 3.6,
      totalReplans: 1,
      obstacleDetections: perception.trackedObjects.length,
      completed: false,
      passed: false,
    },
    telemetryHistory: [
      {
        t: 0,
        speedKmh: ego.speed * 3.6,
        replanMs: planner.replanLatencyMs,
        jerk: 0,
        minClearance: 15,
        minTtc: 10,
        curvature: 0,
      },
    ],
    logs: [initialLog],
    running,
    simSpeed: 1,
    lidarSpinAngle: 0,
    replanLatencies: [planner.replanLatencyMs],
    jerkSqSum: 0,
    curvatureSum: 0,
    speedSum: ego.speed * 3.6,
    sampleCount: 1,
    lastPlannerState: planner.state,
    nextLogId: 2,
    injectedCount: 0,
  };
}

function stepAgents(
  agents: RoadAgent[],
  ego: EgoVehicle,
  roadSamples: RoadSample[],
  dt: number,
  simTime: number
): void {
  const maxS = roadSamples[roadSamples.length - 1]?.s ?? 240;

  for (let i = 0; i < agents.length; i++) {
    const ag = agents[i];
    if (ag.isStatic) {
      ag.vx = 0;
      ag.vy = 0;
      ag.speed = 0;
      continue;
    }

    const distToEgo = Math.hypot(ag.x - ego.x, ag.y - ego.y);

    if (ag.behavior === 'erratic_cattle') {
      if (!ag.triggered && ag.triggerDist && distToEgo < ag.triggerDist) {
        ag.triggered = true;
        ag.waitTimer = 0;
      }
      if (ag.triggered) {
        ag.waitTimer = (ag.waitTimer ?? 0) + dt;
        const proj = worldToFrenet(roadSamples, ag.x, ag.y, ego.s);
        const crossDir = ag.crossAngle ?? 1.25;
        const targetHeading = proj.sample.theta + crossDir;
        ag.theta = lerpAngle(ag.theta, targetHeading, 4.5 * dt);
        const crossedSide = crossDir > 0 ? proj.d > proj.sample.rightWidth + 1.0 : proj.d < -(proj.sample.leftWidth + 1.0);
        if (crossedSide) {
          ag.speed = lerp(ag.speed, 0.0, 4.0 * dt);
        } else if (ag.waitTimer > 1.3 && ag.waitTimer < 1.85) {
          // Brief mid-road hesitation before clearing
          ag.speed = lerp(ag.speed, 0.55, 3.5 * dt);
        } else {
          ag.speed = lerp(ag.speed, 2.25, 3.8 * dt);
        }
        ag.vx = Math.cos(ag.theta) * ag.speed;
        ag.vy = Math.sin(ag.theta) * ag.speed;
        ag.x += ag.vx * dt;
        ag.y += ag.vy * dt;
      }
      continue;
    }

    if (ag.behavior === 'jaywalk_cross') {
      if (!ag.triggered && ag.triggerDist && distToEgo < ag.triggerDist) {
        ag.triggered = true;
      }
      if (ag.triggered) {
        const proj = worldToFrenet(roadSamples, ag.x, ag.y, ego.s);
        const targetHeading = proj.sample.theta + (ag.crossAngle ?? 1.35);
        ag.theta = lerpAngle(ag.theta, targetHeading, 5.0 * dt);
        if (Math.abs(proj.d) > proj.sample.rightWidth + 1.5) {
          ag.speed = lerp(ag.speed, 0, 4.0 * dt);
        } else {
          ag.speed = lerp(ag.speed, 1.45, 4.0 * dt);
        }
        ag.vx = Math.cos(ag.theta) * ag.speed;
        ag.vy = Math.sin(ag.theta) * ag.speed;
        ag.x += ag.vx * dt;
        ag.y += ag.vy * dt;
      }
      continue;
    }

    if (ag.behavior === 'cross_traffic') {
      if (!ag.triggered && ag.triggerDist && distToEgo < ag.triggerDist) {
        ag.triggered = true;
      }
      if (ag.triggered) {
        // Check proximity to ego to avoid suicide ramming while still asserting chaotic right-of-way
        if (distToEgo < 8.5 && ego.speed > 1.5) {
          ag.speed = lerp(ag.speed, ag.targetSpeed * 0.45, 2.5 * dt);
        } else {
          ag.speed = lerp(ag.speed, ag.targetSpeed, 2.0 * dt);
        }
        ag.vx = Math.cos(ag.theta) * ag.speed;
        ag.vy = Math.sin(ag.theta) * ag.speed;
        ag.x += ag.vx * dt;
        ag.y += ag.vy * dt;
      }
      continue;
    }

    // Road-following agents (cruise, slow_crawl, oncoming, weaving_gap, informal_merge, wrong_way_edge)
    const proj = worldToFrenet(roadSamples, ag.x, ag.y, ego.s);
    if (ag.behavior === 'informal_merge') {
      if (!ag.triggered && ag.triggerDist && distToEgo < ag.triggerDist) {
        ag.triggered = true;
      }
      if (ag.triggered && ag.mergeTargetD !== undefined) {
        ag.nominalD = lerp(ag.nominalD, ag.mergeTargetD, 0.9 * dt);
      }
    }

    let desiredD = ag.nominalD;
    if (ag.behavior === 'weaving_gap') {
      desiredD += Math.sin(simTime * 1.45 + (ag.lateralDriftPhase ?? 0)) * 0.85;
    } else if (ag.behavior === 'oncoming' && distToEgo < 32 && ego.d > -1.0) {
      desiredD += 0.45;
    }

    const lookS = clamp(proj.s + ag.directionSign * 8.0, 0, maxS);
    const lookPose = frenetToWorld(roadSamples, lookS, desiredD);
    const desiredHeading =
      ag.directionSign === 1
        ? Math.atan2(lookPose.y - ag.y, lookPose.x - ag.x)
        : Math.atan2(lookPose.y - ag.y, lookPose.x - ag.x);

    ag.theta = lerpAngle(ag.theta, desiredHeading, 3.8 * dt);
    ag.speed = lerp(ag.speed, ag.targetSpeed, 2.2 * dt);

    // Prevent road-following vehicles from running into the end beyond road bounds
    if (proj.s <= 2 && ag.directionSign === -1) ag.speed = 0;
    if (proj.s >= maxS - 2 && ag.directionSign === 1) ag.speed = 0;

    ag.vx = Math.cos(ag.theta) * ag.speed;
    ag.vy = Math.sin(ag.theta) * ag.speed;
    ag.x += ag.vx * dt;
    ag.y += ag.vy * dt;
  }
}

function stepEgo(
  ego: EgoVehicle,
  state: SimulationState,
  dt: number
): void {
  const { planner, scenario } = state;

  // Determine target waypoint from selected trajectory via Pure Pursuit
  const traj = planner.selectedTrajectory;
  let targetSteer = 0;
  let targetSpeed = planner.targetSpeed;

  if (planner.state === 'GOAL_REACHED' || !traj || traj.points.length === 0) {
    targetSpeed = 0;
    targetSteer = 0;
  } else {
    const lookaheadDist = clamp(ego.speed * 0.85 + 3.4, 3.6, 12.5);
    let lookPt = traj.points[traj.points.length - 1];
    for (let i = 0; i < traj.points.length; i++) {
      const d = Math.hypot(traj.points[i].x - ego.x, traj.points[i].y - ego.y);
      if (d >= lookaheadDist) {
        lookPt = traj.points[i];
        break;
      }
    }
    const dx = lookPt.x - ego.x;
    const dy = lookPt.y - ego.y;
    const dist = Math.max(0.5, Math.hypot(dx, dy));
    const alpha = normalizeAngle(Math.atan2(dy, dx) - ego.theta);
    targetSteer = clamp(
      Math.atan2(2 * ego.wheelbase * Math.sin(alpha), dist),
      -0.52,
      0.52
    );
  }

  // Smooth steering actuator dynamics
  const maxSteerDelta = 0.78 * dt;
  const steerDiff = clamp(targetSteer - ego.steerAngle, -maxSteerDelta, maxSteerDelta);
  ego.steerAngle += steerDiff;

  // Longitudinal speed controller
  const speedError = targetSpeed - ego.speed;
  const rawAccel = clamp(speedError * 2.2, -5.8, 2.2);
  ego.accel = lerp(ego.accel, rawAccel, clamp(6.5 * dt, 0, 1));
  ego.speed = clamp(ego.speed + ego.accel * dt, 0, ego.maxSpeed * 1.08);
  ego.isBraking = ego.accel < -0.55 || (targetSpeed < 0.3 && ego.speed < 0.8);

  // Kinematic bicycle model update
  const prevLatAccel = ego.latAccel;
  const yawRate = (ego.speed / ego.wheelbase) * Math.tan(ego.steerAngle);
  ego.theta = normalizeAngle(ego.theta + yawRate * dt);
  ego.x += Math.cos(ego.theta) * ego.speed * dt;
  ego.y += Math.sin(ego.theta) * ego.speed * dt;

  const instLatAccel = ego.speed * yawRate;
  ego.latAccel = lerp(prevLatAccel, instLatAccel, clamp(10.0 * dt, 0, 1));
  ego.jerk = clamp((ego.latAccel - prevLatAccel) / Math.max(1e-3, dt), -18, 18);

  const proj = worldToFrenet(scenario.roadSamples, ego.x, ego.y, ego.s);
  ego.s = proj.s;
  ego.d = proj.d;

  // Determine indicator blinker state
  const nominalD = -clamp(proj.sample.leftWidth * 0.46, 1.35, 2.45);
  const dOffset = traj ? traj.targetD - nominalD : 0;
  if (dOffset > 0.55) ego.blinker = 'right';
  else if (dOffset < -0.55) ego.blinker = 'left';
  else ego.blinker = 'none';
}

export function stepSimulation(
  state: SimulationState,
  dt: number,
  noiseConfig: SensorNoiseConfig
): void {
  if (state.metrics.completed) return;

  const { ego, agents, scenario } = state;

  // 1. Advance surrounding agents
  stepAgents(agents, ego, scenario.roadSamples, dt, state.metrics.simTime);

  // 2. Multi-sensor perception fusion
  state.perception = runPerception(
    ego,
    agents,
    scenario.roadSamples,
    state.metrics.simTime,
    noiseConfig
  );

  // 3. Irregular short-term motion prediction
  state.predictions = predictAgentMotions(
    state.perception.trackedObjects,
    scenario.roadSamples
  );

  // 4. Adaptive path replanning
  const prevTargetD = state.planner.selectedTrajectory?.targetD ?? ego.d;
  state.planner = runAdaptivePlanner(
    ego,
    state.perception.trackedObjects,
    state.predictions,
    scenario.roadSamples,
    scenario.speedLimitKmh,
    scenario.goalS,
    prevTargetD
  );

  // 5. Vehicle bicycle-model movement & control
  stepEgo(ego, state, dt);

  // 6. Update telemetry, clearance & collision checks
  state.metrics.simTime += dt;
  state.lidarSpinAngle = (state.lidarSpinAngle + dt * 10.5) % (Math.PI * 2);

  let stepMinClearance = Infinity;
  for (let i = 0; i < agents.length; i++) {
    const ag = agents[i];
    if (ag.agentClass === 'pothole') continue;
    const d = approxObbDistance(
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
    );
    if (d < stepMinClearance) stepMinClearance = d;

    if (d < 0.0) {
      state.metrics.collisions += 1;
    } else if (d < 0.35) {
      state.metrics.nearMisses += 1;
    }
  }

  let stepMinTtc = Infinity;
  for (const t of state.perception.trackedObjects) {
    if (t.ttc < stepMinTtc) stepMinTtc = t.ttc;
  }

  state.metrics.minClearanceM = Math.min(state.metrics.minClearanceM, stepMinClearance);
  state.metrics.minTtcS = Math.min(state.metrics.minTtcS, stepMinTtc);

  const replanMs = state.planner.replanLatencyMs;
  state.replanLatencies.push(replanMs);
  if (state.replanLatencies.length > 400) state.replanLatencies.shift();

  const sumReplan = state.replanLatencies.reduce((acc, v) => acc + v, 0);
  state.metrics.lastReplanMs = replanMs;
  state.metrics.meanReplanMs = sumReplan / state.replanLatencies.length;
  state.metrics.p95ReplanMs = computePercentile(state.replanLatencies, 95);
  state.metrics.maxReplanMs = Math.max(state.metrics.maxReplanMs, replanMs);
  state.metrics.totalReplans += 1;
  state.metrics.obstacleDetections = state.perception.trackedObjects.length;

  // Smoothness & curvature running stats
  const curKappa = Math.abs(Math.tan(ego.steerAngle) / ego.wheelbase);
  state.jerkSqSum += ego.jerk * ego.jerk;
  state.curvatureSum += curKappa;
  state.speedSum += ego.speed * 3.6;
  state.sampleCount += 1;

  state.metrics.rmsJerk = Math.sqrt(state.jerkSqSum / state.sampleCount);
  state.metrics.meanCurvature = state.curvatureSum / state.sampleCount;
  state.metrics.meanSpeedKmh = state.speedSum / state.sampleCount;

  const progress = clamp(
    ((ego.s - scenario.initialEgoS) / (scenario.goalS - scenario.initialEgoS)) * 100,
    0,
    100
  );
  state.metrics.progressPct = progress;

  if (state.planner.state === 'GOAL_REACHED' || ego.s >= scenario.goalS - 2.0) {
    state.metrics.completed = true;
    state.metrics.progressPct = 100;
    state.metrics.passed = state.metrics.collisions === 0;
  }

  // Record sparkline telemetry every ~0.15s
  const lastTel = state.telemetryHistory[state.telemetryHistory.length - 1];
  if (!lastTel || state.metrics.simTime - lastTel.t >= 0.14) {
    state.telemetryHistory.push({
      t: state.metrics.simTime,
      speedKmh: ego.speed * 3.6,
      replanMs,
      jerk: Math.abs(ego.jerk),
      minClearance: Math.min(20, Math.max(0, stepMinClearance)),
      minTtc: Number.isFinite(stepMinTtc) ? Math.min(12, stepMinTtc) : 12,
      curvature: curKappa,
    });
    if (state.telemetryHistory.length > 90) state.telemetryHistory.shift();
  }

  // Event logs on planner state changes
  if (state.planner.state !== state.lastPlannerState) {
    const lvl: SimLogEntry['level'] =
      state.planner.state === 'EMERGENCY_EVADE'
        ? 'CRITICAL'
        : state.planner.state === 'YIELD_CREEP'
        ? 'WARN'
        : state.planner.state === 'ADAPTIVE_OVERTAKE'
        ? 'ADAPT'
        : state.planner.state === 'GOAL_REACHED'
        ? 'SUCCESS'
        : 'INFO';

    state.logs.unshift({
      id: state.nextLogId++,
      simTime: state.metrics.simTime,
      level: lvl,
      tag: state.planner.state,
      message: state.planner.reason,
    });
    if (state.logs.length > 40) state.logs.pop();
    state.lastPlannerState = state.planner.state;
  }
}

export type HazardInjectionType = 'cattle' | 'pedestrian' | 'auto_merge' | 'pothole';

export function injectDynamicHazard(
  state: SimulationState,
  kind: HazardInjectionType
): void {
  const { scenario, ego } = state;
  const maxS = scenario.roadSamples[scenario.roadSamples.length - 1]?.s ?? 230;
  const spawnS = clamp(ego.s + 26, ego.s + 14, maxS - 8);
  const curSample = sampleRoadAtS(scenario.roadSamples, spawnS);

  let newAgent: RoadAgent;
  let logMsg = '';

  if (kind === 'cattle') {
    newAgent = createRoadAgent(scenario.roadSamples, {
      agentClass: 'cattle',
      behavior: 'erratic_cattle',
      s: spawnS,
      d: -(curSample.leftWidth + 0.5),
      speedKmh: 0,
      triggerDist: 34,
      crossAngle: 1.25,
    });
    logMsg = `Injected sudden stray cattle at s=${spawnS.toFixed(0)}m ahead`;
  } else if (kind === 'pedestrian') {
    newAgent = createRoadAgent(scenario.roadSamples, {
      agentClass: 'pedestrian',
      behavior: 'jaywalk_cross',
      s: spawnS - 3,
      d: -(curSample.leftWidth + 0.2),
      speedKmh: 4.5,
      triggerDist: 30,
      crossAngle: 1.35,
    });
    logMsg = `Injected sudden jaywalker crossing at s=${(spawnS - 3).toFixed(0)}m`;
  } else if (kind === 'auto_merge') {
    newAgent = createRoadAgent(scenario.roadSamples, {
      agentClass: 'auto_rickshaw',
      behavior: 'informal_merge',
      s: spawnS,
      d: -(curSample.leftWidth + 0.4),
      speedKmh: 20,
      triggerDist: 36,
      mergeTargetD: ego.d,
    });
    logMsg = `Injected informal merging auto-rickshaw (no indicator) at s=${spawnS.toFixed(0)}m`;
  } else {
    newAgent = createRoadAgent(scenario.roadSamples, {
      agentClass: 'pothole',
      behavior: 'stationary_encroach',
      s: spawnS - 4,
      d: ego.d,
      speedKmh: 0,
      isStatic: true,
    });
    logMsg = `Injected unexpected crater pothole directly ahead at s=${(spawnS - 4).toFixed(0)}m`;
  }

  state.agents.push(newAgent);
  state.injectedCount += 1;
  state.logs.unshift({
    id: state.nextLogId++,
    simTime: state.metrics.simTime,
    level: 'WARN',
    tag: 'INJECT_HAZARD',
    message: logMsg,
  });
  if (state.logs.length > 40) state.logs.pop();
}

/**
 * Runs deterministic closed-loop validation across all 5 Indian road scenarios
 * using the real perception, prediction, planner, and bicycle-model control stack.
 */
export function runAllScenariosBenchmark(): ScenarioBenchmarkResult[] {
  const noiseConfig: SensorNoiseConfig = { weatherMode: 'clear', noiseMultiplier: 1.0 };
  const results: ScenarioBenchmarkResult[] = [];
  const dt = 0.05;
  const maxSteps = 1300; // up to 65s simulated time

  for (const id of SCENARIO_IDS) {
    const sim = createInitialSimulationState(id, true);
    let stateTransitions = 0;
    let prevState = sim.planner.state;

    for (let step = 0; step < maxSteps; step++) {
      stepSimulation(sim, dt, noiseConfig);
      if (sim.planner.state !== prevState) {
        stateTransitions += 1;
        prevState = sim.planner.state;
      }
      if (sim.metrics.completed) break;
    }

    results.push({
      scenarioId: id,
      scenarioCode: sim.scenario.code,
      title: sim.scenario.title,
      completed: sim.metrics.completed,
      passed: sim.metrics.completed && sim.metrics.collisions === 0,
      collisions: sim.metrics.collisions,
      nearMisses: sim.metrics.nearMisses,
      durationS: sim.metrics.simTime,
      meanSpeedKmh: sim.metrics.meanSpeedKmh,
      minClearanceM: sim.metrics.minClearanceM,
      meanReplanMs: sim.metrics.meanReplanMs,
      p95ReplanMs: sim.metrics.p95ReplanMs,
      rmsJerk: sim.metrics.rmsJerk,
      meanCurvature: sim.metrics.meanCurvature,
      progressPct: sim.metrics.progressPct,
      stateTransitions,
    });
  }

  return results;
}
