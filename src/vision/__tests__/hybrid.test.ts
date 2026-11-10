import { describe, expect, it } from 'vitest';
import {
  cameraDetectionsToTrackedObjects,
  summarisePerception,
  visionClassToAgentClass,
} from '../hybrid';
import type { CameraDetection, VisionClassId } from '../types';
import type { TrackedObject } from '../../types/simulation';

function detection(
  trackId: string,
  classId: VisionClassId,
  opts: Partial<CameraDetection> = {}
): CameraDetection {
  return {
    trackId,
    classId,
    modelLabel: classId,
    confidence: 0.8,
    box: { x: 100, y: 100, width: 80, height: 160 },
    timestamp: 1_700_000_000_000,
    sourceId: 'local:default',
    sourceKind: 'webcam',
    frameWidth: 1280,
    frameHeight: 720,
    processingMs: 42,
    origin: 'camera',
    distance: { value: null, provenance: 'unavailable' },
    riskLevel: 'MEDIUM',
    riskBasis: 'test',
    ...opts,
  };
}

const simObject = (id: string, risk: TrackedObject['riskLevel'] = 'LOW'): TrackedObject => ({
  id,
  trackId: id,
  agentClass: 'car',
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  speed: 0,
  theta: 0,
  length: 4,
  width: 2,
  dist: 12,
  ttc: 5,
  confidence: 0.9,
  detectedBy: ['LiDAR', 'Camera'],
  riskLevel: risk,
  behaviorHint: 'CRUISING',
  s: 0,
  d: 0,
});

describe('camera → simulation perception adapter', () => {
  it('prefixes ids so camera detections can never be mistaken for ground truth', () => {
    const [obj] = cameraDetectionsToTrackedObjects([detection('CAM-3', 'pedestrian')]);
    expect(obj.id).toBe('CAM-CAM-3');
    expect(obj.id.startsWith('CAM-')).toBe(true);
    expect(obj.detectedBy).toEqual(['Camera']);
  });

  it('never fabricates a metric distance (Infinity + "range unknown" hint)', () => {
    const [obj] = cameraDetectionsToTrackedObjects([detection('CAM-1', 'car')]);
    expect(obj.dist).toBe(Number.POSITIVE_INFINITY);
    expect(obj.ttc).toBe(Number.POSITIVE_INFINITY);
    expect(obj.behaviorHint).toMatch(/RANGE UNKNOWN/);
  });

  it('passes an estimated distance through and labels it as estimated', () => {
    const [obj] = cameraDetectionsToTrackedObjects([
      detection('CAM-2', 'car', {
        distance: { value: 14.6, provenance: 'estimated', basis: 'pinhole' },
      }),
    ]);
    expect(obj.dist).toBeCloseTo(14.6, 5);
    expect(obj.behaviorHint).toMatch(/EST RANGE/);
  });

  it('maps traffic classes onto the simulation taxonomy', () => {
    expect(visionClassToAgentClass('pedestrian')).toBe('pedestrian');
    expect(visionClassToAgentClass('cattle')).toBe('cattle');
    expect(visionClassToAgentClass('motorcycle')).toBe('two_wheeler');
    expect(visionClassToAgentClass('truck_bus')).toBe('bus_truck');
    expect(visionClassToAgentClass('pothole')).toBe('pothole');
  });

  it('keeps simulation and camera objects separate in the fused summary', () => {
    const camera = cameraDetectionsToTrackedObjects([
      detection('CAM-1', 'pedestrian', { riskLevel: 'CRITICAL' }),
      detection('CAM-2', 'car', { riskLevel: 'LOW' }),
    ]);
    const simulated = [simObject('A1'), simObject('A2', 'HIGH')];
    const summary = summarisePerception(simulated, camera);
    expect(summary.simulatedCount).toBe(2);
    expect(summary.cameraCount).toBe(2);
    expect(summary.fusedCount).toBe(4);
    expect(summary.criticalCount).toBe(1);
    expect(summary.highCount).toBe(1);
    expect(summary.overallRisk).toBe('CRITICAL');
    expect(summary.sources).toEqual(['simulation', 'camera']);
    // both worlds remain identifiable by id
    const ids = [...simulated, ...camera].map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports camera-only perception when simulation is not contributing', () => {
    const camera = cameraDetectionsToTrackedObjects([detection('CAM-1', 'car')]);
    const summary = summarisePerception([], camera);
    expect(summary.simulatedCount).toBe(0);
    expect(summary.cameraCount).toBe(1);
    expect(summary.sources).toEqual(['simulation', 'camera']);
  });
});
