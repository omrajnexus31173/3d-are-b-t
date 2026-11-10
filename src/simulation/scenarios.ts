import {
  AgentBehavior,
  AgentClass,
  RoadAgent,
  RoadProp,
  RoadSample,
  ScenarioDefinition,
  ScenarioId,
} from '../types/simulation';
import { buildRoadFromControlPoints, frenetToWorld } from './roadMath';

const AGENT_PRESETS: Record<
  AgentClass,
  { length: number; width: number; colorHex: string; label: string }
> = {
  car: { length: 4.3, width: 1.85, colorHex: '#3B82F6', label: 'Car' },
  auto_rickshaw: { length: 2.75, width: 1.42, colorHex: '#F59E0B', label: 'Auto-Rickshaw' },
  two_wheeler: { length: 2.05, width: 0.78, colorHex: '#FBBF24', label: 'Two-Wheeler' },
  bus_truck: { length: 8.6, width: 2.45, colorHex: '#6366F1', label: 'Truck / Bus' },
  pedestrian: { length: 0.75, width: 0.75, colorHex: '#F43F5E', label: 'Pedestrian' },
  pushcart: { length: 2.5, width: 1.35, colorHex: '#EC4899', label: 'Pushcart (Thela)' },
  cattle: { length: 2.25, width: 1.05, colorHex: '#EF4444', label: 'Stray Cattle' },
  pothole: { length: 1.75, width: 1.65, colorHex: '#A855F7', label: 'Pothole Crater' },
  barricade: { length: 1.2, width: 2.3, colorHex: '#F97316', label: 'Road Barricade' },
};

let agentCounter = 1;
export function resetAgentCounter() {
  agentCounter = 1;
}

export function createRoadAgent(
  samples: RoadSample[],
  opts: {
    agentClass: AgentClass;
    behavior: AgentBehavior;
    s: number;
    d: number;
    speedKmh: number;
    directionSign?: 1 | -1;
    headingOffsetRad?: number;
    triggerDist?: number;
    mergeTargetD?: number;
    crossAngle?: number;
    isStatic?: boolean;
  }
): RoadAgent {
  const preset = AGENT_PRESETS[opts.agentClass];
  const pose = frenetToWorld(samples, opts.s, opts.d);
  const dir = opts.directionSign ?? 1;
  const baseHeading = dir === 1 ? pose.theta : pose.theta + Math.PI;
  const theta = baseHeading + (opts.headingOffsetRad ?? 0);
  const speed = opts.speedKmh / 3.6;
  const idx = agentCounter++;

  return {
    id: `agent-${idx}-${opts.agentClass}`,
    trackId: `TRK-${String(idx).padStart(2, '0')}`,
    agentClass: opts.agentClass,
    behavior: opts.behavior,
    x: pose.x,
    y: pose.y,
    theta,
    speed,
    targetSpeed: speed,
    vx: Math.cos(theta) * speed,
    vy: Math.sin(theta) * speed,
    length: preset.length,
    width: preset.width,
    isStatic:
      opts.isStatic ??
      (opts.agentClass === 'pothole' ||
        opts.agentClass === 'barricade' ||
        opts.behavior === 'stationary_encroach'),
    nominalD: opts.d,
    directionSign: dir,
    triggerDist: opts.triggerDist,
    triggered: false,
    crossAngle: opts.crossAngle,
    lateralDriftPhase: idx * 1.37,
    mergeTargetD: opts.mergeTargetD,
    colorHex: preset.colorHex,
    label: preset.label,
  };
}

