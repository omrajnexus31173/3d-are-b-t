/**
 * Sliding-window manager for the infinite road.
 *
 * Holds an ordered ring of chunks covering `[startS, startS + coveredLength]`.
 * As the ego advances, chunks that fall more than `retainBehind` chunks behind
 * are dropped from the front and new ones are appended at the back. The chain is
 * maintained by threading each chunk's exit pose into the next chunk's entry, so
 * a chunk is always generated from the same predecessor pose it had the first
 * time — rebuilding after a shift reproduces identical geometry.
 *
 * Nothing here touches THREE; the viewport turns `ChunkSceneryItem` / samples
 * into meshes. That split is what makes the acceptance tests possible in Node.
 */

import {
  InfiniteRoadConfig,
  RoadChunk,
  RoadEnvironment,
  buildChunk,
  environmentForChunk,
  requiredChunkCount,
} from './infiniteRoad';

export interface InfiniteRoadStats {
  /** Number of chunks currently alive. */
  activeChunks: number;
  /** Total arc length currently represented. */
  coveredLengthM: number;
  /** startS of the oldest live chunk. */
  windowStartS: number;
  /** Exclusive end of the covered range. */
  windowEndS: number;
  /** Chunks generated since construction (monotonic). */
  chunksGenerated: number;
  /** Chunks dropped since construction (monotonic). */
  chunksRecycled: number;
  /** Environment of the chunk the ego is currently in. */
  currentEnvironment: RoadEnvironment;
  /** Total scenery items across live chunks. */
  sceneryItems: number;
  /** Total hazard items across live chunks. */
  hazardItems: number;
  seed: number;
}

export class InfiniteRoad {
  readonly config: InfiniteRoadConfig;

  private chunks: RoadChunk[] = [];
  private nextIndex = 0;
  private generated = 0;
  private recycled = 0;
  private cursor = 0;

  constructor(config: InfiniteRoadConfig) {
    this.config = config;
    this.reset();
  }

  /** Rebuilds from chunk 0 with the current seed. */
  reset(): void {
    this.chunks = [];
    this.nextIndex = 0;
    this.generated = 0;
    this.recycled = 0;
    this.cursor = 0;
    this.fillTo(0);
  }

  private entryForIndex(index: number) {
    // Chunk 0 starts at the origin heading +x (matches the existing scenarios,
    // whose first road sample sits near x=0 with theta≈0).
    if (index === 0) {
      return { s: 0, x: 0, y: 0, theta: 0, curvature: 0 };
    }
    // Always thread from the previous chunk so the chain is exact. A chunk that
    // is no longer in the window is regenerated from its predecessor, which is
    // why generation must be pure.
    const prev = this.chunks[this.chunks.length - 1];
    if (prev && prev.index === index - 1) {
      return { s: prev.startS + prev.lengthM, ...prev.exit };
    }
    return this.regenerateEntryFor(index);
  }

  /**
   * Recomputes the entry pose for `index` when the chain is not contiguous
   * (e.g. after a large jump). Walks forward from the newest live chunk, or
   * backward by rebuilding from chunk 0. Bounded so it cannot run away.
   */
  private regenerateEntryFor(index: number) {
    const anchor = this.chunks[0];
    const anchorIndex = anchor ? anchor.index : 0;
    let s = anchor ? anchor.startS : 0;
    let x = 0;
    let y = 0;
    let theta = 0;
    let curvature = 0;

    if (anchorIndex > 0) {
      // Rebuild the chain from the origin up to the anchor.
      for (let i = 0; i < anchorIndex; i++) {
        const c = buildChunk(this.config, i, { s, x, y, theta, curvature });
        s = c.startS + c.lengthM;
        x = c.exit.x;
        y = c.exit.y;
        theta = c.exit.theta;
        curvature = c.exit.curvature;
      }
    } else if (anchor) {
      s = anchor.startS;
    }

    const start = Math.max(0, anchor ? anchor.index : 0);
    for (let i = start; i < index; i++) {
      const c = buildChunk(this.config, i, { s, x, y, theta, curvature });
      s = c.startS + c.lengthM;
      x = c.exit.x;
      y = c.exit.y;
      theta = c.exit.theta;
      curvature = c.exit.curvature;
    }
    return { s, x, y, theta, curvature };
  }

