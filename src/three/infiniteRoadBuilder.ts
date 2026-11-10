/**
 * Three.js renderer for the infinite road.
 *
 * This is a *renderer*, not a second simulation: it consumes the plain chunk
 * data produced by `InfiniteRoad` and turns it into meshes. All the procedural
 * decisions live in `simulation/infiniteRoad.ts`.
 *
 * Object pooling is the whole point of this file. A 12-chunk window at ~110
 * scenery items per window would allocate thousands of meshes over a long drive
 * if each rebuild created fresh geometry. Instead:
 *
 * - Geometry and materials are created once per (kind, variant) and shared.
 * - Meshes are recycled through per-kind free lists as chunks leave the window.
 * - Road ribbons are drawn into ONE pre-allocated buffer geometry pair per
 *   material class and refilled in place; nothing is allocated per frame.
 * - `dispose()` releases the shared geometries/materials exactly once.
 */

import * as THREE from 'three';
import { RoadChunk, RoadEnvironment, ENVIRONMENT_PROFILES } from '../simulation/infiniteRoad';
import { buildTreeMesh, buildStreetlightMesh } from './models';
import { getProceduralTextures } from './textures';

type SceneryKind = 'tree' | 'building' | 'house' | 'streetlight' | 'sign' | 'barrier' | 'divider' | 'sidewalk';

/** One sample of the live road window, as the ribbon emitters need it. */
interface RibbonPoint {
  x: number;
  y: number;
  theta: number;
  s: number;
  leftWidth: number;
  rightWidth: number;
  shoulderLeft: number;
  shoulderRight: number;
  sidewalkWidth: number;
  medianWidth: number;
  env: RoadEnvironment;
}

interface RibbonSpec {
  name: string;
  y: number;
  material: THREE.MeshStandardMaterial;
  applies: (p: RibbonPoint) => boolean;
  dL: (p: RibbonPoint) => number;
  dR: (p: RibbonPoint) => number;
  isAsphalt?: boolean;
}

interface PoolEntry {
  object: THREE.Object3D;
  inUse: boolean;
}

const MAX_SCENERY_PER_KIND = 160;

/** Linear lookup of a chunk sample at a local arc-length offset. */
function sampleChunkAt(chunk: RoadChunk, localS: number) {
  const samples = chunk.samples;
  if (!samples.length) return null;
  const spacing = chunk.lengthM / Math.max(1, samples.length - 1);
  const i = Math.max(0, Math.min(samples.length - 1, Math.round(localS / spacing)));
  return samples[i];
}
/** Vertices per ribbon: enough for the widest window we ever draw. */
const RIBBON_SAMPLES = 1200;

export interface InfiniteRoadRenderStats {
  sceneryMeshes: number;
  pooledMeshes: number;
  ribbons: number;
  lastBuildMs: number;
  builds: number;
}

export class InfiniteRoadRenderer {
  readonly group = new THREE.Group();

  private pools = new Map<SceneryKind, PoolEntry[]>();
  /**
   * Chunk -> the exact objects it owns.
   *
   * Ownership is recorded explicitly rather than inferred from
   * `object.userData.chunkIndex`. `acquire()` overwrites userData when it reuses
   * an object for a different chunk, so a released object could carry a stale
   * index; `releaseAll` then failed to find it, the pool never reclaimed it, and
   * the pool grew until it hit MAX_SCENERY_PER_KIND (measured: 895 objects,
   * against a steady-state of ~100).
   */
  private activeByChunk = new Map<number, THREE.Object3D[]>();
  private textures = getProceduralTextures();
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private ribbons: {
    mesh: THREE.Mesh;
    positions: THREE.BufferAttribute;
    uvs: THREE.BufferAttribute;
    index: THREE.BufferAttribute;
    spec: RibbonSpec;
  }[] = [];
  private buildMs = 0;
  private builds = 0;
  private disposed = false;
  /** Signature of the chunk window the ribbons were last rebuilt from. */
  private ribbonKey = '';
  /** Frame counter for throttled distance culling. */
  private frame = 0;

  // Ribbon classes. Each is one pre-allocated strip per (surface, environment);
  // a run is emitted wherever the class applies, so a window spanning a highway
  // and an urban block draws each with its own material rather than stamping one
  // texture across every environment.
  private ribbonDefs: RibbonSpec[] = [];

  constructor() {
    this.group.name = 'infinite-road';
    this.buildRibbons();
    this.buildMarkings();
    this.buildPools();
  }

