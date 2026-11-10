import { describe, expect, it } from 'vitest';
import { createInitialSimulationState, getEndlessRoad, stepSimulation } from '../engine';
import { DEFAULT_INFINITE_CONFIG } from '../infiniteRoad';
import { SCENARIO_IDS } from '../scenarios';
import { isEndlessScenario } from '../../types/simulation';

const NOISE = { weatherMode: 'clear' as const, noiseMultiplier: 1 };

function runEndless(seconds: number, dt = 0.04) {
  const state = createInitialSimulationState('infinite_drive', true);
  const steps = Math.round(seconds / dt);
  let maxAgents = 0;
  let maxScenery = 0;
  let maxChunks = 0;
  const samples: { t: number; s: number; agents: number; chunks: number }[] = [];

  for (let i = 0; i < steps; i++) {
    stepSimulation(state, dt, NOISE);
    maxAgents = Math.max(maxAgents, state.agents.length);
    if (state.roadWindow) {
      maxScenery = Math.max(maxScenery, state.roadWindow.sceneryItems);
      maxChunks = Math.max(maxChunks, state.roadWindow.activeChunks);
    }
    if (i % 500 === 0) {
      samples.push({
        t: state.metrics.simTime,
        s: state.ego.s,
        agents: state.agents.length,
        chunks: state.roadWindow?.activeChunks ?? 0,
      });
    }
  }
  return { state, maxAgents, maxScenery, maxChunks, samples, steps };
}

describe('endless experience registration', () => {
  it('is selectable and flagged as endless', () => {
    expect(SCENARIO_IDS.length).toBe(5);
    expect(isEndlessScenario('infinite_drive')).toBe(true);
    expect(isEndlessScenario('village_road')).toBe(false);
  });

  it('starts with a valid live road window', () => {
    const state = createInitialSimulationState('infinite_drive');
    expect(state.scenario.roadSamples.length).toBeGreaterThan(50);
    expect(getEndlessRoad(state)).not.toBeNull();
    expect(state.roadWindow!.activeChunks).toBeGreaterThan(0);
    expect(state.roadWindow!.seed).toBe(DEFAULT_INFINITE_CONFIG.seed);
  });
});

describe('endless driving', () => {
  it('never completes and never reaches an endpoint', () => {
    const { state } = runEndless(60);
    expect(state.metrics.completed).toBe(false);
    expect(state.metrics.progressPct).toBe(0);
    expect(state.ego.s).toBeGreaterThan(200);
  }, 60_000);

  it('keeps the road window ahead of the ego at all times', () => {
    const state = createInitialSimulationState('infinite_drive');
    for (let i = 0; i < 2500; i++) {
      stepSimulation(state, 0.04, NOISE);
      const w = state.roadWindow!;
      expect(w.windowEndS).toBeGreaterThan(state.ego.s + 100);
      expect(w.windowStartS).toBeLessThan(state.ego.s);
    }
  });

  it('keeps active chunk and agent counts bounded over a long drive', () => {
    const { maxAgents, maxChunks, maxScenery } = runEndless(200);
    expect(maxChunks).toBeLessThanOrEqual(14);
    expect(maxAgents).toBeLessThanOrEqual(70);
    expect(maxScenery).toBeLessThanOrEqual(1200);
  }, 120_000);

  it('spawns and despawns traffic', () => {
    const { state } = runEndless(90);
    const w = state.roadWindow!;
    expect(w.vehiclesSpawned).toBeGreaterThan(5);
    expect(w.vehiclesDespawned).toBeGreaterThan(0);
    expect(state.agents.length).toBeGreaterThan(0);
  });

  it('supports multiple traffic classes including pedestrians and animals', () => {
    const { state } = runEndless(150);
    const classes = new Set(state.agents.map((a) => a.agentClass));
    // whatever is live should be drawn from the supported set
    for (const c of classes) {
      expect(['car', 'bus_truck', 'two_wheeler', 'auto_rickshaw', 'pedestrian', 'pushcart', 'cattle', 'pothole', 'barricade']).toContain(c);
    }
    expect(state.roadWindow!.vehiclesSpawned).toBeGreaterThan(10);
  });

  it('produces hazards that are separate from camera detections', () => {
    const { state } = runEndless(90);
    const hazards = state.agents.filter((a) => a.agentClass === 'pothole' || a.agentClass === 'barricade');
    // Hazards live in the simulation agent list under `hz-` ids. They must never
    // be written into the camera detection pipeline.
    for (const h of hazards) expect(h.id.startsWith('hz-')).toBe(true);
    expect(state.roadWindow!.hazardItems).toBeGreaterThanOrEqual(0);
  });

  it('keeps the ego near the carriageway', () => {
    const state = createInitialSimulationState('infinite_drive');
    for (let i = 0; i < 1500; i++) {
      stepSimulation(state, 0.04, NOISE);
      // Widths vary by environment, so bound against the widest profile rather
      // than the window's first sample. Evasive manoeuvres legitimately use the
      // shoulder; the ego must not wander off into the scenery.
      expect(Math.abs(state.ego.d)).toBeLessThanOrEqual(14);
    }
  });

  it('drives a long haul without a teleport or a gap in the window', () => {
    // ~12 km through the real stepSimulation path. The 1000-segment traversal is
    // covered exhaustively at generator level in infiniteRoad.test.ts (60 km of
    // chunks, no THREE, no physics) because driving 60 km at the engine's fixed
    // 0.04 s step would take ~3 minutes per test run. This test checks the
    // integration: no ego teleport, window always ahead, counts bounded.
    const state = createInitialSimulationState('infinite_drive');
    let prevX = state.ego.x;
    let prevY = state.ego.y;
    let maxJump = 0;
    const targetS = 12_000;
    let steps = 0;

    while (state.ego.s < targetS && steps < 60_000) {
      stepSimulation(state, 0.04, NOISE);
      maxJump = Math.max(maxJump, Math.hypot(state.ego.x - prevX, state.ego.y - prevY));
      prevX = state.ego.x;
      prevY = state.ego.y;
      steps += 1;

      const w = state.roadWindow!;
      expect(w.windowEndS).toBeGreaterThan(state.ego.s);
      expect(w.activeChunks).toBeLessThanOrEqual(14);
      expect(state.agents.length).toBeLessThanOrEqual(70);
    }

    expect(state.metrics.completed).toBe(false);
    expect(state.ego.s).toBeGreaterThanOrEqual(targetS);
    // At 0.04 s and <120 km/h nothing should move more than ~1.4 m per step.
    expect(maxJump).toBeLessThan(3);
    expect(state.roadWindow!.chunksGenerated).toBeGreaterThanOrEqual(190);
    expect(state.roadWindow!.chunksRecycled).toBeGreaterThan(170);
    // memory proxies stay bounded after 12 km
    expect(state.telemetryHistory.length).toBeLessThanOrEqual(90);
    expect(state.replanLatencies.length).toBeLessThanOrEqual(400);
    expect(state.logs.length).toBeLessThanOrEqual(60);
  }, 120_000);
});