function createCrossAgent(opts: {
  agentClass: AgentClass;
  behavior: AgentBehavior;
  x: number;
  y: number;
  theta: number;
  speedKmh: number;
  triggerDist?: number;
}): RoadAgent {
  const preset = AGENT_PRESETS[opts.agentClass];
  const speed = opts.speedKmh / 3.6;
  const idx = agentCounter++;
  return {
    id: `agent-${idx}-${opts.agentClass}`,
    trackId: `TRK-${String(idx).padStart(2, '0')}`,
    agentClass: opts.agentClass,
    behavior: opts.behavior,
    x: opts.x,
    y: opts.y,
    theta: opts.theta,
    speed,
    targetSpeed: speed,
    vx: Math.cos(opts.theta) * speed,
    vy: Math.sin(opts.theta) * speed,
    length: preset.length,
    width: preset.width,
    isStatic: false,
    nominalD: 0,
    directionSign: 1,
    triggerDist: opts.triggerDist,
    triggered: false,
    lateralDriftPhase: idx * 1.1,
    colorHex: preset.colorHex,
    label: preset.label,
  };
}

// ============================================================================
// SCENARIO 1: UNMARKED VILLAGE ROAD
// ============================================================================
function buildVillageRoad(): ScenarioDefinition {
  resetAgentCounter();
  const samples = buildRoadFromControlPoints([
    { x: 0, y: 0, leftWidth: 3.5, rightWidth: 3.5, shoulderLeft: 1.8, shoulderRight: 1.8, hasLaneMarks: false },
    { x: 48, y: -4, leftWidth: 3.4, rightWidth: 3.3, shoulderLeft: 1.9, shoulderRight: 1.7, hasLaneMarks: false },
    { x: 96, y: -16, leftWidth: 3.1, rightWidth: 3.2, shoulderLeft: 2.1, shoulderRight: 1.8, hasLaneMarks: false },
    { x: 145, y: -10, leftWidth: 3.3, rightWidth: 3.4, shoulderLeft: 1.8, shoulderRight: 2.0, hasLaneMarks: false },
    { x: 195, y: 12, leftWidth: 3.5, rightWidth: 3.3, shoulderLeft: 1.7, shoulderRight: 1.9, hasLaneMarks: false },
    { x: 245, y: 18, leftWidth: 3.6, rightWidth: 3.6, shoulderLeft: 1.8, shoulderRight: 1.8, hasLaneMarks: false },
  ]);

  const props: RoadProp[] = [];
  const treeOffsets = [
    { s: 25, d: -7.2 },
    { s: 65, d: 7.4 },
    { s: 105, d: -7.5 },
    { s: 140, d: 7.0 },
    { s: 175, d: -7.6 },
    { s: 215, d: 7.3 },
  ];
  treeOffsets.forEach((t, idx) => {
    const p = frenetToWorld(samples, t.s, t.d);
    props.push({
      id: `tree-${idx}`,
      x: p.x,
      y: p.y,
      width: 3.6,
      length: 3.6,
      theta: p.theta,
      kind: 'tree',
    });
  });

  // Village chai stall on left shoulder
  const stallPos = frenetToWorld(samples, 82, -6.2);
  props.push({
    id: 'chai-stall',
    x: stallPos.x,
    y: stallPos.y,
    width: 2.6,
    length: 5.0,
    theta: stallPos.theta,
    kind: 'stall',
    label: 'Chai Tapri',
  });

  const agents: RoadAgent[] = [
    // Deep crater pothole in left cruise lane
    createRoadAgent(samples, {
      agentClass: 'pothole',
      behavior: 'stationary_encroach',
      s: 52,
      d: -1.8,
      speedKmh: 0,
      isStatic: true,
    }),
    // Slow village auto-rickshaw cruising ahead
    createRoadAgent(samples, {
      agentClass: 'auto_rickshaw',
      behavior: 'slow_crawl',
      s: 66,
      d: -1.65,
      speedKmh: 16,
      directionSign: 1,
    }),
    // Parked pushcart near chai stall encroaching left lane
    createRoadAgent(samples, {
      agentClass: 'pushcart',
      behavior: 'stationary_encroach',
      s: 88,
      d: -2.4,
      speedKmh: 0,
      isStatic: true,
    }),
    // Oncoming village car hugging center slightly
    createRoadAgent(samples, {
      agentClass: 'car',
      behavior: 'oncoming',
      s: 142,
      d: 1.55,
      speedKmh: 31,
      directionSign: -1,
    }),
    // Pedestrian walking along left road edge then stepping slightly inward
    createRoadAgent(samples, {
      agentClass: 'pedestrian',
      behavior: 'jaywalk_cross',
      s: 126,
      d: -3.4,
      speedKmh: 4.5,
      directionSign: 1,
      triggerDist: 30,
      crossAngle: 0.72,
    }),
    // Second pothole on right half after curve
    createRoadAgent(samples, {
      agentClass: 'pothole',
      behavior: 'stationary_encroach',
      s: 158,
      d: 1.4,
      speedKmh: 0,
      isStatic: true,
    }),
    // Weaving two-wheeler overtaking or filtering
    createRoadAgent(samples, {
      agentClass: 'two_wheeler',
      behavior: 'weaving_gap',
      s: 170,
      d: -1.1,
      speedKmh: 26,
      directionSign: 1,
    }),
    // Wrong-way scooter hugging left edge coming toward ego!
    createRoadAgent(samples, {
      agentClass: 'two_wheeler',
      behavior: 'wrong_way_edge',
      s: 215,
      d: -3.2,
      speedKmh: 22,
      directionSign: -1,
    }),
  ];

  return {
    id: 'village_road',
    code: 'SCN-01',
    title: 'Unmarked Village Road',
    shortTitle: '1. Village Road',
    description:
      'Narrow single-carriageway rural road with missing lane markings, crumbling dusty shoulders, potholes, parked pushcart, wrong-way two-wheeler, and roadside pedestrian.',
    roadType: 'Unmarked Rural Carriageway',
    keyChallenges: ['Zero lane lines', 'Unpaved shoulders', 'Crater potholes', 'Wrong-way scooter'],
    speedLimitKmh: 40,
    totalLengthM: samples[samples.length - 1].s,
    roadSamples: samples,
    crossRoads: [],
    props,
    initialAgents: agents,
    initialEgoS: 10,
    initialEgoD: -1.7,
    initialEgoSpeed: 32 / 3.6,
    goalS: 232,
    surfaceTint: '#252B36',
    terrainTint: '#17201B',
    shoulderTint: '#4A3F32',
  };
}