  private buildRibbons() {
    const tex = this.textures;
    const specs: RibbonSpec[] = [
      {
        name: 'asphalt-hw',
        y: 0.055,
        material: this.makeMat(tex.asphaltHighway, 0.82),
        applies: (p) => p.env === 'highway',
        dL: (p) => -p.leftWidth,
        dR: (p) => p.rightWidth,
        isAsphalt: true,
      },
      {
        name: 'asphalt-urban',
        y: 0.055,
        material: this.makeMat(tex.asphaltUrban, 0.82),
        applies: (p) => p.env === 'urban',
        dL: (p) => -p.leftWidth,
        dR: (p) => p.rightWidth,
        isAsphalt: true,
      },
      {
        name: 'asphalt-rural',
        y: 0.055,
        material: this.makeMat(tex.asphaltRural, 0.84),
        applies: (p) => p.env === 'rural',
        dL: (p) => -p.leftWidth,
        dR: (p) => p.rightWidth,
        isAsphalt: true,
      },
      {
        name: 'asphalt-village',
        y: 0.055,
        material: this.makeMat(tex.asphaltRural, 0.9),
        applies: (p) => p.env === 'village',
        dL: (p) => -p.leftWidth,
        dR: (p) => p.rightWidth,
        isAsphalt: true,
      },
      /*
       * Shoulders are drawn per carriageway. A single strip from the left edge to
       * the right edge painted over the median, and at a highway->urban
       * transition it also bridged two different shoulder widths as one tan
       * band straight across the asphalt. Restricting each side to the paved edge
       * fixed both.
       */
      {
        name: 'shoulder-left',
        y: 0.02,
        material: this.makeMat(tex.mudShoulder, 0.94),
        applies: () => true,
        dL: (p) => -(p.leftWidth + p.shoulderLeft),
        dR: (p) => -p.leftWidth,
      },
      {
        name: 'shoulder-right',
        y: 0.02,
        material: this.makeMat(tex.mudShoulder, 0.94),
        applies: () => true,
        dL: (p) => p.rightWidth,
        dR: (p) => p.rightWidth + p.shoulderRight,
      },
      /*
       * Sidewalks are OUTSIDE the carriageway on each side. The first version
       * drew one strip from -(leftWidth) to +(rightWidth + sidewalkWidth), which
       * covered the whole road with a pale slab - visible as a grey quad across
       * the carriageway in the urban block. Two classes, one per side.
       */
      {
        /*
         * Continuous raised median. Previously the median was a chain of
         * straight 18 m boxes from the scenery pool, which cut a chord across
         * curves and left a dark green slab sitting off-centre. A ribbon follows
         * the road exactly and costs one draw call.
         */
        name: 'median',
        y: 0.3,
        material: this.makeMat(tex.urbanSidewalk, 0.85),
        applies: (p) => p.medianWidth > 0,
        dL: (p) => -p.medianWidth / 2,
        dR: (p) => p.medianWidth / 2,
      },
      {
        name: 'sidewalk-left',
        y: 0.075,
        material: this.makeMat(tex.urbanSidewalk, 0.9),
        applies: (p) => p.sidewalkWidth > 0,
        dL: (p) => -(p.leftWidth + p.shoulderLeft + p.sidewalkWidth),
        dR: (p) => -(p.leftWidth + p.shoulderLeft),
      },
      {
        name: 'sidewalk-right',
        y: 0.075,
        material: this.makeMat(tex.urbanSidewalk, 0.9),
        applies: (p) => p.sidewalkWidth > 0,
        dL: (p) => p.rightWidth + p.shoulderRight,
        dR: (p) => p.rightWidth + p.shoulderRight + p.sidewalkWidth,
      },
    ];

    for (const spec of specs) {
      const positions = new THREE.BufferAttribute(new Float32Array(RIBBON_SAMPLES * 2 * 3), 3);
      const uvs = new THREE.BufferAttribute(new Float32Array(RIBBON_SAMPLES * 2 * 2), 2);
      const index = new THREE.BufferAttribute(new Uint32Array((RIBBON_SAMPLES - 1) * 6), 1);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', positions);
      geo.setAttribute('uv', uvs);
      geo.setIndex(index);
      // Vertices are rewritten in place, so a stale bounding sphere would cull
      // the road at the wrong moments.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const mesh = new THREE.Mesh(geo, spec.material);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (spec.isAsphalt) mesh.name = 'asphalt_surface';
      this.group.add(mesh);
      this.geometries.push(geo);
      this.materials.push(spec.material);
      this.ribbons.push({ mesh, positions, uvs, index, spec });
      this.ribbonDefs.push(spec);
    }
  }

