/**
 * Endless-mode traffic lifecycle and road-window maintenance.
 *
 * Kept out of `engine.ts` so the existing scenario path stays byte-for-byte
 * unchanged: `stepSimulation` only calls into this module when the scenario is
 * endless. Nothing here creates a second simulation — it drives the same
 * `EgoVehicle`, `RoadAgent` array, perception, planner and metrics.
 *
 * Population control:
 * - Agents spawn ahead of the ego on a spawn band and are despawned once they
 *   fall far enough behind (or, for oncoming traffic, once they pass).
 * - Total live agents are capped, so a long drive cannot grow the array.
 * - Spawn positions are seeded from a deterministic PRNG advanced per spawn, so
 *   the traffic sequence is reproducible even though it is time-dependent.
 */

import { AgentClass, RoadAgent, ScenarioDefinition } from '../types/simulation';
import { createRoadAgent } from './scenarios';
import { worldToFrenet } from './roadMath';
import { InfiniteRoad } from './infiniteRoadManager';
import { RoadEnvironment, createRng } from './infiniteRoad';

export interface EndlessTrafficConfig {
  /** Arc length ahead of the ego where new agents may appear. */
  spawnAheadMinM: number;
  spawnAheadMaxM: number;
  /** Arc length behind the ego at which a same-direction agent is removed. */
  despawnBehindM: number;
  /** Radial distance behind the ego at which any agent is removed. */
  despawnRadiusM: number;
  /** Hard cap on live traffic agents (excluding hazards). */
  maxAgents: number;
  /** Target agent density per 100 m of covered road. */
  densityPer100m: number;
  /** Seconds between spawn attempts. */
  spawnIntervalS: number;
}

export const DEFAULT_ENDLESS_TRAFFIC: EndlessTrafficConfig = {
  spawnAheadMinM: 140,
  spawnAheadMaxM: 420,
  despawnBehindM: 110,
  despawnRadiusM: 260,
  maxAgents: 34,
  densityPer100m: 4.2,
  spawnIntervalS: 0.9,
};

/** Class mix per environment, mirroring what each road actually carries. */
const ENVIRONMENT_MIX: Record<RoadEnvironment, AgentClass[]> = {
  highway: ['car', 'car', 'car', 'bus_truck', 'bus_truck', 'two_wheeler'],
  urban: ['car', 'car', 'auto_rickshaw', 'two_wheeler', 'pedestrian', 'pedestrian', 'pushcart', 'bus_truck'],
  rural: ['car', 'two_wheeler', 'bus_truck', 'cattle', 'auto_rickshaw'],
  // NOTE: there is no separate `bicycle` agent class in this codebase; bicycles
  // and scooters are both modelled as `two_wheeler` (see scenarios.ts), and the
  // two-wheeler mesh covers both. Adding a distinct class would mean new
  // dimensions, a new mesh and new perception handling, which is out of scope.
  village: ['two_wheeler', 'two_wheeler', 'auto_rickshaw', 'cattle', 'pedestrian', 'pushcart'],
};

/** Speed ranges in km/h per class, per environment. */
function speedFor(agentClass: AgentClass, env: RoadEnvironment, rng: () => number): number {
  const jitter = rng() * 14 - 7;
  const base: Record<AgentClass, number> = {
    car: env === 'highway' ? 92 : env === 'urban' ? 38 : 55,
    bus_truck: env === 'highway' ? 78 : 32,
    two_wheeler: env === 'highway' ? 84 : 42,
    auto_rickshaw: 26,
    pedestrian: 4.5,
    pushcart: 2.6,
    cattle: 2.2,
    pothole: 0,
    barricade: 0,
  } as Record<AgentClass, number>;
  return Math.max(1.5, base[agentClass] + jitter);
}

const BEHAVIOUR_FOR: Partial<Record<AgentClass, RoadAgent['behavior']>> = {
  pedestrian: 'jaywalk_cross',
  pushcart: 'stationary_encroach',
  cattle: 'erratic_cattle',
  auto_rickshaw: 'informal_merge',
  two_wheeler: 'weaving_gap',
};