// ============================================================================
// SCENARIO 2: BUSY URBAN INTERSECTION WITHOUT SIGNALS
// ============================================================================
function buildUrbanIntersection(): ScenarioDefinition {
  resetAgentCounter();
  const samples = buildRoadFromControlPoints([
    { x: 0, y: 0, leftWidth: 4.8, rightWidth: 4.8, shoulderLeft: 1.2, shoulderRight: 1.2, hasLaneMarks: false },
    { x: 75, y: 0, leftWidth: 5.0, rightWidth: 5.0, shoulderLeft: 1.2, shoulderRight: 1.2, hasLaneMarks: false },
    { x: 105, y: 0, leftWidth: 6.4, rightWidth: 6.4, shoulderLeft: 1.4, shoulderRight: 1.4, hasLaneMarks: false },
    { x: 135, y: 0, leftWidth: 6.4, rightWidth: 6.4, shoulderLeft: 1.4, shoulderRight: 1.4, hasLaneMarks: false },
    { x: 165, y: 0, leftWidth: 5.0, rightWidth: 5.0, shoulderLeft: 1.2, shoulderRight: 1.2, hasLaneMarks: false },
    { x: 240, y: 0, leftWidth: 4.8, rightWidth: 4.8, shoulderLeft: 1.2, shoulderRight: 1.2, hasLaneMarks: false },
  ]);

  const crossRoads = [
    {
      x1: 120,
      y1: -95,
      x2: 120,
      y2: 95,
      width: 11.5,
      label: 'Signal-less Cross Corridor',
    },
  ];

  const props: RoadProp[] = [
    { id: 'bldg-nw', x: 96, y: -22, width: 16, length: 24, theta: 0, kind: 'building', label: 'Market Complex' },
    { id: 'bldg-ne', x: 144, y: -22, width: 16, length: 24, theta: 0, kind: 'building', label: 'Commercial Block' },
    { id: 'bldg-sw', x: 96, y: 22, width: 16, length: 24, theta: 0, kind: 'building' },
    { id: 'bldg-se', x: 144, y: 22, width: 16, length: 24, theta: 0, kind: 'building' },
    { id: 'nosig-post', x: 109, y: -9, width: 1.2, length: 1.2, theta: 0, kind: 'sign_missing', label: 'No Signal' },
  ];

  const agents: RoadAgent[] = [
    // Auto-rickshaw ahead turning/cutting diagonally through intersection
    createRoadAgent(samples, {
      agentClass: 'auto_rickshaw',
      behavior: 'informal_merge',
      s: 62,
      d: -3.2,
      speedKmh: 20,
      directionSign: 1,
      triggerDist: 38,
      mergeTargetD: -1.3,
    }),
    // Cross-traffic bus entering from North (-y) heading South (+y) through junction
    createCrossAgent({
      agentClass: 'bus_truck',
      behavior: 'cross_traffic',
      x: 117.5,
      y: -36,
      theta: Math.PI / 2,
      speedKmh: 22,
      triggerDist: 75,
    }),
    // Cross-traffic auto-rickshaw cutting from South (+y) diagonally toward NW!
    createCrossAgent({
      agentClass: 'auto_rickshaw',
      behavior: 'cross_traffic',
      x: 125.5,
      y: 34,
      theta: -Math.PI / 2 - 0.18,
      speedKmh: 24,
      triggerDist: 70,
    }),
    // Two-wheeler zipping East-to-West or North-to-South right through gap
    createCrossAgent({
      agentClass: 'two_wheeler',
      behavior: 'cross_traffic',
      x: 123,
      y: -24,
      theta: Math.PI / 2 - 0.12,
      speedKmh: 27,
      triggerDist: 62,
    }),
    // Jaywalking pedestrian crossing right after the junction box
    createRoadAgent(samples, {
      agentClass: 'pedestrian',
      behavior: 'jaywalk_cross',
      s: 146,
      d: -4.8,
      speedKmh: 5.0,
      directionSign: 1,
      triggerDist: 34,
      crossAngle: 1.38,
    }),
    // Oncoming car on right side
    createRoadAgent(samples, {
      agentClass: 'car',
      behavior: 'oncoming',
      s: 195,
      d: 2.3,
      speedKmh: 33,
      directionSign: -1,
    }),
    // Stationary barricade on left shoulder post-intersection
    createRoadAgent(samples, {
      agentClass: 'barricade',
      behavior: 'stationary_encroach',
      s: 185,
      d: -3.6,
      speedKmh: 0,
      isStatic: true,
    }),
  ];

  return {
    id: 'urban_intersection',
    code: 'SCN-02',
    title: 'Busy Urban Intersection (No Signals)',
    shortTitle: '2. Urban Junction',
    description:
      'Four-way signal-less Indian urban junction featuring cross-traffic buses, diagonal auto-rickshaw cut-ins, weaving two-wheelers, and jaywalking pedestrians.',
    roadType: 'Signal-less 4-Way Junction',
    keyChallenges: ['No traffic lights', 'Cross-traffic buses', 'Diagonal auto cut-ins', 'Jaywalkers'],
    speedLimitKmh: 40,
    totalLengthM: samples[samples.length - 1].s,
    roadSamples: samples,
    crossRoads,
    props,
    initialAgents: agents,
    initialEgoS: 10,
    initialEgoD: -2.2,
    initialEgoSpeed: 30 / 3.6,
    goalS: 225,
    surfaceTint: '#1F2937',
    terrainTint: '#111827',
    shoulderTint: '#374151',
  };
}

