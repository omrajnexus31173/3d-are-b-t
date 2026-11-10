import * as THREE from 'three';
import { RoadSample, ScenarioDefinition } from '../types/simulation';
import { frenetToWorld } from '../simulation/roadMath';
import { buildPropMesh, buildStreetlightMesh, buildTreeMesh } from './models';
import { getProceduralTextures } from './textures';

function buildRibbonGeometry(
  samples: RoadSample[],
  offsetLeftFn: (s: RoadSample) => number,
  offsetRightFn: (s: RoadSample) => number,
  yHeight: number,
  uScale = 0.14
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const dL = offsetLeftFn(s);
    const dR = offsetRightFn(s);

    const lx = s.x + dL * s.nx;
    const lz = s.y + dL * s.ny;
    const rx = s.x + dR * s.nx;
    const rz = s.y + dR * s.ny;

    positions.push(lx, yHeight, lz);
    positions.push(rx, yHeight, rz);

    const vCoord = s.s * uScale;
    uvs.push(0, vCoord);
    uvs.push(1, vCoord);

    if (i < samples.length - 1) {
      const idx = i * 2;
      // Upward +Y normal winding
      indices.push(idx, idx + 1, idx + 2);
      indices.push(idx + 1, idx + 3, idx + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildRuralHouseMesh(seed: number): THREE.Group {
  const g = new THREE.Group();
  const wallCols = ['#e7e5e4', '#fde68a', '#fed7aa', '#cbd5e1'];
  const roofCols = ['#9a3412', '#b45309', '#7f1d1d'];

  const w = 5.4 + (seed % 3);
  const d = 4.5 + (seed % 2);
  const h = 3.2 + (seed % 2) * 0.6;

  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: wallCols[seed % wallCols.length], roughness: 0.88 })
  );
  walls.position.y = h * 0.5;
  walls.castShadow = true;
  walls.receiveShadow = true;
  g.add(walls);

  // Sloped terracotta / tin roof
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(w, d) * 0.76, 1.8, 4),
    new THREE.MeshStandardMaterial({ color: roofCols[seed % roofCols.length], roughness: 0.82 })
  );
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + 0.9;
  roof.castShadow = true;
  g.add(roof);

  // Warm doorway
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 1.8, 0.12),
    new THREE.MeshStandardMaterial({ color: '#451a03', roughness: 0.9 })
  );
  door.position.set(0, 0.9, d * 0.5 + 0.02);
  g.add(door);

  return g;
}

function buildHighwayGantryMesh(): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.75, roughness: 0.35 });

  for (const zOff of [-6.8, 6.8]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 6.6, 10), steel);
    leg.position.set(0, 3.3, zOff);
    leg.castShadow = true;
    g.add(leg);
  }

  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 14.2), steel);
  beam.position.set(0, 6.4, 0);
  beam.castShadow = true;
  g.add(beam);

  // Green NH highway sign board
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 1.7, 6.2),
    new THREE.MeshStandardMaterial({ color: '#15803d', roughness: 0.45 })
  );
  board.position.set(-0.22, 6.2, -1.6);
  g.add(board);

  const whiteBorder = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 1.5, 5.95),
    new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.4 })
  );
  whiteBorder.position.set(-0.21, 6.2, -1.6);
  g.add(whiteBorder);

  const innerGreen = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 1.35, 5.8),
    new THREE.MeshStandardMaterial({ color: '#166534', roughness: 0.45 })
  );
  innerGreen.position.set(-0.2, 6.2, -1.6);
  g.add(innerGreen);

  return g;
}