export interface EndlessRoadControllerOptions {
  config: EndlessTrafficConfig;
  seed: number;
}

export class EndlessRoadController {
  readonly road: InfiniteRoad;
  readonly traffic: EndlessTrafficConfig;
  private rng: () => number;
  private spawnTimer = 0;
  private spawned = 0;
  private despawned = 0;

  constructor(road: InfiniteRoad, options: EndlessRoadControllerOptions) {
    this.road = road;
    this.traffic = options.config;
    this.rng = createRng(options.seed ^ 0x2545f491);
  }

  /**
   * Refreshes the scenario's live road window and reconciles traffic.
   * Safe to call every fixed simulation step; each call is O(live agents).
   */
  step(scenario: ScenarioDefinition, ego: { x: number; y: number; s: number; theta: number }, agents: RoadAgent[], dt: number): void {
    this.road.update(ego.s);

    // Reuse one array reference so React refs and the viewport keep seeing the
    // same object across the whole drive.
    const liveSamples = this.road.samples();
    scenario.roadSamples = liveSamples;
    scenario.totalLengthM = this.road.windowEndS - this.road.windowStartS;

    this.reconcileTraffic(scenario, ego, agents, dt);
    this.syncHazards(scenario, ego, agents);
  }

  private reconcileTraffic(
    scenario: ScenarioDefinition,
    ego: { x: number; y: number; s: number },
    agents: RoadAgent[],
    dt: number
  ): void {
    // 1. Despawn by distance.
    //
    // Static agents (pushcarts, pedestrians who have stopped) must be despawned
    // exactly like moving ones. The first implementation skipped every
    // `isStatic` agent, assuming chunk-owned hazards covered them, and
    // pushcarts - which createRoadAgent marks static for
    // `stationary_encroach` - accumulated without bound: 45 of 50 static agents
    // after ~16 minutes, blocking the carriageway so the ego sat at 0 km/h.
    // Chunk-owned hazards keep their `hz-` ids and are reconciled separately.
    for (let i = agents.length - 1; i >= 0; i--) {
      const ag = agents[i];
      const chunkOwned = ag.id.startsWith('hz-');
      const radial = Math.hypot(ag.x - ego.x, ag.y - ego.y);

      // Chunk-owned hazards have exactly one owner: syncHazards(). Applying a
      // radius rule here as well made the two subsystems fight - this loop
      // removed a hazard for being far away, syncHazards re-added it because its
      // chunk was still in the window, forever. That produced 36k despawns
      // against 975 spawns.
      if (chunkOwned) continue;

      let drop = radial > this.traffic.despawnRadiusM;
      if (!drop) {
        const proj = worldToFrenet(scenario.roadSamples, ag.x, ag.y, ego.s);
        // Same-direction traffic falls behind; oncoming traffic is dropped once
        // it is well past the ego either way.
        drop = proj.s < ego.s - this.traffic.despawnBehindM;
        if (!drop && ag.directionSign < 0 && proj.s < ego.s - 40) drop = true;
      }

      if (drop) {
        agents.splice(i, 1);
        this.despawned += 1;
      }
    }

    // 2. Spawn, paced by a timer so we do not add work every step.
    this.spawnTimer += dt;
    if (this.spawnTimer < this.traffic.spawnIntervalS) return;
    this.spawnTimer = 0;

    // Count every spawned agent toward the cap, static or not. The cap is a hard
    // object-count bound, not a soft hint.
    const liveAgents = agents.filter((a) => !a.id.startsWith('hz-')).length;
    const target = Math.min(
      this.traffic.maxAgents,
      Math.round((this.traffic.spawnAheadMaxM / 100) * this.traffic.densityPer100m)
    );
    if (liveAgents >= target) return;

    const aheadM = this.road.windowEndS - ego.s;
    if (aheadM < this.traffic.spawnAheadMinM + 20) return;

    const env = this.road.environmentAt(ego.s + this.traffic.spawnAheadMinM);
    const mix = ENVIRONMENT_MIX[env];
    const agentClass = mix[Math.floor(this.rng() * mix.length)];

    const spawnS =
      ego.s + this.traffic.spawnAheadMinM + this.rng() * (this.traffic.spawnAheadMaxM - this.traffic.spawnAheadMinM);
    if (spawnS > this.road.windowEndS - 8) return;

    const sample = scenario.roadSamples;
    // Lanes: each direction uses one half of the carriageway.
    const leftWidth = sample[0]?.leftWidth ?? 4;
    const oncoming = this.rng() < 0.34 && agentClass !== 'pedestrian' && agentClass !== 'cattle' && agentClass !== 'pushcart';
    const laneCount = env === 'highway' ? 2 : 1;
    const laneIdx = Math.floor(this.rng() * laneCount);
    const laneWidth = (leftWidth - 0.8) / laneCount;
    const d = oncoming
      ? leftWidth - laneWidth * (laneIdx + 0.5)
      : -(leftWidth - laneWidth * (laneIdx + 0.5));

    // Pedestrians and cattle belong on the margins, not mid-carriageway.
    const class_ = agentClass as AgentClass;
    const isMargin = class_ === 'pedestrian' || class_ === 'cattle' || class_ === 'pushcart';
    const finalD = isMargin ? (this.rng() < 0.5 ? -1 : 1) * (leftWidth + 0.4 + this.rng() * 2.5) : d;
    const speedKmh = speedFor(class_, env, this.rng);

    const agent = createRoadAgent(sample, {
      agentClass: class_,
      behavior: isMargin ? BEHAVIOUR_FOR[class_] ?? 'nominal_cruise' : oncoming ? 'oncoming' : 'nominal_cruise',
      s: spawnS,
      d: finalD,
      speedKmh,
      directionSign: oncoming ? -1 : 1,
      triggerDist: class_ === 'cattle' ? 55 : undefined,
      crossAngle: class_ === 'cattle' ? (this.rng() < 0.5 ? -1.2 : 1.2) : undefined,
    });
    agents.push(agent);
    this.spawned += 1;
  }

