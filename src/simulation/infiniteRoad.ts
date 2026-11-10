/**
 * Deterministic procedural road chunks for Infinite Free Drive.
 *
 * Design constraints that shaped this file:
 *
 * - Chunks are pure data. No THREE objects, no DOM, no randomness that is not
 *   derived from the seed. That makes generation testable in Node and makes a
 *   rebuild after a window shift produce byte-identical geometry.
 * - Continuity is guaranteed by carrying the previous chunk's exit pose
 *   (position, heading, curvature) into the next chunk as its entry pose. Each
 *   chunk therefore starts exactly where the last one ended, with a matching
 *   tangent, so there is no gap, overlap or visible kink at a seam.
 * - Heading is bounded. An unbounded random walk will eventually fold the road
 *   back over itself, which looks like an overlap even though the geometry is
 *   correct. `MAX_ABS_HEADING` keeps the drive sweeping across a wide arc.
 * - Environment is a property of the chunk, and consecutive chunks of the same
 *   environment blend their widths so a change of scenery never produces a step
 *   in the road width.
 */

import { RoadSample } from '../types/simulation';

export type RoadEnvironment = 'highway' | 'urban' | 'rural' | 'village';

export const ROAD_ENVIRONMENTS: RoadEnvironment[] = ['highway', 'urban', 'rural', 'village'];

export const ENVIRONMENT_LABEL: Record<RoadEnvironment, string> = {
  highway: 'Highway',
  urban: 'Urban',
  rural: 'Rural',
  village: 'Village',
};

/** Per-environment geometry and dressing profile. */
export interface EnvironmentProfile {
  /** Asphalt half-width on each side of the centreline. */
  leftWidth: number;
  rightWidth: number;
  shoulderLeft: number;
  shoulderRight: number;
  hasLaneMarks: boolean;
  /** Painted edge line (highways and urban arterials have them). */
  hasEdgeLines: boolean;
  /** Centre divider median, in metres (0 = none). */
  medianWidth: number;
  /** Raised kerbed sidewalk on each side, in metres (0 = none). */
  sidewalkWidth: number;
  speedLimitKmh: number;
  /** Nominal number of traffic lanes per direction. */
  lanesPerDirection: number;
  /** Scenery density multipliers consumed by the dressing pass. */
  treeDensity: number;
  buildingDensity: number;
  streetlightSpacingM: number;
  /** Sign gantries / hoardings appear in these environments. */
  hasSigns: boolean;
  hasBarriers: boolean;
}

export const ENVIRONMENT_PROFILES: Record<RoadEnvironment, EnvironmentProfile> = {
  highway: {
    leftWidth: 7.6,
    rightWidth: 7.6,
    shoulderLeft: 2.6,
    shoulderRight: 2.6,
    hasLaneMarks: true,
    hasEdgeLines: true,
    medianWidth: 1.5,
    sidewalkWidth: 0,
    speedLimitKmh: 100,
    lanesPerDirection: 2,
    treeDensity: 0.45,
    buildingDensity: 0,
    streetlightSpacingM: 34,
    hasSigns: true,
    hasBarriers: true,
  },
  urban: {
    leftWidth: 6.4,
    rightWidth: 6.4,
    shoulderLeft: 1.2,
    shoulderRight: 1.2,
    hasLaneMarks: true,
    hasEdgeLines: true,
    medianWidth: 0.9,
    sidewalkWidth: 2.4,
    speedLimitKmh: 50,
    lanesPerDirection: 2,
    treeDensity: 0.3,
    buildingDensity: 1,
    streetlightSpacingM: 26,
    hasSigns: true,
    hasBarriers: false,
  },
  rural: {
    leftWidth: 4.6,
    rightWidth: 4.6,
    shoulderLeft: 1.8,
    shoulderRight: 1.8,
    hasLaneMarks: true,
    hasEdgeLines: false,
    medianWidth: 0,
    sidewalkWidth: 0,
    speedLimitKmh: 70,
    lanesPerDirection: 1,
    treeDensity: 1,
    buildingDensity: 0.15,
    streetlightSpacingM: 0,
    hasSigns: false,
    hasBarriers: false,
  },
  village: {
    leftWidth: 3.3,
    rightWidth: 3.3,
    shoulderLeft: 2.2,
    shoulderRight: 2.2,
    hasLaneMarks: false,
    hasEdgeLines: false,
    medianWidth: 0,
    sidewalkWidth: 0,
    speedLimitKmh: 40,
    lanesPerDirection: 1,
    treeDensity: 1.2,
    buildingDensity: 0.55,
    streetlightSpacingM: 55,
    hasSigns: false,
    hasBarriers: false,
  },
};