export function buildScenario3DEnvironment(scenario: ScenarioDefinition): {
  group: THREE.Group;
  dispose: () => void;
} {
  const group = new THREE.Group();
  const textures = getProceduralTextures();
  const geometriesToDispose: THREE.BufferGeometry[] = [];
  const materialsToDispose: THREE.Material[] = [];

  const isUrban = scenario.id === 'urban_intersection' || scenario.id === 'dense_market';
  const isHighway = scenario.id === 'highway_merge';

  // 1. Wide Ground Terrain Plane
  const groundGeo = new THREE.PlaneGeometry(750, 750);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshStandardMaterial({
    map: isUrban ? textures.terrainUrban : textures.terrainGrass,
    roughness: 0.94,
    metalness: 0.02,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(125, -0.04, 0);
  ground.receiveShadow = true;
  group.add(ground);
  geometriesToDispose.push(groundGeo);
  materialsToDispose.push(groundMat);

  // 2. CrossRoads / Merge Ramps
  for (const cr of scenario.crossRoads) {
    const dx = cr.x2 - cr.x1;
    const dz = cr.y2 - cr.y1;
    const len = Math.hypot(dx, dz);
    const angle = Math.atan2(dz, dx);

    const shGeo = new THREE.PlaneGeometry(len, cr.width + 2.4);
    shGeo.rotateX(-Math.PI / 2);
    const shMat = new THREE.MeshStandardMaterial({
      map: isUrban ? textures.urbanSidewalk : textures.mudShoulder,
      roughness: 0.92,
    });
    const shMesh = new THREE.Mesh(shGeo, shMat);
    shMesh.position.set((cr.x1 + cr.x2) * 0.5, -0.012, (cr.y1 + cr.y2) * 0.5);
    shMesh.rotation.y = -angle;
    shMesh.receiveShadow = true;
    group.add(shMesh);
    geometriesToDispose.push(shGeo);
    materialsToDispose.push(shMat);

    const rdGeo = new THREE.PlaneGeometry(len, cr.width);
    rdGeo.rotateX(-Math.PI / 2);
    const rdMat = new THREE.MeshStandardMaterial({
      map: isUrban ? textures.asphaltUrban : textures.asphaltHighway,
      roughness: 0.82,
    });
    const rdMesh = new THREE.Mesh(rdGeo, rdMat);
    rdMesh.position.set((cr.x1 + cr.x2) * 0.5, 0.004, (cr.y1 + cr.y2) * 0.5);
    rdMesh.rotation.y = -angle;
    rdMesh.receiveShadow = true;
    group.add(rdMesh);
    geometriesToDispose.push(rdGeo);
    materialsToDispose.push(rdMat);
  }

  // 3. Unpaved Shoulders / Urban Sidewalks Ribbon
  const samples = scenario.roadSamples;
  if (samples.length > 1) {
    const shGeo = buildRibbonGeometry(
      samples,
      (s) => -(s.leftWidth + s.shoulderLeft),
      (s) => s.rightWidth + s.shoulderRight,
      isUrban ? 0.03 : 0.0,
      0.16
    );
    const shMat = new THREE.MeshStandardMaterial({
      map: isUrban ? textures.urbanSidewalk : textures.mudShoulder,
      roughness: 0.92,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    const shMesh = new THREE.Mesh(shGeo, shMat);
    shMesh.receiveShadow = true;
    group.add(shMesh);
    geometriesToDispose.push(shGeo);
    materialsToDispose.push(shMat);

    // Main Asphalt Carriageway Ribbon
    const rdGeo = buildRibbonGeometry(
      samples,
      (s) => -s.leftWidth,
      (s) => s.rightWidth,
      isUrban ? 0.045 : 0.015,
      0.14
    );
    const rdMat = new THREE.MeshStandardMaterial({
      map: isHighway
        ? textures.asphaltHighway
        : isUrban
        ? textures.asphaltUrban
        : textures.asphaltRural,
      roughness: 0.82,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    const rdMesh = new THREE.Mesh(rdGeo, rdMat);
    rdMesh.name = 'asphalt_surface';
    rdMesh.receiveShadow = true;
    group.add(rdMesh);
    geometriesToDispose.push(rdGeo);
    materialsToDispose.push(rdMat);

    // Lane Markings ONLY where hasLaneMarks is true
    const dashGeo = new THREE.PlaneGeometry(2.6, 0.16);
    dashGeo.rotateX(-Math.PI / 2);
    const dashMat = new THREE.MeshStandardMaterial({
      color: '#e2e8f0',
      roughness: 0.65,
    });
    geometriesToDispose.push(dashGeo);
    materialsToDispose.push(dashMat);

    for (let s = 4; s < scenario.totalLengthM - 4; s += 6.5) {
      const p = frenetToWorld(samples, s, 0);
      if (p.sample.hasLaneMarks) {
        const dash = new THREE.Mesh(dashGeo, dashMat);
        dash.position.set(p.x, 0.032, p.y);
        dash.rotation.y = -p.theta;
        dash.receiveShadow = true;
        group.add(dash);
      }
    }

    // Faded Zebra Crosswalks in Urban Intersection
    if (scenario.id === 'urban_intersection') {
      const zebraGeo = new THREE.PlaneGeometry(2.2, 0.45);
      zebraGeo.rotateX(-Math.PI / 2);
      const zebraMat = new THREE.MeshStandardMaterial({
        color: '#cbd5e1',
        transparent: true,
        opacity: 0.55,
        roughness: 0.7,
      });
      geometriesToDispose.push(zebraGeo);
      materialsToDispose.push(zebraMat);

      for (const xZeb of [109, 131]) {
        for (let z = -4.2; z <= 4.2; z += 1.05) {
          const bar = new THREE.Mesh(zebraGeo, zebraMat);
          bar.position.set(xZeb, 0.052, z);
          group.add(bar);
        }
      }
    }

    // Goal Finish Corridor Arch Gate
    const goalPoseL = frenetToWorld(samples, scenario.goalS, -4.6);
    const goalPoseR = frenetToWorld(samples, scenario.goalS, 4.6);
    const goalCenter = frenetToWorld(samples, scenario.goalS, 0);
    const gateMat = new THREE.MeshStandardMaterial({
      color: '#10b981',
      emissive: '#059669',
      emissiveIntensity: 0.85,
      roughness: 0.3,
    });
    materialsToDispose.push(gateMat);

    for (const gp of [goalPoseL, goalPoseR]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 4.4, 10), gateMat);
      pillar.position.set(gp.x, 2.2, gp.y);
      pillar.castShadow = true;
      group.add(pillar);
    }
    const span = Math.hypot(goalPoseR.x - goalPoseL.x, goalPoseR.y - goalPoseL.y);
    const archBar = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.42, span + 0.3), gateMat);
    archBar.position.set(goalCenter.x, 4.35, goalCenter.y);
    archBar.rotation.y = -goalCenter.theta;
    group.add(archBar);

    // Subtle ground finish strip
    const finishGeo = new THREE.PlaneGeometry(0.7, span);
    finishGeo.rotateX(-Math.PI / 2);
    const finishMat = new THREE.MeshBasicMaterial({
      color: '#10b981',
      transparent: true,
      opacity: 0.45,
    });
    const finishStrip = new THREE.Mesh(finishGeo, finishMat);
    finishStrip.rotation.y = -goalCenter.theta;
    finishStrip.position.set(goalCenter.x, 0.055, goalCenter.y);
    group.add(finishStrip);
    geometriesToDispose.push(finishGeo);
    materialsToDispose.push(finishMat);
  }

  // 4. Explicit Scenario Props (Stalls, Trees, Buildings, Dividers, Signal-less Pole)
  for (const prop of scenario.props) {
    const mesh = buildPropMesh(prop);
    mesh.position.set(prop.x, 0, prop.y);
    mesh.rotation.y = -prop.theta;
    group.add(mesh);
  }

  // 5. Rich Procedural Indian Roadside Environmental Dressing (Outside road boundaries)
  if (samples.length > 1) {
    // Streetlights along urban / highway / cattle arterial corridors
    if (scenario.id !== 'village_road') {
      const step = scenario.id === 'highway_merge' ? 32 : 28;
      for (let s = 18; s < scenario.totalLengthM - 18; s += step) {
        if (scenario.id === 'urban_intersection' && s > 95 && s < 145) continue;
        const pL = frenetToWorld(samples, s, -(samples[0].leftWidth + 1.6));
        const lampL = buildStreetlightMesh(1);
        lampL.position.set(pL.x, 0, pL.y);
        lampL.rotation.y = -pL.theta;
        group.add(lampL);

        const pR = frenetToWorld(samples, s + step * 0.5, samples[0].rightWidth + 1.6);
        const lampR = buildStreetlightMesh(-1);
        lampR.position.set(pR.x, 0, pR.y);
        lampR.rotation.y = -pR.theta;
        group.add(lampR);
      }
    }

    // Rural Houses & Trees for Village Road & Cattle Crossing
    if (scenario.id === 'village_road' || scenario.id === 'cattle_crossing') {
      for (let s = 22; s < scenario.totalLengthM - 20; s += 38) {
        const side = Math.floor(s / 38) % 2 === 0 ? -1 : 1;
        const hPose = frenetToWorld(samples, s, side * 12.2);
        const house = buildRuralHouseMesh(Math.floor(s));
        house.position.set(hPose.x, 0, hPose.y);
        house.rotation.y = -hPose.theta + (side < 0 ? 0 : Math.PI);
        group.add(house);

        const tPose = frenetToWorld(samples, s + 16, -side * 9.5);
        const tree = buildTreeMesh(0.95 + ((s % 3) * 0.15));
        tree.position.set(tPose.x, 0, tPose.y);
        group.add(tree);
      }
    }

    // Urban Buildings flanking approaches in Urban Intersection & Dense Market
    if (scenario.id === 'dense_market') {
      for (let s = 22; s < scenario.totalLengthM - 16; s += 26) {
        for (const side of [-1, 1]) {
          const bPose = frenetToWorld(samples, s, side * 11.8);
          const bMesh = buildPropMesh({
            id: `mkt-bldg-${s}-${side}`,
            x: bPose.x,
            y: bPose.y,
            width: 8.5,
            length: 14,
            theta: bPose.theta,
            kind: 'building',
          });
          bMesh.position.set(bPose.x, 0, bPose.y);
          bMesh.rotation.y = -bPose.theta;
          group.add(bMesh);
        }
      }
    }

    // Highway Overhead NH Gantry Sign & Roadside Trees
    if (scenario.id === 'highway_merge') {
      const gPose = frenetToWorld(samples, 86, 0);
      const gantry = buildHighwayGantryMesh();
      gantry.position.set(gPose.x, 0, gPose.y);
      gantry.rotation.y = -gPose.theta;
      group.add(gantry);

      for (let s = 20; s < scenario.totalLengthM - 15; s += 24) {
        const tR = frenetToWorld(samples, s, 11.5);
        const tree = buildTreeMesh(1.1);
        tree.position.set(tR.x, 0, tR.y);
        group.add(tree);
      }
    }
  }

  return {
    group,
    dispose: () => {
      geometriesToDispose.forEach((g) => g.dispose());
      materialsToDispose.forEach((m) => m.dispose());
    },
  };
}