// ============================================================================
// SCENARIO 3: HIGHWAY MERGE WITH SLOW-MOVING VEHICLES
// ============================================================================
function buildHighwayMerge(): ScenarioDefinition {
  resetAgentCounter();
  const samples = buildRoadFromControlPoints([
    { x: 0, y: 0, leftWidth: 5.5, rightWidth: 5.2, shoulderLeft: 2.0, shoulderRight: 1.5, hasLaneMarks: true },
    { x: 75, y: 0, leftWidth: 6.2, rightWidth: 5.2, shoulderLeft: 2.2, shoulderRight: 1.5, hasLaneMarks: true },
    { x: 130, y: 2, leftWidth: 5.6, rightWidth: 5.2, shoulderLeft: 2.0, shoulderRight: 1.5, hasLaneMarks: false },
    { x: 205, y: 6, leftWidth: 5.5, rightWidth: 5.2, shoulderLeft: 1.8, shoulderRight: 1.5, hasLaneMarks: true },
    { x: 270, y: 8, leftWidth: 5.5, rightWidth: 5.2, shoulderLeft: 1.8, shoulderRight: 1.5, hasLaneMarks: true },
  ]);

  // Angled left service-road merge ramp joining highway around s = 60..115m
  const crossRoads = [
    {
      x1: 12,
      y1: -36,
      x2: 112,
      y2: -4.5,
      width: 5.5,
      label: 'Informal Merge Ramp',
    },
  ];

  const props: RoadProp[] = [
    { id: 'hw-div-1', x: 140, y: 8.5, width: 0.9, length: 45, theta: 0.04, kind: 'divider' },
    { id: 'hw-div-2', x: 215, y: 12.0, width: 0.9, length: 45, theta: 0.04, kind: 'divider' },
  ];

  const agents: RoadAgent[] = [
    // Overloaded slow-moving truck crawling on left main highway lane
    createRoadAgent(samples, {
      agentClass: 'bus_truck',
      behavior: 'slow_crawl',
      s: 68,
      d: -3.1,
      speedKmh: 20,
      directionSign: 1,
    }),
    // Informal merging auto/tempo entering from left service ramp WITHOUT indicator!
    createRoadAgent(samples, {
      agentClass: 'auto_rickshaw',
      behavior: 'informal_merge',
      s: 92,
      d: -5.4,
      speedKmh: 24,
      directionSign: 1,
      triggerDist: 45,
      mergeTargetD: -2.4,
    }),
    // Second slow tractor/truck ahead in middle-left lane
    createRoadAgent(samples, {
      agentClass: 'bus_truck',
      behavior: 'slow_crawl',
      s: 158,
      d: -2.9,
      speedKmh: 24,
      directionSign: 1,
    }),
    // Fast highway car in overtaking lane / oncoming or fast ahead
    createRoadAgent(samples, {
      agentClass: 'car',
      behavior: 'nominal_cruise',
      s: 42,
      d: -0.6,
      speedKmh: 52,
      directionSign: 1,
    }),
    // Breakdown pushcart/barricade on left shoulder
    createRoadAgent(samples, {
      agentClass: 'barricade',
      behavior: 'stationary_encroach',
      s: 132,
      d: -4.6,
      speedKmh: 0,
      isStatic: true,
    }),
    // Oncoming traffic on far right carriageway (+d)
    createRoadAgent(samples, {
      agentClass: 'car',
      behavior: 'oncoming',
      s: 195,
      d: 2.8,
      speedKmh: 48,
      directionSign: -1,
    }),
    createRoadAgent(samples, {
      agentClass: 'two_wheeler',
      behavior: 'weaving_gap',
      s: 122,
      d: -1.0,
      speedKmh: 38,
      directionSign: 1,
    }),
  ];

  return {
    id: 'highway_merge',
    code: 'SCN-03',
    title: 'Highway Merge (Slow Traffic)',
    shortTitle: '3. Highway Merge',
    description:
      'National Highway merge zone featuring overloaded crawling trucks, an un-signaled informal merger from the left service ramp, shoulder hazard, and high speed differential.',
    roadType: 'NH Highway + Unmarked Merge',
    keyChallenges: ['Informal merging', 'Crawling heavy trucks', 'High speed delta', 'Shoulder barricade'],
    speedLimitKmh: 58,
    totalLengthM: samples[samples.length - 1].s,
    roadSamples: samples,
    crossRoads,
    props,
    initialAgents: agents,
    initialEgoS: 12,
    initialEgoD: -2.6,
    initialEgoSpeed: 48 / 3.6,
    goalS: 252,
    surfaceTint: '#1E2530',
    terrainTint: '#151B16',
    shoulderTint: '#3D372E',
  };
}