/** A single scavengeable piece of roadside dressing. */
export interface ChunkSceneryItem {
  kind: 'tree' | 'building' | 'house' | 'streetlight' | 'sign' | 'barrier' | 'divider' | 'sidewalk';
  /** Distance along the chunk from its start. */
  s: number;
  /** Lateral offset from centreline, +d = driver's right. */
  d: number;
  /** Deterministic variation key (drives scale/colour selection). */
  variant: number;
  /** Extra rotation applied on top of the road tangent. */
  yawOffset: number;
}

export interface ChunkHazardItem {
  kind: 'pothole' | 'barricade';
  s: number;
  d: number;
  variant: number;
}

export interface RoadChunk {
  index: number;
  /** Arc length at the chunk's start. */
  startS: number;
  lengthM: number;
  environment: RoadEnvironment;
  /** Samples covering [startS, startS + lengthM]. The last sample is shared
   *  with the next chunk's first sample so seams are exactly coincident. */
  samples: RoadSample[];
  scenery: ChunkSceneryItem[];
  hazards: ChunkHazardItem[];
  /** Pose at the chunk exit, consumed by the next chunk. */
  exit: { x: number; y: number; theta: number; curvature: number };
}

export interface InfiniteRoadConfig {
  seed: number;
  /** Chunk length in metres. 40 m gives smooth curvature without many objects. */
  chunkLengthM: number;
  /** Target number of chunks kept alive. 12 x 60 m = 720 m of road. */
  activeChunks: number;
  /** Chunks kept behind the vehicle before recycling. */
  retainBehind: number;
  /** How far ahead of the vehicle generation is kept. */
  lookaheadM: number;
  /** Environment order. Explicit so a drive is reproducible and testable. */
  environmentSequence: RoadEnvironment[];
  /** Sample spacing within a chunk. Smaller = smoother curve, more vertices. */
  sampleSpacingM: number;
  /** Maximum |heading| in radians before the road is steered back. */
  maxAbsHeading: number;
  /** Hazard probability per chunk (0 disables hazards). */
  hazardChance: number;
  hudEnabled: boolean;
}

export const DEFAULT_INFINITE_CONFIG: InfiniteRoadConfig = {
  seed: 20260410,
  chunkLengthM: 60,
  activeChunks: 12,
  retainBehind: 2,
  lookaheadM: 600,
  environmentSequence: ['highway', 'urban', 'rural', 'village'],
  sampleSpacingM: 4,
  maxAbsHeading: 1.15,
  hazardChance: 0.7,
  hudEnabled: true,
};

/** Chunks per environment block before switching to the next environment. */
const CHUNKS_PER_ENVIRONMENT = 3;

/**
 * Small deterministic PRNG (mulberry32). Chosen over Math.random because every
 * chunk must regenerate identically after a window shift.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: number, index: number, salt: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function environmentForChunk(config: InfiniteRoadConfig, index: number): RoadEnvironment {
  const seq = config.environmentSequence.length > 0 ? config.environmentSequence : ['rural' as RoadEnvironment];
  const block = Math.floor(Math.max(0, index) / CHUNKS_PER_ENVIRONMENT);
  return seq[block % seq.length];
}

/** Total arc length the window must cover for the requested lookahead. */
export function requiredChunkCount(config: InfiniteRoadConfig): number {
  return Math.max(config.activeChunks, Math.ceil(config.lookaheadM / config.chunkLengthM) + config.retainBehind + 1);
}

/**
 * Builds one chunk. Deterministic in (config.seed, index, entry pose).
 * The entry pose is passed in rather than recomputed so that the caller can
 * keep an exact global chain and never accumulate drift.
 */