  /** Appends chunks until the window covers the configured length. */
  private fillTo(_targetIndex: number): void {
    const needed = requiredChunkCount(this.config);
    while (this.chunks.length < needed) {
      const entry = this.entryForIndex(this.nextIndex);
      const chunk = buildChunk(this.config, this.nextIndex, entry);
      this.chunks.push(chunk);
      this.generated += 1;
      this.nextIndex += 1;
    }
  }

  /**
   * Advances the window so it covers `egoS`. Cheap: usually zero or one
   * generation per call, because the window is many chunks long.
   */
  update(egoS: number): void {
    const behind = this.config.retainBehind;
    const chunkLen = this.config.chunkLengthM;

    /*
     * Discontinuity guard.
     *
     * Continuous driving advances the window one chunk at a time. A jump - a
     * debug teleport, or a resume far from where the chain currently sits - must
     * not be handled by topping up from the old window end, because that
     * generates every chunk in between (measured: 23 live chunks after a jump to
     * 2.4 km, 43 after 4.8 km, against a configured bound of 13). Re-anchor the
     * chain on the ego instead.
     */
    if (this.chunks.length === 0) {
      this.reset();
    }
    if (egoS > this.windowEndS || egoS < this.windowStartS) {
      this.recenter(egoS);
    }

    /*
     * Drop chunks that end before the retention horizon.
     *
     * The horizon is `egoS - retainBehind * chunkLen`, i.e. keep the last
     * `retainBehind` chunks' worth of road behind the car. The previous test was
     * `chunks[0].startS + chunkLen < egoS - chunkLen * behind`, which is the same
     * rule only while the window advances continuously. After a large forward
     * jump the *newly generated* chunks also satisfied it, so the loop deleted
     * them as fast as the top-up loop created them: the window stayed frozen
     * (observed: GEN/REC stuck at 51/38 while the ego passed 2.4 km) and chunkAt()
     * then read past the end of the array, throwing
     * "Cannot read properties of undefined (reading 'startS')".
     */
    const retainedFrom = egoS - chunkLen * behind;
    const maxChunks = requiredChunkCount(this.config);
    while (this.chunks.length > behind + 1) {
      const first = this.chunks[0];
      const endsBeforeHorizon = first.startS + first.lengthM <= retainedFrom;
      // Also enforce the total-window bound. Coverage alone is not enough after a
      // jump: the top-up loop can overshoot, so retention alone left 23 live
      // chunks where the configured bound is 13.
      const overBudget = this.chunks.length > maxChunks;
      if (!endsBeforeHorizon && !overBudget) break;
      // Never drop the chunk the ego is actually standing on.
      if (this.chunks.length <= behind + 1) break;
      this.chunks.shift();
      this.recycled += 1;
    }

    // Top up at the front so the lookahead is always satisfied.
    while (this.chunks.length > 0) {
      const last = this.chunks[this.chunks.length - 1];
      if (last.startS + last.lengthM >= egoS + this.config.lookaheadM) break;
      const entry = this.entryForIndex(this.nextIndex);
      const chunk = buildChunk(this.config, this.nextIndex, entry);
      this.chunks.push(chunk);
      this.generated += 1;
      this.nextIndex += 1;
    }

    // Keep the cursor near the ego for O(1) lookups.
    while (
      this.cursor + 1 < this.chunks.length &&
      this.chunks[this.cursor + 1].startS <= egoS
    ) {
      this.cursor += 1;
    }
    while (this.cursor > 0 && this.chunks[this.cursor].startS > egoS) {
      this.cursor -= 1;
    }
  }

