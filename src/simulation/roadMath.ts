import { RoadSample, Vec2 } from '../types/simulation';

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + normalizeAngle(b - a) * t);
}

/**
 * Samples the road spline at arc length `s` (in meters) using linear interpolation
 * over pre-computed RoadSample nodes (spaced every ~2m).
 */
export function sampleRoadAtS(samples: RoadSample[], s: number): RoadSample {
  if (samples.length === 0) {
    return {
      s: 0,
      x: 0,
      y: 0,
      theta: 0,
      nx: 0,
      ny: 1,
      leftWidth: 4,
      rightWidth: 4,
      shoulderLeft: 1.5,
      shoulderRight: 1.5,
      hasLaneMarks: false,
    };
  }
  const maxS = samples[samples.length - 1].s;
  const clampedS = clamp(s, 0, maxS);
  // Binary search
  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s <= clampedS) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = Math.max(1e-5, b.s - a.s);
  const t = clamp((clampedS - a.s) / span, 0, 1);

  const theta = lerpAngle(a.theta, b.theta, t);
  return {
    s: clampedS,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    theta,
    nx: -Math.sin(theta),
    ny: Math.cos(theta),
    leftWidth: lerp(a.leftWidth, b.leftWidth, t),
    rightWidth: lerp(a.rightWidth, b.rightWidth, t),
    shoulderLeft: lerp(a.shoulderLeft, b.shoulderLeft, t),
    shoulderRight: lerp(a.shoulderRight, b.shoulderRight, t),
    hasLaneMarks: a.hasLaneMarks,
  };
}

/**
 * Converts Frenet (s, d) to World (x, y).
 * Convention: +d is driver's RIGHT (nx, ny) = (-sin(theta), cos(theta));
 * -d is driver's LEFT (LHT Indian nominal cruise lane).
 */
export function frenetToWorld(
  samples: RoadSample[],
  s: number,
  d: number
): { x: number; y: number; theta: number; sample: RoadSample } {
  const sample = sampleRoadAtS(samples, s);
  return {
    x: sample.x + d * sample.nx,
    y: sample.y + d * sample.ny,
    theta: sample.theta,
    sample,
  };
}

/**
 * Projects World (x, y) onto the closest road arc length `s` and lateral offset `d`.
 * Uses a hintS window for O(1) fast projection when available, falling back to full scan.
 */
export function worldToFrenet(
  samples: RoadSample[],
  x: number,
  y: number,
  hintS?: number
): { s: number; d: number; sample: RoadSample } {
  let startIdx = 0;
  let endIdx = samples.length - 1;

  if (hintS !== undefined && samples.length > 12) {
    const approxIdx = Math.floor((clamp(hintS, 0, samples[samples.length - 1].s) / samples[samples.length - 1].s) * (samples.length - 1));
    startIdx = Math.max(0, approxIdx - 18);
    endIdx = Math.min(samples.length - 1, approxIdx + 18);
  }

  let bestIdx = startIdx;
  let bestDistSq = Infinity;
  for (let i = startIdx; i <= endIdx; i++) {
    const dx = x - samples[i].x;
    const dy = y - samples[i].y;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
    }
  }

  // Fallback to full scan if hint window missed
  if (hintS !== undefined && bestDistSq > 400) {
    for (let i = 0; i < samples.length; i++) {
      const dx = x - samples[i].x;
      const dy = y - samples[i].y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }
  }

  // Refine projection onto adjacent segments
  const i0 = Math.max(0, bestIdx - 1);
  const i1 = Math.min(samples.length - 1, bestIdx + 1);
  let bestS = samples[bestIdx].s;
  let bestD = 0;
  let minSegDistSq = Infinity;

  for (let i = i0; i < i1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const segX = b.x - a.x;
    const segY = b.y - a.y;
    const segLenSq = segX * segX + segY * segY;
    if (segLenSq < 1e-6) continue;
    const t = clamp(((x - a.x) * segX + (y - a.y) * segY) / segLenSq, 0, 1);
    const px = a.x + t * segX;
    const py = a.y + t * segY;
    const dx = x - px;
    const dy = y - py;
    const dSq = dx * dx + dy * dy;
    if (dSq < minSegDistSq) {
      minSegDistSq = dSq;
      bestS = lerp(a.s, b.s, t);
      const theta = lerpAngle(a.theta, b.theta, t);
      const nx = -Math.sin(theta);
      const ny = Math.cos(theta);
      bestD = dx * nx + dy * ny;
    }
  }

  // Exact end handling if single node
  if (i0 === i1) {
    const a = samples[bestIdx];
    bestS = a.s;
    bestD = (x - a.x) * a.nx + (y - a.y) * a.ny;
  }

  return {
    s: bestS,
    d: bestD,
    sample: sampleRoadAtS(samples, bestS),
  };
}