// ============================================================================
// SCENARIO 4: DENSE MARKET AREA WITH MIXED TRAFFIC
// ============================================================================
function buildDenseMarket(): ScenarioDefinition {
  resetAgentCounter();
  const samples = buildRoadFromControlPoints([
    { x: 0, y: 0, leftWidth: 4.5, rightWidth: 4.5, shoulderLeft: 1.2, shoulderRight: 1.2, hasLaneMarks: false },
    { x: 55, y: 4, leftWidth: 4.4, rightWidth: 4.4, shoulderLeft: 1.1, shoulderRight: 1.1, hasLaneMarks: false },
    { x: 115, y: -3, leftWidth: 4.3, rightWidth: 4.3, shoulderLeft: 1.0, shoulderRight: 1.0, hasLaneMarks: false },
    { x: 175, y: 3, leftWidth: 4.5, rightWidth: 4.5, shoulderLeft: 1.2, shoulderRight: 1.2, hasLaneMarks: false },
    { x: 230, y: 0, leftWidth: 4.6, rightWidth: 4.6, shoulderLeft: 1.2, shoulderRight: 1.2, hasLaneMarks: false },
  ]);

  const props: RoadProp[] = [];
  for (let s = 30; s <= 195; s += 26) {
    const pL = frenetToWorld(samples, s, -6.2);
    props.push({
      id: `mkt-l-${s}`,
      x: pL.x,
      y: pL.y,
      width: 2.5,
      length: 6.5,
      theta: pL.theta,
      kind: 'stall',
      label: s % 52 === 0 ? 'Bazaar Stall' : undefined,
    });
    const pR = frenetToWorld(samples, s + 12, 6.2);
    props.push({
      id: `mkt-r-${s}`,
      x: pR.x,
      y: pR.y,
      width: 2.5,
      length: 6.5,
      theta: pR.theta,
      kind: 'stall',
    });
  }

  const agents: RoadAgent[] = [
    // Vegetable pushcart encroaching left edge
    createRoadAgent(samples, {
      agentClass: 'pushcart',
      behavior: 'stationary_encroach',
      s: 45,
      d: -3.2,
      speedKmh: 0,
      isStatic: true,
    }),
    // Slow weaving two-wheeler
    createRoadAgent(samples, {
      agentClass: 'two_wheeler',
      behavior: 'weaving_gap',
      s: 58,
      d: -1.4,
      speedKmh: 18,
      directionSign: 1,
    }),
    // Pushcart on opposite side creating a chicane
    createRoadAgent(samples, {
      agentClass: 'pushcart',
      behavior: 'stationary_encroach',
      s: 74,
      d: 2.9,
      speedKmh: 0,
      isStatic: true,
    }),
    // Sudden shopper stepping across market lane
    createRoadAgent(samples, {
      agentClass: 'pedestrian',
      behavior: 'jaywalk_cross',
      s: 92,
      d: -3.8,
      speedKmh: 4.6,
      directionSign: 1,
      triggerDist: 28,
      crossAngle: 1.35,
    }),
    // E-rickshaw / Auto-rickshaw stopping/crawling ahead
    createRoadAgent(samples, {
      agentClass: 'auto_rickshaw',
      behavior: 'slow_crawl',
      s: 112,
      d: -1.4,
      speedKmh: 13,
      directionSign: 1,
    }),
    // Oncoming auto-rickshaw squeezing through bazaar
    createRoadAgent(samples, {
      agentClass: 'auto_rickshaw',
      behavior: 'oncoming',
      s: 145,
      d: 1.7,
      speedKmh: 20,
      directionSign: -1,
    }),
    // Second shopper stepping from right pushcart
    createRoadAgent(samples, {
      agentClass: 'pedestrian',
      behavior: 'jaywalk_cross',
      s: 158,
      d: 3.6,
      speedKmh: 4.4,
      directionSign: 1,
      triggerDist: 28,
      crossAngle: -1.35,
    }),
    // Parked pushcart on left near market exit
    createRoadAgent(samples, {
      agentClass: 'pushcart',
      behavior: 'stationary_encroach',
      s: 172,
      d: -3.1,
      speedKmh: 0,
      isStatic: true,
    }),
    // Wrong-way bicycle / two-wheeler on far left margin
    createRoadAgent(samples, {
      agentClass: 'two_wheeler',
      behavior: 'wrong_way_edge',
      s: 202,
      d: -3.3,
      speedKmh: 16,
      directionSign: -1,
    }),
  ];

  return {
    id: 'dense_market',
    code: 'SCN-04',
    title: 'Dense Market Area (Mixed Traffic)',
    shortTitle: '4. Dense Market',
    description:
      'Encroached Indian bazaar street packed with stationary pushcarts (thelas), shoppers crossing abruptly, weaving two-wheelers, and slow auto-rickshaws.',
    roadType: 'Encroached Bazaar Corridor',
    keyChallenges: ['Thela encroachments', 'Sudden pedestrians', 'Bidirectional squeeze', 'Low-speed control'],
    speedLimitKmh: 30,
    totalLengthM: samples[samples.length - 1].s,
    roadSamples: samples,
    crossRoads: [],
    props,
    initialAgents: agents,
    initialEgoS: 10,
    initialEgoD: -1.6,
    initialEgoSpeed: 24 / 3.6,
    goalS: 215,
    surfaceTint: '#262933',
    terrainTint: '#161419',
    shoulderTint: '#463C34',
  };
}

