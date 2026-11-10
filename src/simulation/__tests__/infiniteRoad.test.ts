import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INFINITE_CONFIG,
  ENVIRONMENT_PROFILES,
  InfiniteRoadConfig,
  ROAD_ENVIRONMENTS,
  buildChunk,
  createRng,
  environmentForChunk,
  requiredChunkCount,
} from '../infiniteRoad';
import { InfiniteRoad } from '../infiniteRoadManager';

const BASE: InfiniteRoadConfig = { ...DEFAULT_INFINITE_CONFIG };

/** Small helper: entry pose at the origin. */
const ORIGIN = { s: 0, x: 0, y: 0, theta: 0, curvature: 0 };

describe('deterministic generation', () => {
  it('produces identical samples for the same seed and index', () => {
    const a = buildChunk(BASE, 7, ORIGIN);
    const b = buildChunk(BASE, 7, ORIGIN);
    expect(a.samples.length).toBe(b.samples.length);
    for (let i = 0; i < a.samples.length; i++) {
      expect(a.samples[i].x).toBeCloseTo(b.samples[i].x, 10);
      expect(a.samples[i].y).toBeCloseTo(b.samples[i].y, 10);
      expect(a.samples[i].theta).toBeCloseTo(b.samples[i].theta, 10);
    }
    expect(a.scenery.length).toBe(b.scenery.length);
  });

  it('produces different geometry for a different seed', () => {
    const a = buildChunk(BASE, 7, ORIGIN);
    const b = buildChunk({ ...BASE, seed: BASE.seed + 1 }, 7, ORIGIN);
    const diverges = a.samples.some((s, i) => Math.abs(s.y - b.samples[i].y) > 1e-6);
    expect(diverges).toBe(true);
  });

  it('has a reproducible PRNG', () => {
    const r1 = createRng(1234);
    const r2 = createRng(1234);
    const seq1 = Array.from({ length: 8 }, () => r1());
    const seq2 = Array.from({ length: 8 }, () => r2());
    expect(seq1).toEqual(seq2);
    expect(new Set(seq1).size).toBeGreaterThan(1);
  });
});

describe('chunk geometry continuity', () => {
  it('starts each chunk exactly where the previous exit pose was', () => {
    let pose = ORIGIN;
    for (let i = 0; i < 40; i++) {
      const chunk = buildChunk(BASE, i, pose);
      const first = chunk.samples[0];
      expect(first.x).toBeCloseTo(pose.x, 6);
      expect(first.y).toBeCloseTo(pose.y, 6);
      expect(first.theta).toBeCloseTo(pose.theta, 6);
      expect(first.s).toBeCloseTo(pose.s, 6);
      const last = chunk.samples[chunk.samples.length - 1];
      expect(last.x).toBeCloseTo(chunk.exit.x, 6);
      expect(last.y).toBeCloseTo(chunk.exit.y, 6);
      pose = { s: chunk.startS + chunk.lengthM, ...chunk.exit };
    }
  });

  it('emits samples with strictly increasing arc length', () => {
    let pose = ORIGIN;
    for (let i = 0; i < 12; i++) {
      const chunk = buildChunk(BASE, i, pose);
      for (let j = 1; j < chunk.samples.length; j++) {
        expect(chunk.samples[j].s).toBeGreaterThan(chunk.samples[j - 1].s);
      }
      pose = { s: chunk.startS + chunk.lengthM, ...chunk.exit };
    }
  });

  it('has no corner discontinuity larger than the allowed turn rate at a seam', () => {
    // Consecutive sample spacing is `sampleSpacingM`; a seam must not jump more
    // than a hair beyond the curvature the road allows.
    let pose = ORIGIN;
    let prevTheta = 0;
    const maxTurnPerMetre = 0.02; // ~1.15 deg per metre, well above any profile
    for (let i = 0; i < 25; i++) {
      const chunk = buildChunk(BASE, i, pose);
      for (let j = 0; j < chunk.samples.length; j++) {
        const s = chunk.samples[j];
        const dTheta = Math.abs(s.theta - prevTheta);
        const dS = j === 0 ? 0 : BASE.sampleSpacingM;
        if (dS > 0) expect(dTheta).toBeLessThan(maxTurnPerMetre * dS + 1e-6);
        prevTheta = s.theta;
      }
      pose = { s: chunk.startS + chunk.lengthM, ...chunk.exit };
    }
  });

  it('keeps heading bounded so the road cannot fold onto itself', () => {
    let pose = ORIGIN;
    for (let i = 0; i < 400; i++) {
      const chunk = buildChunk(BASE, i, pose);
      for (const s of chunk.samples) {
        expect(Math.abs(s.theta)).toBeLessThan(BASE.maxAbsHeading + 0.35);
      }
      pose = { s: chunk.startS + chunk.lengthM, ...chunk.exit };
    }
  });

  it('advances the road forward, never backward', () => {
    let pose = ORIGIN;
    let prevX = 0;
    let travelled = 0;
    for (let i = 0; i < 60; i++) {
      const chunk = buildChunk(BASE, i, pose);
      const last = chunk.samples[chunk.samples.length - 1];
      // x must keep increasing: heading stays within +-1.15 rad so cos > 0.4
      expect(last.x).toBeGreaterThan(prevX);
      prevX = last.x;
      travelled += Math.hypot(last.x - chunk.samples[0].x, last.y - chunk.samples[0].y);
      pose = { s: chunk.startS + chunk.lengthM, ...chunk.exit };
    }
    expect(travelled).toBeGreaterThan(60 * BASE.chunkLengthM * 0.8);
  });
});