/**
 * Generates dense RoadSamples (every ~2m) from a list of waypoints with variable road widths.
 */
export function buildRoadFromControlPoints(
  waypoints: {
    x: number;
    y: number;
    leftWidth: number;
    rightWidth: number;
    shoulderLeft: number;
    shoulderRight: number;
    hasLaneMarks: boolean;
  }[],
  spacingM = 2.0
): RoadSample[] {
  if (waypoints.length < 2) return [];
  // First compute cumulative chord lengths
  const cumLen: number[] = [0];
  for (let i = 1; i < waypoints.length; i++) {
    const dx = waypoints[i].x - waypoints[i - 1].x;
    const dy = waypoints[i].y - waypoints[i - 1].y;
    cumLen.push(cumLen[i - 1] + Math.hypot(dx, dy));
  }
  const totalLen = cumLen[cumLen.length - 1];
  const steps = Math.max(2, Math.round(totalLen / spacingM));

  // Catmull-Rom smooth interpolation across waypoints
  const rawPts: {
    x: number;
    y: number;
    leftWidth: number;
    rightWidth: number;
    shoulderLeft: number;
    shoulderRight: number;
    hasLaneMarks: boolean;
  }[] = [];

  for (let k = 0; k <= steps; k++) {
    const targetLen = (k / steps) * totalLen;
    let seg = 0;
    while (seg < cumLen.length - 2 && cumLen[seg + 1] < targetLen) seg++;
    const segSpan = Math.max(1e-5, cumLen[seg + 1] - cumLen[seg]);
    const t = clamp((targetLen - cumLen[seg]) / segSpan, 0, 1);

    const p0 = waypoints[Math.max(0, seg - 1)];
    const p1 = waypoints[seg];
    const p2 = waypoints[Math.min(waypoints.length - 1, seg + 1)];
    const p3 = waypoints[Math.min(waypoints.length - 1, seg + 2)];

    const t2 = t * t;
    const t3 = t2 * t;
    const cr = (v0: number, v1: number, v2: number, v3: number) =>
      0.5 *
      (2 * v1 +
        (-v0 + v2) * t +
        (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
        (-v0 + 3 * v1 - 3 * v2 + v3) * t3);

    rawPts.push({
      x: cr(p0.x, p1.x, p2.x, p3.x),
      y: cr(p0.y, p1.y, p2.y, p3.y),
      leftWidth: lerp(p1.leftWidth, p2.leftWidth, t),
      rightWidth: lerp(p1.rightWidth, p2.rightWidth, t),
      shoulderLeft: lerp(p1.shoulderLeft, p2.shoulderLeft, t),
      shoulderRight: lerp(p1.shoulderRight, p2.shoulderRight, t),
      hasLaneMarks: p1.hasLaneMarks,
    });
  }

  // Recompute exact arc length & smooth tangents
  const samples: RoadSample[] = [];
  let s = 0;
  for (let i = 0; i < rawPts.length; i++) {
    if (i > 0) {
      s += Math.hypot(rawPts[i].x - rawPts[i - 1].x, rawPts[i].y - rawPts[i - 1].y);
    }
    const prev = rawPts[Math.max(0, i - 1)];
    const next = rawPts[Math.min(rawPts.length - 1, i + 1)];
    const theta = Math.atan2(next.y - prev.y, next.x - prev.x);
    samples.push({
      s,
      x: rawPts[i].x,
      y: rawPts[i].y,
      theta,
      nx: -Math.sin(theta),
      ny: Math.cos(theta),
      leftWidth: rawPts[i].leftWidth,
      rightWidth: rawPts[i].rightWidth,
      shoulderLeft: rawPts[i].shoulderLeft,
      shoulderRight: rawPts[i].shoulderRight,
      hasLaneMarks: rawPts[i].hasLaneMarks,
    });
  }
  return samples;
}

/**
 * Signed/unsigned clearance between two oriented rectangles (approximated tightly via
 * multi-circle decomposition along vehicle length for O(1) real-time speed & smoothness).
 */
export function approxObbDistance(
  ax: number,
  ay: number,
  atheta: number,
  aLen: number,
  aWid: number,
  bx: number,
  by: number,
  btheta: number,
  bLen: number,
  bWid: number
): number {
  const aR = aWid * 0.5;
  const bR = bWid * 0.5;
  const aCos = Math.cos(atheta);
  const aSin = Math.sin(atheta);
  const bCos = Math.cos(btheta);
  const bSin = Math.sin(btheta);

  const aOffsets = aLen > aWid * 1.3 ? [-0.32 * aLen, 0, 0.32 * aLen] : [0];
  const bOffsets = bLen > bWid * 1.3 ? [-0.32 * bLen, 0, 0.32 * bLen] : [0];

  let minClearance = Infinity;
  for (let i = 0; i < aOffsets.length; i++) {
    const cx1 = ax + aOffsets[i] * aCos;
    const cy1 = ay + aOffsets[i] * aSin;
    for (let j = 0; j < bOffsets.length; j++) {
      const cx2 = bx + bOffsets[j] * bCos;
      const cy2 = by + bOffsets[j] * bSin;
      const d = Math.hypot(cx1 - cx2, cy1 - cy2) - (aR + bR);
      if (d < minClearance) minClearance = d;
    }
  }
  return minClearance;
}

/**
 * Ray-OBB intersection distance for realistic LiDAR raycasting.
 * Returns distance along ray if hit within [0, maxRange], else null.
 */
export function rayIntersectObb(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxRange: number,
  bx: number,
  by: number,
  bTheta: number,
  bLength: number,
  bWidth: number
): number | null {
  // Transform ray into OBB local frame
  const relX = ox - bx;
  const relY = oy - by;
  const cos = Math.cos(-bTheta);
  const sin = Math.sin(-bTheta);

  const lox = relX * cos - relY * sin;
  const loy = relX * sin + relY * cos;
  const ldx = dx * cos - dy * sin;
  const ldy = dx * sin + dy * cos;

  const hx = bLength * 0.5;
  const hy = bWidth * 0.5;

  let tMin = 0;
  let tMax = maxRange;

  if (Math.abs(ldx) < 1e-8) {
    if (lox < -hx || lox > hx) return null;
  } else {
    const inv = 1 / ldx;
    let t1 = (-hx - lox) * inv;
    let t2 = (hx - lox) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  if (Math.abs(ldy) < 1e-8) {
    if (loy < -hy || loy > hy) return null;
  } else {
    const inv = 1 / ldy;
    let t1 = (-hy - loy) * inv;
    let t2 = (hy - loy) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return tMin >= 0 && tMin <= maxRange ? tMin : null;
}

export function pointInPolygonHint(p: Vec2, cx: number, cy: number, r: number): boolean {
  return Math.hypot(p.x - cx, p.y - cy) <= r;
}