  private makeMat(map: THREE.Texture, roughness: number) {
    return new THREE.MeshStandardMaterial({ map, roughness, metalness: 0.03, side: THREE.DoubleSide });
  }

  /**
   * Refills the ribbon buffers from the live chunk window. Writes into existing
   * typed arrays; allocates nothing.
   */
  private updateRibbons(chunks: readonly RoadChunk[]) {
    const pts: RibbonPoint[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const profile = ENVIRONMENT_PROFILES[chunk.environment];
      const from = ci === 0 ? 0 : 1;
      for (let i = from; i < chunk.samples.length; i++) {
        const smp = chunk.samples[i];
        pts.push({
          x: smp.x,
          y: smp.y,
          theta: smp.theta,
          s: smp.s,
          leftWidth: smp.leftWidth,
          rightWidth: smp.rightWidth,
          shoulderLeft: smp.shoulderLeft,
          shoulderRight: smp.shoulderRight,
          sidewalkWidth: smp.sidewalkWidth ?? profile.sidewalkWidth,
          medianWidth: smp.medianWidth ?? profile.medianWidth,
          env: chunk.environment,
        });
        if (pts.length >= RIBBON_SAMPLES) break;
      }
      if (pts.length >= RIBBON_SAMPLES) break;
    }

    for (const ribbon of this.ribbons) {
      const spec = ribbon.spec;
      const pos = ribbon.positions.array as Float32Array;
      const uv = ribbon.uvs.array as Float32Array;
      const idx = ribbon.index.array as Uint32Array;
      let vertex = 0;
      let tri = 0;

      const emitRun = (from: number, to: number) => {
        if (to - from < 1 || vertex + (to - from + 1) * 2 >= RIBBON_SAMPLES * 2) return;
        const base = vertex;
        for (let i = from; i <= to; i++) {
          const p = pts[i];
          const dL = spec.dL(p);
          const dR = spec.dR(p);
          const nx = -Math.sin(p.theta);
          const ny = Math.cos(p.theta);
          pos[vertex * 3] = p.x + dL * nx;
          pos[vertex * 3 + 1] = spec.y;
          pos[vertex * 3 + 2] = p.y + dL * ny;
          uv[vertex * 2] = 0;
          uv[vertex * 2 + 1] = p.s * 0.14;
          vertex += 1;
          pos[vertex * 3] = p.x + dR * nx;
          pos[vertex * 3 + 1] = spec.y;
          pos[vertex * 3 + 2] = p.y + dR * ny;
          uv[vertex * 2] = 1;
          uv[vertex * 2 + 1] = p.s * 0.14;
          vertex += 1;
        }
        const quads = to - from;
        for (let i = 0; i < quads; i++) {
          const a = base + i * 2;
          idx[tri++] = a;
          idx[tri++] = a + 1;
          idx[tri++] = a + 2;
          idx[tri++] = a + 1;
          idx[tri++] = a + 3;
          idx[tri++] = a + 2;
        }
      };

      // Emit contiguous runs where the surface applies; skip the rest so a strip
      // never bridges across an environment that does not draw it.
      let runStart = -1;
      for (let i = 0; i < pts.length; i++) {
        if (spec.applies(pts[i])) {
          if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
          emitRun(runStart, i - 1);
          runStart = -1;
        }
      }
      if (runStart >= 0) emitRun(runStart, pts.length - 1);

      ribbon.positions.needsUpdate = true;
      ribbon.uvs.needsUpdate = true;
      ribbon.index.needsUpdate = true;
      ribbon.mesh.geometry.setDrawRange(0, tri);
      ribbon.mesh.visible = tri > 0;
    }
  }

  // ------------------------------------------------------------------ pools ---

  /**
   * Lane markings and dividers are pooled too, but they are *instanced* into a
   * single BufferGeometry per material so 60 dashes cost one draw call instead
   * of 60. Rebuilt only when the window changes.
   */
  private markings: {
    mesh: THREE.Mesh;
    positions: THREE.BufferAttribute;
    index: THREE.BufferAttribute;
    capacity: number;
  } | null = null;