  /**
   * Rebuilds the window so it is anchored on `targetS`.
   *
   * Regenerates the deterministic chain from chunk 0 up to the anchor. That is
   * O(targetIndex) chunk builds, which is fine for the only caller (a deliberate
   * jump) and is never on the continuous-driving path.
   */
  recenter(targetS: number): void {
    const chunkLen = this.config.chunkLengthM;
    const clamped = Math.max(0, targetS);
    const targetIndex = Math.max(0, Math.floor(clamped / chunkLen) - this.config.retainBehind);

    // Rebuild the entry pose for targetIndex by walking the chain from the start.
    let s = 0;
    let x = 0;
    let y = 0;
    let theta = 0;
    let curvature = 0;
    for (let i = 0; i < targetIndex; i++) {
      const c = buildChunk(this.config, i, { s, x, y, theta, curvature });
      s = c.startS + c.lengthM;
      x = c.exit.x;
      y = c.exit.y;
      theta = c.exit.theta;
      curvature = c.exit.curvature;
    }

    this.chunks = [];
    this.nextIndex = targetIndex;
    this.cursor = 0;

    const needed = requiredChunkCount(this.config);
    for (let i = 0; i < needed; i++) {
      const chunk = buildChunk(this.config, this.nextIndex, { s, x, y, theta, curvature });
      this.chunks.push(chunk);
      this.generated += 1;
      s = chunk.startS + chunk.lengthM;
      x = chunk.exit.x;
      y = chunk.exit.y;
      theta = chunk.exit.theta;
      curvature = chunk.exit.curvature;
      this.nextIndex += 1;
    }
  }

  get activeChunks(): number {
    return this.chunks.length;
  }

  get allChunks(): readonly RoadChunk[] {
    return this.chunks;
  }

  get windowStartS(): number {
    return this.chunks.length ? this.chunks[0].startS : 0;
  }

  get windowEndS(): number {
    if (!this.chunks.length) return 0;
    const last = this.chunks[this.chunks.length - 1];
    return last.startS + last.lengthM;
  }

  /** Chunk containing arc length `s`, clamped to the live window. */
  chunkAt(s: number): RoadChunk | null {
    if (!this.chunks.length) return null;
    const i = Math.max(0, Math.min(this.chunks.length - 1, Math.floor((s - this.windowStartS) / this.config.chunkLengthM)));
    // Correct the estimate: chunk lengths are uniform but indexing is safer.
    if (this.chunks[i] && this.chunks[i].startS <= s && s <= this.chunks[i].startS + this.chunks[i].lengthM) {
      return this.chunks[i];
    }
    for (const c of this.chunks) {
      if (s >= c.startS && s <= c.startS + c.lengthM) return c;
    }
    return s < this.windowStartS ? this.chunks[0] : this.chunks[this.chunks.length - 1];
  }

  environmentAt(s: number): RoadEnvironment {
    const c = this.chunkAt(s);
    return c ? c.environment : environmentForChunk(this.config, 0);
  }

  /** Flattened samples across the live window, ordered by s. */
  samples(): import('../types/simulation').RoadSample[] {
    const out: import('../types/simulation').RoadSample[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const samples = this.chunks[i].samples;
      // Skip the duplicated seam sample so s is strictly increasing.
      const from = i === 0 ? 0 : 1;
      for (let j = from; j < samples.length; j++) out.push(samples[j]);
    }
    return out;
  }

  environsAround(s: number, aheadM: number): RoadChunk[] {
    return this.chunks.filter((c) => c.startS + c.lengthM >= s && c.startS <= s + aheadM);
  }

  stats(egoS: number): InfiniteRoadStats {
    let sceneryItems = 0;
    let hazardItems = 0;
    for (const c of this.chunks) {
      sceneryItems += c.scenery.length;
      hazardItems += c.hazards.length;
    }
    return {
      activeChunks: this.chunks.length,
      coveredLengthM: this.windowEndS - this.windowStartS,
      windowStartS: this.windowStartS,
      windowEndS: this.windowEndS,
      chunksGenerated: this.generated,
      chunksRecycled: this.recycled,
      currentEnvironment: this.environmentAt(egoS),
      sceneryItems,
      hazardItems,
      seed: this.config.seed,
    };
  }
}
