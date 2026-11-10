import * as THREE from 'three';
import {
  LayerVisibility,
  SimulationState,
} from '../types/simulation';

const MAX_LIDAR_PTS = 96;
const MAX_CANDIDATE_LINES = 60;
const MAX_TRAJ_PTS = 24;
const MAX_BBOXES = 28;
const MAX_PRED_STEPS = 48;

export interface AutonomyVisualManager {
  group: THREE.Group;
  update: (sim: SimulationState, layers: LayerVisibility, nowSec: number) => void;
  dispose: () => void;
}

function getAgentBoxHeight(agentClass: string): number {
  switch (agentClass) {
    case 'bus_truck':
      return 2.95;
    case 'pushcart':
      return 2.15;
    case 'auto_rickshaw':
      return 1.85;
    case 'pedestrian':
      return 1.78;
    case 'two_wheeler':
      return 1.65;
    case 'car':
      return 1.55;
    case 'cattle':
      return 1.48;
    case 'barricade':
      return 1.25;
    case 'pothole':
      return 0.25;
    default:
      return 1.5;
  }
}

export function createAutonomyVisuals(): AutonomyVisualManager {
  const group = new THREE.Group();

  // 1. 3D LiDAR Point Cloud
  const lidarPositions = new Float32Array(MAX_LIDAR_PTS * 3);
  const lidarColors = new Float32Array(MAX_LIDAR_PTS * 3);
  const lidarGeo = new THREE.BufferGeometry();
  lidarGeo.setAttribute('position', new THREE.BufferAttribute(lidarPositions, 3));
  lidarGeo.setAttribute('color', new THREE.BufferAttribute(lidarColors, 3));
  const lidarMat = new THREE.PointsMaterial({
    size: 0.34,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const lidarPoints = new THREE.Points(lidarGeo, lidarMat);
  lidarPoints.frustumCulled = false;
  group.add(lidarPoints);

  // Subtle rotating LiDAR sweep disc around Ego
  const sweepGeo = new THREE.RingGeometry(0.4, 24, 36, 1, -0.35, 0.7);
  sweepGeo.rotateX(-Math.PI / 2);
  const sweepMat = new THREE.MeshBasicMaterial({
    color: '#06b6d4',
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const lidarSweepMesh = new THREE.Mesh(sweepGeo, sweepMat);
  group.add(lidarSweepMesh);

  // 2. Forward Camera FOV Cone Wedge
  const camFovGeo = new THREE.CircleGeometry(45, 32, -1.01, 2.02);
  camFovGeo.rotateX(-Math.PI / 2);
  const camFovMat = new THREE.MeshBasicMaterial({
    color: '#3b82f6',
    transparent: true,
    opacity: 0.085,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const camFovMesh = new THREE.Mesh(camFovGeo, camFovMat);
  group.add(camFovMesh);

  // 3. Long-Range Radar Arc
  const radarGeo = new THREE.CircleGeometry(64, 32, -0.4, 0.8);
  radarGeo.rotateX(-Math.PI / 2);
  const radarMat = new THREE.MeshBasicMaterial({
    color: '#10b981',
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const radarMesh = new THREE.Mesh(radarGeo, radarMat);
  group.add(radarMesh);

  // 4. Drivable Corridor Left & Right Dynamic Ribbons
  const makeLine = (maxPts: number, color: string, opacity: number) => {
    const pos = new Float32Array(maxPts * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const line = new THREE.Line(g, m);
    line.frustumCulled = false;
    return line;
  };

  const corridorLeftLine = makeLine(24, '#22d3ee', 0.72);
  const corridorRightLine = makeLine(24, '#22d3ee', 0.72);
  group.add(corridorLeftLine, corridorRightLine);

  // 5. Candidate Lattice Lines Pool
  const candidatePool: THREE.Line[] = [];
  for (let i = 0; i < MAX_CANDIDATE_LINES; i++) {
    const line = makeLine(MAX_TRAJ_PTS, '#94a3b8', 0.16);
    line.visible = false;
    candidatePool.push(line);
    group.add(line);
  }

  // 6. Selected Optimal Trajectory 3D Glowing Ribbon + Breadcrumb Pulses
  const ribbonSegments = MAX_TRAJ_PTS;
  const ribbonPositions = new Float32Array(ribbonSegments * 2 * 3);
  const ribbonIndices: number[] = [];
  for (let i = 0; i < ribbonSegments - 1; i++) {
    const a = i * 2;
    ribbonIndices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const ribbonGeo = new THREE.BufferGeometry();
  ribbonGeo.setAttribute('position', new THREE.BufferAttribute(ribbonPositions, 3));
  ribbonGeo.setIndex(ribbonIndices);
  const ribbonMat = new THREE.MeshBasicMaterial({
    color: '#06b6d4',
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const selectedRibbonMesh = new THREE.Mesh(ribbonGeo, ribbonMat);
  selectedRibbonMesh.frustumCulled = false;
  group.add(selectedRibbonMesh);

  // Breadcrumb spheres along planned trajectory
  const crumbPool: THREE.Mesh[] = [];
  const crumbGeo = new THREE.SphereGeometry(0.16, 10, 10);
  const crumbMat = new THREE.MeshBasicMaterial({ color: '#ecfeff' });
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(crumbGeo, crumbMat);
    m.visible = false;
    crumbPool.push(m);
    group.add(m);
  }

  // 7. 3D AI Detection Wireframe Bounding Boxes Pool
  const baseEdgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const bboxPool: { line: THREE.LineSegments; ring: THREE.Mesh }[] = [];
  const dangerRingGeo = new THREE.RingGeometry(0.85, 1.0, 28);
  dangerRingGeo.rotateX(-Math.PI / 2);

  for (let i = 0; i < MAX_BBOXES; i++) {
    const mat = new THREE.LineBasicMaterial({
      color: '#22d3ee',
      transparent: true,
      opacity: 0.9,
    });
    const line = new THREE.LineSegments(baseEdgeGeo, mat);
    line.visible = false;

    const ringMat = new THREE.MeshBasicMaterial({
      color: '#f43f5e',
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(dangerRingGeo, ringMat);
    ring.visible = false;

    bboxPool.push({ line, ring });
    group.add(line, ring);
  }

  // 8. Prediction Uncertainty Ellipses Pool
  const predDiscGeo = new THREE.RingGeometry(0.84, 1.0, 24);
  predDiscGeo.rotateX(-Math.PI / 2);
  const predFillGeo = new THREE.CircleGeometry(0.88, 24);
  predFillGeo.rotateX(-Math.PI / 2);

  const predPool: { ring: THREE.Mesh; fill: THREE.Mesh }[] = [];
  for (let i = 0; i < MAX_PRED_STEPS; i++) {
    const rMat = new THREE.MeshBasicMaterial({
      color: '#f59e0b',
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const fMat = new THREE.MeshBasicMaterial({
      color: '#f59e0b',
      transparent: true,
      opacity: 0.11,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(predDiscGeo, rMat);
    const fill = new THREE.Mesh(predFillGeo, fMat);
    ring.visible = false;
    fill.visible = false;
    predPool.push({ ring, fill });
    group.add(ring, fill);
  }

  // 9. Ego Safety Envelope Halo on ground
  const egoRingGeo = new THREE.RingGeometry(2.35, 2.5, 36);
  egoRingGeo.rotateX(-Math.PI / 2);
  const egoRingMat = new THREE.MeshBasicMaterial({
    color: '#06b6d4',
    transparent: true,
    opacity: 0.32,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const egoSafetyRing = new THREE.Mesh(egoRingGeo, egoRingMat);
  group.add(egoSafetyRing);

  const update = (sim: SimulationState, layers: LayerVisibility, nowSec: number) => {
    const { ego, perception, planner, predictions } = sim;

    // Ego safety halo
    egoSafetyRing.position.set(ego.x, 0.06, ego.y);
    egoRingMat.color.set(
      planner.state === 'EMERGENCY_EVADE'
        ? '#f43f5e'
        : planner.state === 'YIELD_CREEP'
        ? '#f59e0b'
        : '#06b6d4'
    );

    // 1. LiDAR Point Cloud & Rotating Sweep
    lidarPoints.visible = layers.lidar;
    lidarSweepMesh.visible = layers.lidar;
    if (layers.lidar) {
      lidarSweepMesh.position.set(ego.x, 0.14, ego.y);
      lidarSweepMesh.rotation.y = -sim.lidarSpinAngle;

      const hits = perception.lidarHits;
      let count = 0;
      const posAttr = lidarGeo.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = lidarGeo.getAttribute('color') as THREE.BufferAttribute;

      for (let i = 0; i < hits.length && count < MAX_LIDAR_PTS; i++) {
        const hit = hits[i];
        if (hit.hitType === 'clear') continue;
        const yH = hit.hitType === 'agent' ? 0.92 : 0.22;
        posAttr.setXYZ(count, hit.x, yH, hit.y);
        if (hit.hitType === 'agent') {
          colAttr.setXYZ(count, 0.13, 0.9, 0.98);
        } else {
          colAttr.setXYZ(count, 0.58, 0.65, 0.75);
        }
        count++;
      }
      lidarGeo.setDrawRange(0, count);
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }

    // 2. Camera FOV Wedge
    camFovMesh.visible = layers.cameraFov;
    if (layers.cameraFov) {
      camFovMesh.position.set(ego.x, 0.055, ego.y);
      camFovMesh.rotation.y = -ego.theta;
    }

    // 3. Radar Sector
    radarMesh.visible = layers.radar;
    if (layers.radar) {
      radarMesh.position.set(ego.x, 0.048, ego.y);
      radarMesh.rotation.y = -ego.theta;
    }

    // 4. Drivable Corridor Envelope
    corridorLeftLine.visible = layers.corridor;
    corridorRightLine.visible = layers.corridor;
    if (layers.corridor) {
      const updateRibbonLine = (line: THREE.Line, pts: { x: number; y: number }[]) => {
        const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        const n = Math.min(24, pts.length);
        for (let i = 0; i < n; i++) {
          attr.setXYZ(i, pts[i].x, 0.11, pts[i].y);
        }
        line.geometry.setDrawRange(0, n);
        attr.needsUpdate = true;
      };
      updateRibbonLine(corridorLeftLine, perception.corridor.leftPoints);
      updateRibbonLine(corridorRightLine, perception.corridor.rightPoints);
    }

    // 5. Candidate Lattice + Selected Optimal 3D Ribbon
    const showLattice = layers.candidates;
    selectedRibbonMesh.visible = showLattice;

    for (let i = 0; i < MAX_CANDIDATE_LINES; i++) {
      candidatePool[i].visible = false;
    }
    for (let i = 0; i < crumbPool.length; i++) {
      crumbPool[i].visible = false;
    }

    if (showLattice) {
      let cIdx = 0;
      for (let i = 0; i < planner.candidates.length && cIdx < MAX_CANDIDATE_LINES; i++) {
        const cand = planner.candidates[i];
        if (cand.isSelected) continue;
        if (cand.targetV === 0 && cand.feasible) continue;

        const line = candidatePool[cIdx++];
        line.visible = true;
        const mat = line.material as THREE.LineBasicMaterial;
        mat.color.set(cand.feasible ? '#94a3b8' : '#f43f5e');
        mat.opacity = cand.feasible ? 0.16 : 0.11;

        const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        attr.setXYZ(0, ego.x, 0.08, ego.y);
        const n = Math.min(MAX_TRAJ_PTS - 1, cand.points.length);
        for (let p = 0; p < n; p++) {
          attr.setXYZ(p + 1, cand.points[p].x, 0.08, cand.points[p].y);
        }
        line.geometry.setDrawRange(0, n + 1);
        attr.needsUpdate = true;
      }

      // Selected 3D Ribbon
      const sel = planner.selectedTrajectory;
      if (sel && sel.points.length > 0) {
        selectedRibbonMesh.visible = true;
        ribbonMat.color.set(
          planner.state === 'EMERGENCY_EVADE'
            ? '#fb7185'
            : planner.state === 'YIELD_CREEP'
            ? '#fbbf24'
            : planner.state === 'ADAPTIVE_OVERTAKE'
            ? '#6366f1'
            : '#06b6d4'
        );

        const pts = [{ x: ego.x, y: ego.y, theta: ego.theta }, ...sel.points];
        const n = Math.min(ribbonSegments, pts.length);
        const halfWidth = 0.42;
        const posAttr = ribbonGeo.getAttribute('position') as THREE.BufferAttribute;

        for (let i = 0; i < n; i++) {
          const pt = pts[i];
          const nx = -Math.sin(pt.theta) * halfWidth;
          const nz = Math.cos(pt.theta) * halfWidth;
          posAttr.setXYZ(i * 2, pt.x - nx, 0.115, pt.y - nz);
          posAttr.setXYZ(i * 2 + 1, pt.x + nx, 0.115, pt.y + nz);
        }
        ribbonGeo.setDrawRange(0, Math.max(0, (n - 1) * 6));
        posAttr.needsUpdate = true;

        // Animated forward flow breadcrumbs
        const phaseOffset = (nowSec * 3.5) % 2;
        let bIdx = 0;
        for (let i = 2 + Math.floor(phaseOffset); i < sel.points.length && bIdx < crumbPool.length; i += 2) {
          const pt = sel.points[i];
          const crumb = crumbPool[bIdx++];
          crumb.visible = true;
          crumb.position.set(pt.x, 0.22, pt.y);
        }
      } else {
        selectedRibbonMesh.visible = false;
      }
    }

    // 6. 3D AI Object Detection Wireframe Bounding Boxes & Danger Rings
    for (let i = 0; i < MAX_BBOXES; i++) {
      bboxPool[i].line.visible = false;
      bboxPool[i].ring.visible = false;
    }
    if (layers.labels) {
      let bIdx = 0;
      for (let i = 0; i < perception.trackedObjects.length && bIdx < MAX_BBOXES; i++) {
        const obj = perception.trackedObjects[i];
        if (obj.dist > 54) continue;
        const slot = bboxPool[bIdx++];
        const boxH = getAgentBoxHeight(obj.agentClass);

        const colHex =
          obj.riskLevel === 'CRITICAL'
            ? '#f43f5e'
            : obj.riskLevel === 'HIGH'
            ? '#f59e0b'
            : obj.riskLevel === 'MEDIUM'
            ? '#22d3ee'
            : '#64748b';

        slot.line.visible = true;
        slot.line.position.set(obj.x, boxH * 0.5 + 0.04, obj.y);
        slot.line.rotation.y = -obj.theta;
        slot.line.scale.set(obj.length + 0.35, boxH, obj.width + 0.35);
        (slot.line.material as THREE.LineBasicMaterial).color.set(colHex);

        // Pulsing ground warning circle under CRITICAL / HIGH objects
        if (obj.riskLevel === 'CRITICAL' || obj.riskLevel === 'HIGH') {
          slot.ring.visible = true;
          const pulse = 1 + 0.14 * Math.sin(nowSec * 8);
          const rad = Math.max(obj.length, obj.width) * 0.72 * pulse;
          slot.ring.position.set(obj.x, 0.075, obj.y);
          slot.ring.scale.set(rad, 1, rad);
          const rMat = slot.ring.material as THREE.MeshBasicMaterial;
          rMat.color.set(colHex);
          rMat.opacity = obj.riskLevel === 'CRITICAL' ? 0.55 : 0.3;
        }
      }
    }

    // 7. Prediction Uncertainty Ellipses
    for (let i = 0; i < MAX_PRED_STEPS; i++) {
      predPool[i].ring.visible = false;
      predPool[i].fill.visible = false;
    }
    if (layers.predictions) {
      let pIdx = 0;
      for (let i = 0; i < predictions.length && pIdx < MAX_PRED_STEPS; i++) {
        const pred = predictions[i];
        const isHighEntropy = pred.entropyScore > 0.7;
        const col = isHighEntropy ? '#f43f5e' : '#f59e0b';
        // Draw steps 0, 2, 4 (0.5s, 1.5s, 2.5s) cleanly on the ground
        for (let s = 0; s < pred.steps.length && pIdx < MAX_PRED_STEPS; s += 2) {
          const st = pred.steps[s];
          const slot = predPool[pIdx++];
          slot.ring.visible = true;
          slot.fill.visible = true;

          slot.ring.position.set(st.x, 0.07, st.y);
          slot.ring.rotation.y = -st.theta;
          slot.ring.scale.set(st.rx, 1, st.ry);
          (slot.ring.material as THREE.MeshBasicMaterial).color.set(col);

          slot.fill.position.set(st.x, 0.068, st.y);
          slot.fill.rotation.y = -st.theta;
          slot.fill.scale.set(st.rx, 1, st.ry);
          (slot.fill.material as THREE.MeshBasicMaterial).color.set(col);
        }
      }
    }
  };

  const dispose = () => {
    lidarGeo.dispose();
    lidarMat.dispose();
    sweepGeo.dispose();
    sweepMat.dispose();
    camFovGeo.dispose();
    camFovMat.dispose();
    radarGeo.dispose();
    radarMat.dispose();
    corridorLeftLine.geometry.dispose();
    (corridorLeftLine.material as THREE.Material).dispose();
    corridorRightLine.geometry.dispose();
    (corridorRightLine.material as THREE.Material).dispose();
    candidatePool.forEach((l) => {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    });
    ribbonGeo.dispose();
    ribbonMat.dispose();
    crumbGeo.dispose();
    crumbMat.dispose();
    baseEdgeGeo.dispose();
    dangerRingGeo.dispose();
    bboxPool.forEach((b) => {
      (b.line.material as THREE.Material).dispose();
      (b.ring.material as THREE.Material).dispose();
    });
    predDiscGeo.dispose();
    predFillGeo.dispose();
    predPool.forEach((p) => {
      (p.ring.material as THREE.Material).dispose();
      (p.fill.material as THREE.Material).dispose();
    });
    egoRingGeo.dispose();
    egoRingMat.dispose();
  };

  return { group, update, dispose };
}