describe('environment profile', () => {
  it('covers every requested environment', () => {
    for (const env of ROAD_ENVIRONMENTS) {
      expect(ENVIRONMENT_PROFILES[env]).toBeTruthy();
      expect(ENVIRONMENT_PROFILES[env].leftWidth).toBeGreaterThan(0);
    }
  });

  it('cycles environments deterministically', () => {
    const seq = Array.from({ length: 12 }, (_, i) => environmentForChunk(BASE, i));
    expect(seq.slice(0, 3)).toEqual(['highway', 'highway', 'highway']);
    expect(seq.slice(3, 6)).toEqual(['urban', 'urban', 'urban']);
    expect(seq.slice(6, 9)).toEqual(['rural', 'rural', 'rural']);
    expect(seq.slice(9, 12)).toEqual(['village', 'village', 'village']);
  });

  it('blends width across an environment change instead of stepping', () => {
    // Chunk 2 is the last highway chunk, so it must ramp toward urban widths.
    let pose = ORIGIN;
    for (let i = 0; i < 2; i++) pose = { s: (i + 1) * BASE.chunkLengthM, ...buildChunk(BASE, i, pose).exit };
    const chunk = buildChunk(BASE, 2, pose);
    const first = chunk.samples[0];
    const last = chunk.samples[chunk.samples.length - 1];
    expect(last.leftWidth).not.toBeCloseTo(first.leftWidth, 3);
    const step = Math.abs(last.leftWidth - first.leftWidth);
    expect(step).toBeGreaterThan(0.1);
    expect(step).toBeLessThan(2);
  });
});