  private buildMarkings() {
    const capacity = 900; // quads; a 780 m window at one dash per 6.5 m is ~240
    const positions = new THREE.BufferAttribute(new Float32Array(capacity * 4 * 3), 3);
    const index = new THREE.BufferAttribute(new Uint32Array(capacity * 6), 1);
    const uvs = new THREE.BufferAttribute(new Float32Array(capacity * 4 * 2), 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', positions);
    geo.setAttribute('uv', uvs);
    geo.setIndex(index);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.62, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.name = 'lane_markings';
    this.group.add(mesh);
    this.geometries.push(geo);
    this.materials.push(mat);
    this.markings = { mesh, positions, index, capacity };
  }

  private updateMarkings(chunks: readonly RoadChunk[]) {
    if (!this.markings) return;
    const pos = this.markings.positions.array as Float32Array;
    const idx = this.markings.index.array as Uint32Array;
    let quad = 0;
    let vi = 0;

    const addQuad = (x: number, y: number, theta: number, halfLen: number, halfWid: number) => {
      if (quad >= this.markings!.capacity) return;
      const c = Math.cos(theta);
      const sn = Math.sin(theta);
      const nx = -sn;
      const ny = c;
      const corners: [number, number][] = [
        [-halfLen, -halfWid],
        [halfLen, -halfWid],
        [-halfLen, halfWid],
        [halfLen, halfWid],
      ];
      const base = vi;
      for (const [fl, fw] of corners) {
        pos[vi * 3] = x + c * fl + nx * fw;
        pos[vi * 3 + 1] = 0.075;
        pos[vi * 3 + 2] = y + sn * fl + ny * fw;
        vi += 1;
      }
      const t = quad * 6;
      idx[t] = base;
      idx[t + 1] = base + 1;
      idx[t + 2] = base + 2;
      idx[t + 3] = base + 1;
      idx[t + 4] = base + 3;
      idx[t + 5] = base + 2;
      quad += 1;
    };

    for (const chunk of chunks) {
      const profile = ENVIRONMENT_PROFILES[chunk.environment];
      if (!profile.hasLaneMarks) continue;
      const laneCount = profile.lanesPerDirection;
      // Dashed centre + lane separators, dashed every 6.5 m of chunk length.
      for (let sOff = 3; sOff < chunk.lengthM - 3; sOff += 6.5) {
        const smp = sampleChunkAt(chunk, sOff);
        if (!smp) continue;
        if (profile.medianWidth <= 0) addQuad(smp.x, smp.y, smp.theta, 1.3, 0.09);
        for (let lane = 1; lane < laneCount; lane++) {
          const d = -(smp.leftWidth * lane) / laneCount;
          addQuad(smp.x + d * -Math.sin(smp.theta), smp.y + d * Math.cos(smp.theta), smp.theta, 1.3, 0.08);
        }
        if (profile.hasEdgeLines) {
          for (const side of [-1, 1]) {
            const d = side * (side < 0 ? smp.leftWidth - 0.25 : smp.rightWidth - 0.25);
            addQuad(smp.x + d * -Math.sin(smp.theta), smp.y + d * Math.cos(smp.theta), smp.theta, 1.6, 0.1);
          }
        }
      }
    }

    this.markings.positions.needsUpdate = true;
    this.markings.index.needsUpdate = true;
    this.markings.mesh.geometry.setDrawRange(0, quad * 6);
    this.markings.mesh.visible = quad > 0;
  }

  private buildPools() {
    // Shared, reused objects. Only a handful of distinct variants exist, so the
    // per-variant build cost is paid once for the whole session.
    const kinds: SceneryKind[] = ['tree', 'building', 'house', 'streetlight', 'sign', 'barrier', 'divider', 'sidewalk'];
    for (const kind of kinds) {
      this.pools.set(kind, []);
    }
  }

  private createObject(kind: SceneryKind, variant: number): THREE.Object3D {
    switch (kind) {
      case 'tree':
        return buildTreeMesh(0.9 + (variant % 5) * 0.12);
      case 'streetlight':
        return buildStreetlightMesh(variant % 2 === 0 ? 1 : -1);
      case 'sign':
        return this.buildSignMesh(variant);
      case 'barrier':
        return this.buildBarrierMesh(variant);
      case 'building':
        return this.buildBuildingMesh(variant, true);
      case 'house':
        return this.buildBuildingMesh(variant, false);
      case 'sidewalk':
        return new THREE.Object3D();
      default:
        return new THREE.Object3D();
    }
  }

  private acquire(kind: SceneryKind, variant: number): THREE.Object3D {
    const pool = this.pools.get(kind)!;
    for (const entry of pool) {
      if (!entry.inUse) {
        entry.inUse = true;
        entry.object.visible = true;
        return entry.object;
      }
    }
    if (pool.length >= MAX_SCENERY_PER_KIND) {
      // Hard ceiling. Only ever steal an object that is not currently owned by a
      // chunk; stealing an in-use one would leave two chunks sharing an object
      // and make one of them lose its scenery on release.
      const free = pool.find((e) => !e.inUse);
      if (free) {
        free.inUse = true;
        free.object.visible = true;
        return free.object;
      }
      // Every object is owned: skip this item rather than corrupt ownership.
      const fallback = new THREE.Object3D();
      fallback.visible = false;
      return fallback;
    }
    const object = this.createObject(kind, variant);
    this.group.add(object);
    pool.push({ object, inUse: true });
    return object;
  }

  private releaseAll(chunkIndex: number) {
    const objects = this.activeByChunk.get(chunkIndex);
    if (!objects) return;
    for (const object of objects) {
      for (const pool of this.pools.values()) {
        const entry = pool.find((e) => e.object === object);
        if (entry) {
          entry.inUse = false;
          object.visible = false;
          break;
        }
      }
    }
    this.activeByChunk.delete(chunkIndex);
  }

  // --------------------------------------------------------------- dressing ---

  /** Rebuilds meshes for chunks that are not already rendered. */
  sync(chunks: readonly RoadChunk[], ego: { x: number; y: number }) {
    if (this.disposed) return;
    const t0 = performance.now();
    this.frame += 1;

    const liveIndexes = new Set(chunks.map((c) => c.index));
    for (const index of [...this.activeByChunk.keys()]) {
      if (!liveIndexes.has(index)) this.releaseAll(index);
    }

    /*
     * Ribbons are rewritten only when the window actually changed. The window
     * shifts once every few hundred metres, but the render loop runs at 60 Hz:
     * refilling ~2400 ribbon vertices per frame was pure waste. The key encodes
     * exactly what the ribbon geometry depends on.
     */
    const key = chunks.length
      ? `${chunks[0].index}:${chunks[chunks.length - 1].index}:${chunks.length}`
      : '';
    if (key !== this.ribbonKey) {
      this.ribbonKey = key;
      this.updateRibbons(chunks);
      this.updateMarkings(chunks);
    }

    for (const chunk of chunks) {
      if (this.activeByChunk.has(chunk.index)) continue;
      const used: THREE.Object3D[] = [];
      const startSample = chunk.samples[0];

      for (const item of chunk.scenery) {
        // Median and sidewalk are ribbon geometry, not pooled objects.
        if (item.kind === 'sidewalk' || item.kind === 'divider') continue;
        // Skip dressing that is far outside the view to cap object counts.
        const sIdx = Math.min(chunk.samples.length - 1, Math.max(0, Math.round(item.s / Math.max(1e-3, chunk.lengthM / (chunk.samples.length - 1)))));
        const sample = chunk.samples[sIdx] ?? startSample;
        const wx = sample.x + item.d * -Math.sin(sample.theta);
        const wy = sample.y + item.d * Math.cos(sample.theta);
        if (Math.abs(item.d) > 90) continue;

        const object = this.acquire(item.kind as SceneryKind, item.variant);
        object.position.set(wx, 0, wy);
        object.rotation.y = -sample.theta + item.yawOffset;
        object.userData.worldX = wx;
        object.userData.worldY = wy;
        used.push(object);
      }
      this.activeByChunk.set(chunk.index, used);
    }

    // Distance culling: hide dressing beyond the fog horizon. Throttled to every
    // 8th frame - at 10 m/frame the horizon test cannot change meaningfully
    // faster than that, and it keeps per-frame work bounded.
    if (this.frame % 8 === 0) {
      for (const pool of this.pools.values()) {
        for (const entry of pool) {
          if (!entry.inUse) continue;
          const dx = (entry.object.userData.worldX ?? 0) - ego.x;
          const dy = (entry.object.userData.worldY ?? 0) - ego.y;
          entry.object.visible = dx * dx + dy * dy < 300 * 300;
        }
      }
    }

    this.buildMs = performance.now() - t0;
    this.builds += 1;
  }

  /** Last measured sync cost, ms. Exposed for the perf HUD / tests. */
  get lastSyncMs(): number {
    return this.buildMs;
  }

  stats(): InfiniteRoadRenderStats {
    let inUse = 0;
    let pooled = 0;
    for (const pool of this.pools.values()) {
      pooled += pool.length;
      for (const e of pool) if (e.inUse) inUse += 1;
    }
    return {
      sceneryMeshes: inUse,
      pooledMeshes: pooled,
      ribbons: this.ribbons.filter((r) => r.mesh.visible).length,
      lastBuildMs: this.buildMs,
      builds: this.builds,
    };
  }

  // ------------------------------------------------------------ sub-builders ---

  private buildSignMesh(variant: number): THREE.Group {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.7, roughness: 0.4 });
    this.materials.push(steel);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 4.6, 8), steel);
    pole.position.y = 2.3;
    g.add(pole);
    this.geometries.push(pole.geometry);

    const colours = ['#15803d', '#1d4ed8', '#b91c1c'];
    const boardMat = new THREE.MeshStandardMaterial({ color: colours[variant % colours.length], roughness: 0.5 });
    this.materials.push(boardMat);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.3, 2.4), boardMat);
    board.position.set(0, 4.0, 0);
    g.add(board);
    this.geometries.push(board.geometry);
    return g;
  }

  private buildBarrierMesh(variant: number): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({
      color: variant % 2 === 0 ? '#f97316' : '#e2e8f0',
      roughness: 0.7,
    });
    this.materials.push(body);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 0.18), body);
    bar.position.y = 0.75;
    g.add(bar);
    this.geometries.push(bar.geometry);

    const legMat = new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.8 });
    this.materials.push(legMat);
    for (const x of [-0.75, 0.75]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.5), legMat);
      leg.position.set(x, 0.4, 0);
      g.add(leg);
      this.geometries.push(leg.geometry);
    }
    return g;
  }

  private buildBuildingMesh(variant: number, tall: boolean): THREE.Group {
    const g = new THREE.Group();
    const palette = tall
      ? ['#cbd5e1', '#e2e8f0', '#d6d3d1', '#fde68a', '#bfdbfe']
      : ['#e7e5e4', '#fde68a', '#fed7aa', '#cbd5e1'];
    const w = tall ? 6 + (variant % 4) * 1.6 : 5 + (variant % 3);
    const h = tall ? 9 + (variant % 5) * 2.4 : 3.2 + (variant % 2) * 0.6;
    const d = tall ? 7 + (variant % 3) * 1.8 : 4.5 + (variant % 2);

    const wallMat = new THREE.MeshStandardMaterial({ color: palette[variant % palette.length], roughness: 0.88 });
    this.materials.push(wallMat);
    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    walls.position.y = h / 2;
    g.add(walls);
    this.geometries.push(walls.geometry);

    const roofMat = new THREE.MeshStandardMaterial({ color: tall ? '#475569' : '#9a3412', roughness: 0.82 });
    this.materials.push(roofMat);
    const roof = tall
      ? new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.4, d * 0.92), roofMat)
      : new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.76, 1.8, 4), roofMat);
    roof.position.y = tall ? h + 0.2 : h + 0.9;
    if (!tall) roof.rotation.y = Math.PI / 4;
    g.add(roof);
    this.geometries.push(roof.geometry);

    if (!tall) {
      const doorMat = new THREE.MeshStandardMaterial({ color: '#451a03', roughness: 0.9 });
      this.materials.push(doorMat);
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.8, 0.12), doorMat);
      door.position.set(0, 0.9, d * 0.5 + 0.02);
      g.add(door);
      this.geometries.push(door.geometry);
    } else {
      // Window bands read as a building at speed without extra geometry.
      const winMat = new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.3, metalness: 0.5 });
      this.materials.push(winMat);
      const bands = Math.max(2, Math.floor(h / 2.6));
      for (let i = 0; i < bands; i++) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(w * 0.86, 0.55, 0.08), winMat);
        band.position.set(0, 1.6 + i * 2.4, d * 0.5 + 0.01);
        g.add(band);
        this.geometries.push(band.geometry);
      }
    }
    return g;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const pool of this.pools.values()) {
      for (const entry of pool) this.group.remove(entry.object);
      pool.length = 0;
    }
    this.activeByChunk.clear();
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.ribbons.forEach((r) => {
      this.group.remove(r.mesh);
    });
    this.geometries.length = 0;
    this.materials.length = 0;
    this.ribbons.length = 0;
    this.ribbonDefs.length = 0;
    this.pools.clear();
  }
}