// ============================================================================
// SCENARIO 5: SUDDEN CATTLE-CROSSING EVENT
// ============================================================================
function buildCattleCrossing(): ScenarioDefinition {
  resetAgentCounter();
  const samples = buildRoadFromControlPoints([
    { x: 0, y: 0, leftWidth: 4.3, rightWidth: 4.3, shoulderLeft: 1.8, shoulderRight: 1.8, hasLaneMarks: false },
    { x: 60, y: -3, leftWidth: 4.3, rightWidth: 4.3, shoulderLeft: 1.8, shoulderRight: 1.8, hasLaneMarks: false },
    { x: 120, y: -5, leftWidth: 4.2, rightWidth: 4.2, shoulderLeft: 2.0, shoulderRight: 2.0, hasLaneMarks: false },
    { x: 185, y: 2, leftWidth: 4.3, rightWidth: 4.3, shoulderLeft: 1.8, shoulderRight: 1.8, hasLaneMarks: false },
    { x: 245, y: 4, leftWidth: 4.4, rightWidth: 4.4, shoulderLeft: 1.8, shoulderRight: 1.8, hasLaneMarks: false },
  ]);

  const props: RoadProp[] = [];
  [25, 72, 138, 192].forEach((s, i) => {
    const p = frenetToWorld(samples, s, i % 2 === 0 ? -7.2 : 7.2);
    props.push({ id: `cattle-tree-${i}`, x: p.x, y: p.y, width: 3.8, length: 3.8, theta: p.theta, kind: 'tree' });
  });

  const agents: RoadAgent[] = [
    // Lead cattle resting on left verge, suddenly bolts across road when ego approaches!
    createRoadAgent(samples, {
      agentClass: 'cattle',
      behavior: 'erratic_cattle',
      s: 96,
      d: -4.6,
      speedKmh: 0,
      directionSign: 1,
      triggerDist: 38,
      crossAngle: 1.25,
    }),
    // Second cow following closely behind lead cow
    createRoadAgent(samples, {
      agentClass: 'cattle',
      behavior: 'erratic_cattle',
      s: 103,
      d: -4.9,
      speedKmh: 0,
      directionSign: 1,
      triggerDist: 36,
      crossAngle: 1.15,
    }),
    // Stray calf loitering slightly inside right lane further ahead
    createRoadAgent(samples, {
      agentClass: 'cattle',
      behavior: 'erratic_cattle',
      s: 148,
      d: 3.4,
      speedKmh: 0,
      directionSign: 1,
      triggerDist: 34,
      crossAngle: -1.18,
    }),
    // Pothole earlier on road testing pre-event tracking
    createRoadAgent(samples, {
      agentClass: 'pothole',
      behavior: 'stationary_encroach',
      s: 54,
      d: -1.7,
      speedKmh: 0,
      isStatic: true,
    }),
    // Oncoming car in far right lane
    createRoadAgent(samples, {
      agentClass: 'car',
      behavior: 'oncoming',
      s: 175,
      d: 2.1,
      speedKmh: 34,
      directionSign: -1,
    }),
    // Slow auto-rickshaw downstream after herd
    createRoadAgent(samples, {
      agentClass: 'auto_rickshaw',
      behavior: 'slow_crawl',
      s: 192,
      d: -1.8,
      speedKmh: 19,
      directionSign: 1,
    }),
  ];

  return {
    id: 'cattle_crossing',
    code: 'SCN-05',
    title: 'Sudden Cattle-Crossing Event',
    shortTitle: '5. Cattle Crossing',
    description:
      'Peri-urban arterial corridor where stray cattle resting on the mud shoulder suddenly trot and hesitate across the carriageway, requiring rapid TTC braking and evasion.',
    roadType: 'Peri-Urban Arterial Road',
    keyChallenges: ['Erratic cattle bolt', 'Emergency TTC brake', 'Oncoming car', 'Smooth recovery'],
    speedLimitKmh: 45,
    totalLengthM: samples[samples.length - 1].s,
    roadSamples: samples,
    crossRoads: [],
    props,
    initialAgents: agents,
    initialEgoS: 10,
    initialEgoD: -1.8,
    initialEgoSpeed: 38 / 3.6,
    goalS: 230,
    surfaceTint: '#242A34',
    terrainTint: '#171E19',
    shoulderTint: '#4B4031',
  };
}

export const SCENARIO_IDS: ScenarioId[] = [
  'village_road',
  'urban_intersection',
  'highway_merge',
  'dense_market',
  'cattle_crossing',
];

export function createScenario(id: ScenarioId): ScenarioDefinition {
  switch (id) {
    case 'village_road':
      return buildVillageRoad();
    case 'urban_intersection':
      return buildUrbanIntersection();
    case 'highway_merge':
      return buildHighwayMerge();
    case 'dense_market':
      return buildDenseMarket();
    case 'cattle_crossing':
      return buildCattleCrossing();
  }
}

export const SCENARIO_LIST_META = SCENARIO_IDS.map((id) => {
  const s = createScenario(id);
  return {
    id: s.id,
    code: s.code,
    title: s.title,
    shortTitle: s.shortTitle,
    roadType: s.roadType,
    keyChallenges: s.keyChallenges,
  };
});