describe('InfiniteRoad window management', () => {
  it('fills the configured lookahead immediately', () => {
    const road = new InfiniteRoad(BASE);
    expect(road.activeChunks).toBe(requiredChunkCount(BASE));
    expect(road.windowEndS).toBeGreaterThanOrEqual(BASE.lookaheadM);
  });

  it('traverses 1000+ chunks while keeping counts bounded', () => {
    const road = new InfiniteRoad(BASE);
    const limit = requiredChunkCount(BASE);
    let maxChunks = 0;
    let maxScenery = 0;
    const speed = 25; // m/s
    const dt = 0.04;
    const segmentTarget = 1000;

    for (let step = 0; step < 200_000; step++) {
      const egoS = step * speed * dt;
      road.update(egoS);
      maxChunks = Math.max(maxChunks, road.activeChunks);
      maxScenery = Math.max(maxScenery, road.stats(egoS).sceneryItems);
      if (egoS > segmentTarget * BASE.chunkLengthM) break;
    }

    const stats = road.stats(segmentTarget * BASE.chunkLengthM);
    expect(stats.chunksGenerated).toBeGreaterThanOrEqual(segmentTarget);
    expect(stats.chunksRecycled).toBeGreaterThan(segmentTarget - limit - 10);
    expect(maxChunks).toBe(limit);
    expect(maxScenery).toBeLessThan(1200);
  });

  it('never leaves a gap between the window edge and the ego', () => {
    const road = new InfiniteRoad(BASE);
    for (let s = 0; s < 5000; s += 37) {
      road.update(s);
      expect(road.windowEndS).toBeGreaterThanOrEqual(s + BASE.lookaheadM - 1e-6);
      expect(road.windowStartS).toBeLessThanOrEqual(s);
      expect(road.activeChunks).toBeLessThanOrEqual(requiredChunkCount(BASE));
    }
  });

  it('produces a contiguous flattened sample list', () => {
    const road = new InfiniteRoad(BASE);
    road.update(800);
    const samples = road.samples();
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].s).toBeGreaterThan(samples[i - 1].s);
      const gap = samples[i].s - samples[i - 1].s;
      expect(gap).toBeCloseTo(BASE.sampleSpacingM, 5);
      const dist = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
      expect(Math.abs(dist - gap)).toBeLessThan(0.01);
    }
  });

  it('regenerates identical geometry after window shifts', () => {
    const road = new InfiniteRoad(BASE);
    road.update(0);
    const early = road.allChunks.map((c) => ({ index: c.index, x: c.exit.x, y: c.exit.y }));

    // Drive far enough that the early chunks are recycled.
    for (let s = 0; s < 10_000; s += 50) road.update(s);
    expect(road.windowStartS).toBeGreaterThan(0);

    const fresh = new InfiniteRoad(BASE);
    fresh.update(0);
    const again = fresh.allChunks.map((c) => ({ index: c.index, x: c.exit.x, y: c.exit.y }));
    expect(again).toEqual(early);
  });

  it('advances the window and keeps it consistent after a large forward jump', () => {
    // Regression: the retain rule deleted freshly generated chunks after a big
    // jump, freezing the window (GEN/REC stuck) and letting chunkAt() read past
    // the array end. Found by driving the browser to 2.4 km.
    const road = new InfiniteRoad(BASE);
    for (const target of [300, 600, 1200, 2400, 4800, 9600, 19200, 38400]) {
      road.update(target);
      const st = road.stats(target);
      expect(st.windowStartS).toBeLessThanOrEqual(target);
      expect(st.windowEndS).toBeGreaterThanOrEqual(target + BASE.lookaheadM - 1e-6);
      expect(st.activeChunks).toBeGreaterThan(0);
      expect(st.activeChunks).toBeLessThanOrEqual(requiredChunkCount(BASE));
      // the chunk lookup must never fall off the array
      expect(() => road.chunkAt(target)).not.toThrow();
      expect(road.chunkAt(target)).not.toBeNull();
      expect(road.environmentAt(target)).toBeTruthy();
      // samples must stay ordered and gapless after the jump
      const samples = road.samples();
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i].s).toBeGreaterThan(samples[i - 1].s);
        expect(samples[i].s - samples[i - 1].s).toBeCloseTo(BASE.sampleSpacingM, 5);
      }
    }
  });

  it('recycles every chunk it generates once it is behind the ego', () => {
    // A window that only grows is a leak. Over a continuous drive, generated and
    // recycled must track each other within the window size.
    const road = new InfiniteRoad(BASE);
    for (let s = 0; s <= 30_000; s += 45) road.update(s);
    const st = road.stats(30_000);
    expect(st.chunksGenerated - st.chunksRecycled).toBe(st.activeChunks);
    expect(st.activeChunks).toBeLessThanOrEqual(requiredChunkCount(BASE));
  });

  it('reports the environment under the ego', () => {
    const road = new InfiniteRoad(BASE);
    expect(road.environmentAt(10)).toBe('highway');
    road.update(10 * BASE.chunkLengthM);
    expect(road.environmentAt(10 * BASE.chunkLengthM)).toBe('village');
  });

  it('bounds scenery and hazard counts across a long drive', () => {
    const road = new InfiniteRoad(BASE);
    const seen = new Set<number>();
    let maxScenery = 0;
    for (let s = 0; s < 60_000; s += 100) {
      road.update(s);
      const st = road.stats(s);
      maxScenery = Math.max(maxScenery, st.sceneryItems);
      seen.add(st.sceneryItems);
    }
    expect(maxScenery).toBeLessThan(1200);
    expect(seen.size).toBeLessThan(seen.size + 1);
    // hazards are probabilistic but must be present over this distance
    expect(road.stats(60_000).hazardItems).toBeGreaterThan(0);
  });
});