  /**
   * Hazards are derived from chunk data, not spawned randomly per frame. This
   * keeps them deterministic and prevents duplicates as chunks recycle.
   */
  private syncHazards(scenario: ScenarioDefinition, ego: { s: number }, agents: RoadAgent[]): void {
    const wanted = new Map<string, { s: number; d: number; kind: 'pothole' | 'barricade'; variant: number }>();
    // Single window definition, wider behind than the chunk retention so a
    // hazard is not dropped and re-created as the ego passes it.
    for (const chunk of this.road.environsAround(ego.s - this.traffic.despawnBehindM, this.traffic.spawnAheadMaxM + 80)) {
      chunk.hazards.forEach((h, i) => {
        wanted.set(`hz-${chunk.index}-${i}`, { s: chunk.startS + h.s, d: h.d, kind: h.kind, variant: h.variant });
      });
    }

    // Drop hazards whose chunk has left the window. Injected demo hazards are
    // left alone (their ids do not start with `hz-`).
    for (let i = agents.length - 1; i >= 0; i--) {
      const id = agents[i].id;
      if (id.startsWith('hz-') && !wanted.has(id)) agents.splice(i, 1);
    }

    const existing = new Set(agents.filter((a) => a.id.startsWith('hz-')).map((a) => a.id));
    for (const [id, h] of wanted) {
      if (existing.has(id)) continue;
      const agent = createRoadAgent(scenario.roadSamples, {
        agentClass: h.kind,
        behavior: 'stationary_encroach',
        s: h.s,
        d: h.d,
        speedKmh: 0,
        isStatic: true,
      });
      // Stable per-chunk id so the same pothole is not re-added every frame and
      // the 3D rig can be reused rather than rebuilt.
      agent.id = id;
      agents.push(agent);
    }
  }

  stats() {
    return { spawned: this.spawned, despawned: this.despawned };
  }
}