export function buildChunk(
  config: InfiniteRoadConfig,
  index: number,
  entry: { s: number; x: number; y: number; theta: number; curvature: number }
): RoadChunk {
  const rng = createRng(hashSeed(config.seed, index, 0x51ed));
  const environment = environmentForChunk(config, index);
  const profile = ENVIRONMENT_PROFILES[environment];

  // Widths blend toward the next environment's profile across the chunk so an
  // environment change never shows as a step in the road edge.
  const nextEnvironment = environmentForChunk(config, index + 1);
  const nextProfile = ENVIRONMENT_PROFILES[nextEnvironment];
  const blendAcross = nextEnvironment !== environment;

  const lengthM = config.chunkLengthM;
  const spacing = Math.max(2, config.sampleSpacingM);
  const steps = Math.max(2, Math.round(lengthM / spacing));
  const ds = lengthM / steps;

  // Curvature: a gentle base plus low-frequency variation. Scaled by how
  // sharply we are already heading away from straight, so the road steers back
  // toward the centre line instead of spiralling.
  const curvatureAmplitude =
    environment === 'highway' ? 0.0045 : environment === 'urban' ? 0.0085 : environment === 'village' ? 0.013 : 0.011;
  const baseCurvature = (rng() * 2 - 1) * curvatureAmplitude;
  const curvatureSlope = (rng() * 2 - 1) * curvatureAmplitude * 0.5;

  const samples: RoadSample[] = [];
  let x = entry.x;
  let y = entry.y;
  let theta = entry.theta;

  /*
   * Heading control.
   *
   * A bang-bang "if heading is too large, bend back" correction was measurably
   * insufficient: with curvature amplitudes up to 0.013 rad/m it allowed the
   * tangent past +-pi/2, at which point the road starts consuming x backwards
   * and folds back over itself (the acceptance test caught exactly that).
   *
   * Instead the curvature carries a proportional term -theta * HEADING_GAIN.
   * Equilibrium sits near amplitude/gain, so with a gain of 0.02 and a maximum
   * amplitude of 0.013 the heading settles around 0.65 rad and never
   * approaches the limit. `maxAbsHeading` is then only a hard safety clamp.
   *
   * `curvature` below is the *base* curvature (no feedback). It is blended from
   * the previous chunk's base curvature so total curvature is continuous across
   * a seam, not just position and tangent.
   */
  const HEADING_GAIN = 0.02;
  const MAX_CURVATURE = 0.035;

  for (let i = 0; i <= steps; i++) {
    const localS = i * ds;
    const t = i / steps;

    if (i > 0) {
      const blendedBase = entry.curvature * (1 - t) + baseCurvature * t + curvatureSlope * t;
      let curvature = blendedBase - theta * HEADING_GAIN;
      curvature = Math.max(-MAX_CURVATURE, Math.min(MAX_CURVATURE, curvature));
      theta += curvature * ds;
      // Hard safety clamp. The proportional term keeps the road far from this.
      if (theta > config.maxAbsHeading) theta = config.maxAbsHeading;
      else if (theta < -config.maxAbsHeading) theta = -config.maxAbsHeading;
      x += Math.cos(theta) * ds;
      y += Math.sin(theta) * ds;
    }

    const widthT = blendAcross ? t : 0;
    samples.push({
      s: entry.s + localS,
      x,
      y,
      theta,
      nx: -Math.sin(theta),
      ny: Math.cos(theta),
      leftWidth: profile.leftWidth + (nextProfile.leftWidth - profile.leftWidth) * widthT,
      rightWidth: profile.rightWidth + (nextProfile.rightWidth - profile.rightWidth) * widthT,
      shoulderLeft: profile.shoulderLeft + (nextProfile.shoulderLeft - profile.shoulderLeft) * widthT,
      shoulderRight: profile.shoulderRight + (nextProfile.shoulderRight - profile.shoulderRight) * widthT,
      hasLaneMarks: profile.hasLaneMarks,
      medianWidth:
        profile.medianWidth + (nextProfile.medianWidth - profile.medianWidth) * widthT,
      sidewalkWidth:
        profile.sidewalkWidth + (nextProfile.sidewalkWidth - profile.sidewalkWidth) * widthT,
    });
  }

  // Exit base curvature (without heading feedback) seeds the next chunk's blend.
  const exitPose = { x, y, theta, curvature: baseCurvature + curvatureSlope };
  const scenery = buildScenery(index, environment, profile, lengthM, rng);
  const hazards = buildHazards(index, config.hazardChance, lengthM, profile, rng);

  return {
    index,
    startS: entry.s,
    lengthM,
    environment,
    samples,
    scenery,
    hazards,
    exit: exitPose,
  };
}

function buildScenery(
  index: number,
  environment: RoadEnvironment,
  profile: EnvironmentProfile,
  lengthM: number,
  rng: () => number
): ChunkSceneryItem[] {
  const items: ChunkSceneryItem[] = [];
  const edge = Math.max(profile.leftWidth, profile.rightWidth);

  // Sidewalks hug the kerb on urban chunks.
  if (profile.sidewalkWidth > 0) {
    for (const side of [-1, 1]) {
      items.push({
        kind: 'sidewalk',
        s: 0,
        d: side * (edge + 0.05),
        variant: 0,
        yawOffset: 0,
      });
    }
  }

  /*
   * Median divider, segmented so it follows curvature.
   *
   * A straight 18 m box on a curved chunk cuts a visible chord across the road
   * (measured on the highway block). Segments are 6 m, one every 6 m of chunk so
   * the median stays continuous, and each segment is oriented to the tangent at
   * its own centre.
   */
  if (profile.medianWidth > 0) {
    const DIVIDER_SEGMENT_M = 6;
    const count = Math.max(1, Math.floor(lengthM / DIVIDER_SEGMENT_M));
    for (let i = 0; i < count; i++) {
      items.push({
        kind: 'divider',
        s: (lengthM / count) * (i + 0.5),
        d: 0,
        variant: i % 2,
        yawOffset: 0,
      });
    }
  }

  // Streetlights, alternating sides.
  if (profile.streetlightSpacingM > 0) {
    const count = Math.max(1, Math.floor(lengthM / profile.streetlightSpacingM));
    for (let i = 0; i < count; i++) {
      const side = (index + i) % 2 === 0 ? -1 : 1;
      items.push({
        kind: 'streetlight',
        s: (lengthM / count) * (i + 0.5),
        d: side * (edge + profile.shoulderLeft + 0.9),
        variant: side,
        yawOffset: 0,
      });
    }
  }

  // Trees / vegetation.
  const treeCount = Math.round((lengthM / 9) * profile.treeDensity * (0.6 + rng() * 0.8));
  for (let i = 0; i < treeCount; i++) {
    const side = rng() < 0.5 ? -1 : 1;
    const offset = edge + profile.shoulderRight + 2.5 + rng() * (environment === 'rural' ? 22 : 12);
    items.push({
      kind: 'tree',
      s: rng() * lengthM,
      d: side * offset,
      variant: Math.floor(rng() * 6),
      yawOffset: rng() * Math.PI * 2,
    });
  }

  // Buildings for urban; occasional houses for village/rural.
  if (profile.buildingDensity > 0) {
    const count = Math.round((lengthM / 18) * profile.buildingDensity * (0.7 + rng() * 0.6));
    for (let i = 0; i < count; i++) {
      const side = rng() < 0.5 ? -1 : 1;
      items.push({
        kind: environment === 'urban' ? 'building' : 'house',
        s: rng() * lengthM,
        d: side * (edge + profile.sidewalkWidth + 5 + rng() * 7),
        variant: Math.floor(rng() * 8),
        yawOffset: side < 0 ? 0 : Math.PI,
      });
    }
  }

  // Sign gantries / roadside signage.
  if (profile.hasSigns && rng() < 0.6) {
    items.push({
      kind: 'sign',
      s: lengthM * (0.3 + rng() * 0.4),
      d: 0,
      variant: Math.floor(rng() * 3),
      yawOffset: 0,
    });
  }

  // Highway barrier posts along the shoulder.
  if (profile.hasBarriers && rng() < 0.7) {
    const side = rng() < 0.5 ? -1 : 1;
    for (let i = 0; i < 3; i++) {
      items.push({
        kind: 'barrier',
        s: (lengthM / 3) * (i + 0.5),
        d: side * (edge + profile.shoulderRight + 0.4),
        variant: i,
        yawOffset: 0,
      });
    }
  }

  return items;
}

/** Minimum arc length between two hazard sites, in metres. */
const HAZARD_MIN_GAP_M = 90;

function buildHazards(
  index: number,
  hazardChance: number,
  lengthM: number,
  profile: EnvironmentProfile,
  rng: () => number
): ChunkHazardItem[] {
  if (hazardChance <= 0) return [];

  /*
   * Hazards are gated on the chunk index so sites are at least HAZARD_MIN_GAP_M
   * apart, and at most one hazard is placed per chunk.
   *
   * The first implementation allowed two hazards per chunk with independent
   * lateral offsets. Consecutive chunks then produced runs like
   * `pothole d=+0.9` and `pothole d=-0.6` a couple of metres apart, which is a
   * wall across the carriageway: the ego braked to a standstill in 4% of steps
   * and averaged 43 km/h against a 65 km/h cruise. Spacing is a correctness
   * requirement, not a cosmetic one.
   */
  const chunkSpacing = Math.max(2, Math.ceil(HAZARD_MIN_GAP_M / lengthM));
  if (index % chunkSpacing !== 0) return [];
  if (rng() > hazardChance) return [];

  // Offset into the paved area, staying off the exact centreline so a hazard
  // always leaves a passable gap on at least one side.
  const maxD = Math.max(1, Math.min(profile.leftWidth, profile.rightWidth) - 1.2);
  const side = rng() < 0.5 ? -1 : 1;
  const d = side * (0.8 + rng() * Math.max(0.1, maxD - 0.8));

  return [
    {
      kind: rng() < 0.74 ? 'pothole' : 'barricade',
      s: lengthM * (0.15 + rng() * 0.7),
      d,
      variant: Math.floor(rng() * 4),
    },
  ];
}
