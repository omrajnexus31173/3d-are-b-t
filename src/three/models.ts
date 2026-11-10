import * as THREE from 'three';
import { AgentClass, RoadProp } from '../types/simulation';
import { getProceduralTextures } from './textures';

export interface AnimatedRig {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  frontSteeringKnuckles: THREE.Object3D[];
  leftLegs: THREE.Object3D[];
  rightLegs: THREE.Object3D[];
  leftArms: THREE.Object3D[];
  rightArms: THREE.Object3D[];
  lidarTurret?: THREE.Object3D;
  brakeMat?: THREE.MeshStandardMaterial;
  leftBlinkerMat?: THREE.MeshStandardMaterial;
  rightBlinkerMat?: THREE.MeshStandardMaterial;
  beaconMat?: THREE.MeshStandardMaterial;
  wheelRadius: number;
  walkPhase: number;
}

const MAT_TIRE = new THREE.MeshStandardMaterial({
  color: '#17191e',
  roughness: 0.88,
  metalness: 0.1,
});
const MAT_RIM = new THREE.MeshStandardMaterial({
  color: '#cbd5e1',
  roughness: 0.3,
  metalness: 0.85,
});
const MAT_GLASS = new THREE.MeshPhysicalMaterial({
  color: '#0f172a',
  roughness: 0.08,
  metalness: 0.1,
  transmission: 0.15,
  reflectivity: 0.9,
  clearcoat: 1.0,
});
const MAT_HEADLIGHT = new THREE.MeshStandardMaterial({
  color: '#fef9c3',
  emissive: '#fde047',
  emissiveIntensity: 1.5,
  roughness: 0.2,
});
const MAT_CHROME = new THREE.MeshStandardMaterial({
  color: '#e2e8f0',
  roughness: 0.22,
  metalness: 0.9,
});

function createWheel(radius: number, width: number): THREE.Group {
  const wg = new THREE.Group();
  const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 16);
  // Align cylinder axis along local Z (lateral)
  tireGeo.rotateX(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, MAT_TIRE);
  tire.castShadow = true;
  wg.add(tire);

  const rimGeo = new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width + 0.02, 12);
  rimGeo.rotateX(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, MAT_RIM);
  wg.add(rim);

  // Subtle spoke bar so wheel spin is visibly perceptible
  const spoke = new THREE.Mesh(
    new THREE.BoxGeometry(radius * 1.05, radius * 0.14, width + 0.03),
    new THREE.MeshStandardMaterial({ color: '#475569', metalness: 0.7, roughness: 0.3 })
  );
  wg.add(spoke);

  return wg;
}

function emptyRig(group: THREE.Group, wheelRadius = 0.34): AnimatedRig {
  return {
    group,
    wheels: [],
    frontSteeringKnuckles: [],
    leftLegs: [],
    rightLegs: [],
    leftArms: [],
    rightArms: [],
    wheelRadius,
    walkPhase: Math.random() * Math.PI * 2,
  };
}

export function buildEgoVehicleMesh(): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.35);

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: '#f1f5f9',
    roughness: 0.2,
    metalness: 0.35,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: '#1e293b',
    roughness: 0.65,
    metalness: 0.2,
  });

  // Lower skirt / chassis
  const lower = new THREE.Mesh(new THREE.BoxGeometry(4.32, 0.42, 1.84), trimMat);
  lower.position.y = 0.44;
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  // Main body shell
  const body = new THREE.Mesh(new THREE.BoxGeometry(4.24, 0.52, 1.82), bodyMat);
  body.position.y = 0.86;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Sculpted cabin greenhouse
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.56, 1.56), MAT_GLASS);
  cabin.position.set(-0.22, 1.36, 0);
  cabin.castShadow = true;
  group.add(cabin);

  // White roof cap
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.09, 1.5), bodyMat);
  roof.position.set(-0.24, 1.66, 0);
  roof.castShadow = true;
  group.add(roof);

  // Autonomous Sensor Pod Rack on roof
  const rack = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.1, 1.1),
    new THREE.MeshStandardMaterial({ color: '#0f172a', metalness: 0.6, roughness: 0.35 })
  );
  rack.position.set(-0.1, 1.75, 0);
  group.add(rack);

  // Spinning 360-degree Roof LiDAR Turret
  const lidarTurret = new THREE.Group();
  lidarTurret.position.set(-0.1, 1.92, 0);
  const turretBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.21, 0.2, 18),
    new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.8, roughness: 0.25 })
  );
  lidarTurret.add(turretBase);
  const cyanBand = new THREE.Mesh(
    new THREE.CylinderGeometry(0.19, 0.19, 0.08, 18),
    new THREE.MeshStandardMaterial({
      color: '#22d3ee',
      emissive: '#06b6d4',
      emissiveIntensity: 2.0,
      roughness: 0.15,
    })
  );
  lidarTurret.add(cyanBand);
  // Directional optic lens bar to show spin
  const opticBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.41, 0.07, 0.09),
    new THREE.MeshStandardMaterial({ color: '#ecfeff', emissive: '#22d3ee', emissiveIntensity: 1.5 })
  );
  lidarTurret.add(opticBar);
  group.add(lidarTurret);
  rig.lidarTurret = lidarTurret;

  // Front Stereo Camera Module on upper windshield
  const camPod = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.1, 0.48),
    new THREE.MeshStandardMaterial({ color: '#0284c7', emissive: '#0ea5e9', emissiveIntensity: 0.9 })
  );
  camPod.position.set(0.76, 1.54, 0);
  group.add(camPod);

  // Front Millimeter-Wave Radar Bar
  const radarBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.14, 0.68),
    new THREE.MeshStandardMaterial({ color: '#10b981', emissive: '#10b981', emissiveIntensity: 0.85 })
  );
  radarBar.position.set(2.14, 0.45, 0);
  group.add(radarBar);

  // Cyan Autonomous Trim Accent along sides
  const sideAccentMat = new THREE.MeshStandardMaterial({
    color: '#06b6d4',
    emissive: '#06b6d4',
    emissiveIntensity: 0.7,
  });
  for (const side of [-1, 1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.05, 0.03), sideAccentMat);
    strip.position.set(0, 0.68, side * 0.92);
    group.add(strip);
  }

  // Headlights
  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.34), MAT_HEADLIGHT);
    hl.position.set(2.12, 0.78, side * 0.66);
    group.add(hl);
  }

  // Brake Lights (dynamic emissive)
  const brakeMat = new THREE.MeshStandardMaterial({
    color: '#7f1d1d',
    emissive: '#ef4444',
    emissiveIntensity: 0.35,
    roughness: 0.25,
  });
  rig.brakeMat = brakeMat;
  for (const side of [-1, 1]) {
    const bl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 0.36), brakeMat);
    bl.position.set(-2.12, 0.82, side * 0.64);
    group.add(bl);
  }

  // Dynamic Turn Blinkers (Left = -Z, Right = +Z)
  const leftBlinkerMat = new THREE.MeshStandardMaterial({
    color: '#78350f',
    emissive: '#f59e0b',
    emissiveIntensity: 0,
  });
  const rightBlinkerMat = new THREE.MeshStandardMaterial({
    color: '#78350f',
    emissive: '#f59e0b',
    emissiveIntensity: 0,
  });
  rig.leftBlinkerMat = leftBlinkerMat;
  rig.rightBlinkerMat = rightBlinkerMat;

  for (const xPos of [2.05, -2.05]) {
    const lBlk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.14), leftBlinkerMat);
    lBlk.position.set(xPos, 0.78, -0.88);
    group.add(lBlk);

    const rBlk = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.14), rightBlinkerMat);
    rBlk.position.set(xPos, 0.78, 0.88);
    group.add(rBlk);
  }

  // 4 Wheels (Front have steering knuckles)
  const wheelOffsets = [
    { x: 1.38, z: -0.9, front: true },
    { x: 1.38, z: 0.9, front: true },
    { x: -1.36, z: -0.9, front: false },
    { x: -1.36, z: 0.9, front: false },
  ];
  for (const wo of wheelOffsets) {
    const wheel = createWheel(0.35, 0.24);
    if (wo.front) {
      const knuckle = new THREE.Group();
      knuckle.position.set(wo.x, 0.35, wo.z);
      knuckle.add(wheel);
      group.add(knuckle);
      rig.frontSteeringKnuckles.push(knuckle);
    } else {
      wheel.position.set(wo.x, 0.35, wo.z);
      group.add(wheel);
    }
    rig.wheels.push(wheel);
  }

  return rig;
}

export function buildCarMesh(seedIdx: number): AnimatedRig {
  const colors = ['#2563eb', '#64748b', '#dc2626', '#0d9488', '#e2e8f0'];
  const paint = colors[seedIdx % colors.length];
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.32);

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: paint,
    roughness: 0.26,
    metalness: 0.45,
    clearcoat: 0.8,
  });

  const lower = new THREE.Mesh(new THREE.BoxGeometry(4.15, 0.56, 1.78), bodyMat);
  lower.position.y = 0.62;
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.52, 1.52), MAT_GLASS);
  cabin.position.set(-0.2, 1.14, 0);
  cabin.castShadow = true;
  group.add(cabin);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.08, 1.46), bodyMat);
  roof.position.set(-0.22, 1.41, 0);
  group.add(roof);

  // Grille & lights
  const grille = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.22, 0.9),
    new THREE.MeshStandardMaterial({ color: '#0f172a' })
  );
  grille.position.set(2.08, 0.56, 0);
  group.add(grille);

  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.28), MAT_HEADLIGHT);
    hl.position.set(2.08, 0.68, s * 0.64);
    group.add(hl);

    const tl = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.14, 0.3),
      new THREE.MeshStandardMaterial({ color: '#991b1b', emissive: '#ef4444', emissiveIntensity: 0.6 })
    );
    tl.position.set(-2.08, 0.72, s * 0.64);
    group.add(tl);
  }

  const wPos = [
    { x: 1.3, z: -0.88 },
    { x: 1.3, z: 0.88 },
    { x: -1.3, z: -0.88 },
    { x: -1.3, z: 0.88 },
  ];
  for (const wp of wPos) {
    const w = createWheel(0.32, 0.22);
    w.position.set(wp.x, 0.32, wp.z);
    group.add(w);
    rig.wheels.push(w);
  }

  return rig;
}

export function buildAutoRickshawMesh(): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.24);

  const greenMat = new THREE.MeshStandardMaterial({
    color: '#15803d',
    roughness: 0.42,
    metalness: 0.25,
  });
  const yellowMat = new THREE.MeshStandardMaterial({
    color: '#facc15',
    roughness: 0.55,
    metalness: 0.05,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.7 });

  // Lower chassis tub
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.46, 1.34), greenMat);
  base.position.set(-0.08, 0.45, 0);
  base.castShadow = true;
  group.add(base);

  // Tapered front cowling
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.52, 0.92, 10), greenMat);
  nose.position.set(1.0, 0.68, 0);
  nose.castShadow = true;
  group.add(nose);

  // Front mudguard
  const mudguard = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.14, 0.26), yellowMat);
  mudguard.position.set(1.12, 0.38, 0);
  group.add(mudguard);

  // Windshield frame + glass
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.54, 0.82), MAT_GLASS);
  windshield.position.set(0.86, 1.26, 0);
  windshield.rotation.z = 0.22;
  group.add(windshield);

  // Iconic curved yellow soft-top canopy
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.12, 0.22, 1.36), yellowMat);
  canopy.position.set(-0.22, 1.62, 0);
  canopy.castShadow = true;
  group.add(canopy);

  // Canopy rear back wall
  const rearWall = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 1.32), yellowMat);
  rearWall.position.set(-1.24, 1.12, 0);
  rearWall.castShadow = true;
  group.add(rearWall);

  // Corner support pillars
  for (const px of [0.72, -1.2]) {
    for (const pz of [-0.62, 0.62]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.96, 8), darkMat);
      post.position.set(px, 1.12, pz);
      group.add(post);
    }
  }

  // Passenger bench seat inside
  const bench = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 1.14), darkMat);
  bench.position.set(-0.65, 0.72, 0);
  group.add(bench);

  // Central round headlight
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 12), MAT_HEADLIGHT);
  head.rotation.z = Math.PI / 2;
  head.position.set(1.32, 0.78, 0);
  group.add(head);

  // 3 Wheels (1 front, 2 rear)
  const fw = createWheel(0.24, 0.16);
  fw.position.set(1.06, 0.24, 0);
  group.add(fw);
  rig.wheels.push(fw);

  for (const rz of [-0.64, 0.64]) {
    const rw = createWheel(0.24, 0.18);
    rw.position.set(-0.92, 0.24, rz);
    group.add(rw);
    rig.wheels.push(rw);
  }

  return rig;
}

export function buildTwoWheelerMesh(seedIdx: number): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.27);
  const bikeColors = ['#dc2626', '#0284c7', '#1e293b', '#ea580c'];
  const helmetColors = ['#facc15', '#f8fafc', '#ef4444', '#22d3ee'];

  const frameMat = new THREE.MeshStandardMaterial({
    color: bikeColors[seedIdx % bikeColors.length],
    roughness: 0.35,
    metalness: 0.5,
  });
  const helmetMat = new THREE.MeshStandardMaterial({
    color: helmetColors[seedIdx % helmetColors.length],
    roughness: 0.25,
    metalness: 0.2,
  });

  // Wheels
  const fw = createWheel(0.27, 0.11);
  fw.position.set(0.68, 0.27, 0);
  group.add(fw);
  rig.wheels.push(fw);

  const rw = createWheel(0.27, 0.13);
  rw.position.set(-0.66, 0.27, 0);
  group.add(rw);
  rig.wheels.push(rw);

  // Frame / engine block
  const engine = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.36, 0.24),
    new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.7, roughness: 0.4 })
  );
  engine.position.set(0, 0.45, 0);
  engine.castShadow = true;
  group.add(engine);

  // Fuel tank + seat
  const tank = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.28), frameMat);
  tank.position.set(0.18, 0.72, 0);
  group.add(tank);

  const seat = new THREE.Mesh(
    new THREE.BoxGeometry(0.66, 0.14, 0.26),
    new THREE.MeshStandardMaterial({ color: '#0f172a' })
  );
  seat.position.set(-0.32, 0.72, 0);
  group.add(seat);

  // Front fork & handlebar
  const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.68, 8), MAT_CHROME);
  fork.position.set(0.56, 0.62, 0);
  fork.rotation.z = 0.25;
  group.add(fork);

  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.72, 8), MAT_CHROME);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(0.46, 0.94, 0);
  group.add(bar);

  const hl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 10), MAT_HEADLIGHT);
  hl.position.set(0.66, 0.82, 0);
  group.add(hl);

  // Rider torso + helmet + arms
  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.56, 0.4),
    new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.75 })
  );
  torso.position.set(-0.18, 1.08, 0);
  torso.rotation.z = -0.22;
  torso.castShadow = true;
  group.add(torso);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 14), helmetMat);
  helmet.position.set(-0.08, 1.48, 0);
  helmet.castShadow = true;
  group.add(helmet);

  return rig;
}

export function buildBusTruckMesh(seedIdx: number): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.48);
  const isBus = seedIdx % 2 === 0;

  if (isBus) {
    // Indian City / Intercity Bus
    const bodyMat = new THREE.MeshStandardMaterial({
      color: '#dc2626',
      roughness: 0.35,
      metalness: 0.2,
    });
    const creamMat = new THREE.MeshStandardMaterial({ color: '#fef3c7', roughness: 0.5 });

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(8.4, 2.35, 2.36), bodyMat);
    chassis.position.y = 1.65;
    chassis.castShadow = true;
    chassis.receiveShadow = true;
    group.add(chassis);

    const stripe = new THREE.Mesh(new THREE.BoxGeometry(8.42, 0.32, 2.38), creamMat);
    stripe.position.y = 1.25;
    group.add(stripe);

    // Side passenger window strip
    const sideWin = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.75, 2.38), MAT_GLASS);
    sideWin.position.set(-0.35, 2.02, 0);
    group.add(sideWin);

    // Front large windshield
    const frontWin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.02, 2.12), MAT_GLASS);
    frontWin.position.set(4.2, 2.0, 0);
    group.add(frontWin);
  } else {
    // Classic Indian Freight Truck (Colorful Tata/Ashok Leyland Cab + Covered Cargo Bed)
    const cabMat = new THREE.MeshStandardMaterial({
      color: '#f59e0b',
      roughness: 0.38,
      metalness: 0.3,
    });
    const cargoMat = new THREE.MeshStandardMaterial({
      color: '#312e81',
      roughness: 0.72,
      metalness: 0.1,
    });

    // Cab
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.15, 2.28), cabMat);
    cab.position.set(2.85, 1.55, 0);
    cab.castShadow = true;
    group.add(cab);

    const wind = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.76, 1.98), MAT_GLASS);
    wind.position.set(4.0, 1.95, 0);
    group.add(wind);

    // Cargo box
    const cargo = new THREE.Mesh(new THREE.BoxGeometry(5.85, 2.45, 2.38), cargoMat);
    cargo.position.set(-1.3, 1.75, 0);
    cargo.castShadow = true;
    cargo.receiveShadow = true;
    group.add(cargo);

    // Traditional colorful Indian truck band
    const decor = new THREE.Mesh(
      new THREE.BoxGeometry(5.88, 0.22, 2.4),
      new THREE.MeshStandardMaterial({ color: '#ec4899', roughness: 0.5 })
    );
    decor.position.set(-1.3, 0.85, 0);
    group.add(decor);
  }

  // Headlights
  for (const sz of [-0.82, 0.82]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.32), MAT_HEADLIGHT);
    hl.position.set(4.22, 0.82, sz);
    group.add(hl);
  }

  // Heavy wheels
  for (const wx of [2.75, -1.65, -3.05]) {
    for (const wz of [-1.14, 1.14]) {
      const w = createWheel(0.48, 0.32);
      w.position.set(wx, 0.48, wz);
      group.add(w);
      rig.wheels.push(w);
    }
  }

  return rig;
}

export function buildPedestrianMesh(seedIdx: number): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.3);
  const shirtColors = ['#e11d48', '#0284c7', '#f59e0b', '#10b981', '#a855f7'];
  const pantColors = ['#1e293b', '#334155', '#475569'];

  const skinMat = new THREE.MeshStandardMaterial({ color: '#b47b56', roughness: 0.75 });
  const shirtMat = new THREE.MeshStandardMaterial({
    color: shirtColors[seedIdx % shirtColors.length],
    roughness: 0.8,
  });
  const pantMat = new THREE.MeshStandardMaterial({
    color: pantColors[seedIdx % pantColors.length],
    roughness: 0.85,
  });

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.62, 0.44), shirtMat);
  torso.position.y = 1.12;
  torso.castShadow = true;
  group.add(torso);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), skinMat);
  head.position.y = 1.62;
  head.castShadow = true;
  group.add(head);

  // Legs (pivoted at hip)
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(0, 0.82, side * 0.12);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.78, 0.16), pantMat);
    leg.position.y = -0.39;
    leg.castShadow = true;
    hip.add(leg);
    group.add(hip);
    if (side < 0) rig.leftLegs.push(hip);
    else rig.rightLegs.push(hip);
  }

  // Arms (pivoted at shoulder)
  for (const side of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(0, 1.36, side * 0.28);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.56, 0.13), shirtMat);
    arm.position.y = -0.26;
    arm.castShadow = true;
    sh.add(arm);
    group.add(sh);
    if (side < 0) rig.leftArms.push(sh);
    else rig.rightArms.push(sh);
  }

  return rig;
}

export function buildPushcartMesh(): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.34);

  const woodMat = new THREE.MeshStandardMaterial({ color: '#78350f', roughness: 0.88 });
  const steelMat = new THREE.MeshStandardMaterial({ color: '#475569', metalness: 0.6, roughness: 0.4 });

  // Cart wooden platform
  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.14, 1.28), woodMat);
  deck.position.y = 0.78;
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);

  // Side rails
  for (const sz of [-0.6, 0.6]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.18, 0.06), woodMat);
    rail.position.set(0, 0.94, sz);
    group.add(rail);
  }

  // Colorful vegetable / fruit crates piled on cart
  const produce = [
    { x: -0.55, z: -0.26, c: '#22c55e' },
    { x: 0.1, z: -0.26, c: '#ef4444' },
    { x: 0.68, z: -0.24, c: '#f59e0b' },
    { x: -0.45, z: 0.28, c: '#eab308' },
    { x: 0.25, z: 0.28, c: '#ec4899' },
  ];
  for (const p of produce) {
    const mound = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 10, 8),
      new THREE.MeshStandardMaterial({ color: p.c, roughness: 0.75 })
    );
    mound.scale.y = 0.65;
    mound.position.set(p.x, 0.95, p.z);
    mound.castShadow = true;
    group.add(mound);
  }

  // Overhead shade canopy poles & awning
  const tex = getProceduralTextures().awningStripe;
  for (const px of [-0.95, 0.95]) {
    for (const pz of [-0.55, 0.55]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.25, 6), steelMat);
      pole.position.set(px, 1.4, pz);
      group.add(pole);
    }
  }
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(2.25, 0.06, 1.38),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 })
  );
  roof.position.set(0, 2.04, 0);
  roof.castShadow = true;
  group.add(roof);

  // 4 Spoked Cart Wheels
  for (const wx of [-0.82, 0.82]) {
    for (const wz of [-0.66, 0.66]) {
      const w = createWheel(0.34, 0.08);
      w.position.set(wx, 0.34, wz);
      group.add(w);
      rig.wheels.push(w);
    }
  }

  return rig;
}

export function buildCattleMesh(seedIdx: number): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group, 0.35);

  const hideColors = ['#f5f5f4', '#78350f', '#d6d3d1'];
  const patchColors = ['#78350f', '#1c1917', '#92400e'];

  const hideMat = new THREE.MeshStandardMaterial({
    color: hideColors[seedIdx % hideColors.length],
    roughness: 0.82,
  });
  const patchMat = new THREE.MeshStandardMaterial({
    color: patchColors[seedIdx % patchColors.length],
    roughness: 0.84,
  });
  const hornMat = new THREE.MeshStandardMaterial({ color: '#fef3c7', roughness: 0.45 });

  // Torso barrel
  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.68, 0.64), hideMat);
  torso.position.set(-0.08, 0.88, 0);
  torso.castShadow = true;
  group.add(torso);

  // Traditional Indian cow hump on upper back
  const hump = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 10), hideMat);
  hump.scale.set(1.1, 0.9, 0.8);
  hump.position.set(0.32, 1.24, 0);
  group.add(hump);

  // Coat patch
  const patch = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.56, 0.66), patchMat);
  patch.position.set(-0.22, 0.9, 0);
  group.add(patch);

  // Neck & Head
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.42, 0.36), hideMat);
  neck.position.set(0.72, 1.08, 0);
  neck.rotation.z = -0.4;
  group.add(neck);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.32, 0.34), hideMat);
  head.position.set(0.98, 1.16, 0);
  head.rotation.z = 0.25;
  head.castShadow = true;
  group.add(head);

  // Curved Horns
  for (const hz of [-0.16, 0.16]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.3, 8), hornMat);
    horn.position.set(0.96, 1.38, hz);
    horn.rotation.x = hz < 0 ? -0.45 : 0.45;
    horn.rotation.z = 0.2;
    group.add(horn);
  }

  // Tail
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.62, 6), patchMat);
  tail.position.set(-0.84, 0.78, 0);
  tail.rotation.z = -0.25;
  group.add(tail);

  // 4 Articulated Legs
  const legPos = [
    { x: 0.46, z: -0.22, left: true },
    { x: 0.46, z: 0.22, left: false },
    { x: -0.58, z: -0.22, left: true },
    { x: -0.58, z: 0.22, left: false },
  ];
  for (const lp of legPos) {
    const pivot = new THREE.Group();
    pivot.position.set(lp.x, 0.6, lp.z);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.6, 8), hideMat);
    leg.position.y = -0.3;
    leg.castShadow = true;
    pivot.add(leg);
    group.add(pivot);
    if (lp.left) rig.leftLegs.push(pivot);
    else rig.rightLegs.push(pivot);
  }

  return rig;
}

export function buildPotholeMesh(): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group);

  // Broken asphalt outer rim
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(0.68, 0.92, 18),
    new THREE.MeshStandardMaterial({ color: '#4b5563', roughness: 0.95, side: THREE.DoubleSide })
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.035;
  group.add(rim);

  // Deep dark crater pit with slight muddy water reflection
  const pit = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 18),
    new THREE.MeshStandardMaterial({
      color: '#0b0e14',
      roughness: 0.22,
      metalness: 0.35,
    })
  );
  pit.rotation.x = -Math.PI / 2;
  pit.position.y = 0.028;
  group.add(pit);

  // Subtle purple perception highlight halo
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.88, 0.98, 24),
    new THREE.MeshBasicMaterial({
      color: '#a855f7',
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.04;
  group.add(halo);

  return rig;
}

export function buildBarricadeMesh(): AnimatedRig {
  const group = new THREE.Group();
  const rig = emptyRig(group);

  const orangeMat = new THREE.MeshStandardMaterial({ color: '#ea580c', roughness: 0.45 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.4 });
  const steelMat = new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.6, roughness: 0.4 });

  // Vertical legs
  for (const lz of [-0.95, 0.95]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.14), steelMat);
    leg.position.set(0, 0.04, lz);
    group.add(leg);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.05, 8), steelMat);
    post.position.set(0, 0.54, lz);
    post.castShadow = true;
    group.add(post);
  }

  // Horizontal striped boards
  for (const yPos of [0.5, 0.86]) {
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.26, 2.15), orangeMat);
    board.position.set(0, yPos, 0);
    board.castShadow = true;
    group.add(board);

    for (const wz of [-0.65, 0, 0.65]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.26), whiteMat);
      stripe.position.set(0, yPos, wz);
      group.add(stripe);
    }
  }

  // Flashing amber warning beacon on top
  const beaconMat = new THREE.MeshStandardMaterial({
    color: '#f59e0b',
    emissive: '#f59e0b',
    emissiveIntensity: 1.5,
  });
  rig.beaconMat = beaconMat;
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.16, 12), beaconMat);
  beacon.position.set(0, 1.14, 0);
  group.add(beacon);

  return rig;
}

export function buildAgentRig(agentClass: AgentClass, seedIdx: number): AnimatedRig {
  switch (agentClass) {
    case 'car':
      return buildCarMesh(seedIdx);
    case 'auto_rickshaw':
      return buildAutoRickshawMesh();
    case 'two_wheeler':
      return buildTwoWheelerMesh(seedIdx);
    case 'bus_truck':
      return buildBusTruckMesh(seedIdx);
    case 'pedestrian':
      return buildPedestrianMesh(seedIdx);
    case 'pushcart':
      return buildPushcartMesh();
    case 'cattle':
      return buildCattleMesh(seedIdx);
    case 'pothole':
      return buildPotholeMesh();
    case 'barricade':
      return buildBarricadeMesh();
  }
}

export function updateRigAnimation(
  rig: AnimatedRig,
  speed: number,
  dt: number,
  steerAngle = 0,
  lidarAngle = 0,
  isBraking = false,
  blinker: 'none' | 'left' | 'right' = 'none',
  nowSec = 0
): void {
  // Wheel spin
  if (rig.wheels.length > 0 && speed > 0.05) {
    const dAngle = (speed * dt) / Math.max(0.15, rig.wheelRadius);
    for (let i = 0; i < rig.wheels.length; i++) {
      rig.wheels[i].rotation.z -= dAngle;
    }
  }

  // Front wheel steering angle (Ego)
  for (let i = 0; i < rig.frontSteeringKnuckles.length; i++) {
    rig.frontSteeringKnuckles[i].rotation.y = -steerAngle;
  }

  // LiDAR spin
  if (rig.lidarTurret) {
    rig.lidarTurret.rotation.y = -lidarAngle;
  }

  // Brake lights
  if (rig.brakeMat) {
    rig.brakeMat.emissiveIntensity = isBraking ? 2.8 : 0.35;
  }

  // Blinkers
  const blinkPulse = Math.floor(nowSec * 4.5) % 2 === 0 ? 2.4 : 0.0;
  if (rig.leftBlinkerMat) {
    rig.leftBlinkerMat.emissiveIntensity = blinker === 'left' ? blinkPulse : 0.0;
  }
  if (rig.rightBlinkerMat) {
    rig.rightBlinkerMat.emissiveIntensity = blinker === 'right' ? blinkPulse : 0.0;
  }

  // Barricade beacon pulse
  if (rig.beaconMat) {
    rig.beaconMat.emissiveIntensity = 0.6 + 1.4 * Math.abs(Math.sin(nowSec * 3.5));
  }

  // Walk / Trot cycle for Pedestrians & Cattle
  if (rig.leftLegs.length > 0) {
    if (speed > 0.15) {
      rig.walkPhase += speed * dt * 4.2;
      const swing = Math.sin(rig.walkPhase) * 0.55;
      for (const l of rig.leftLegs) l.rotation.z = swing;
      for (const r of rig.rightLegs) r.rotation.z = -swing;
      for (const la of rig.leftArms) la.rotation.z = -swing * 0.7;
      for (const ra of rig.rightArms) ra.rotation.z = swing * 0.7;
    } else {
      for (const l of rig.leftLegs) l.rotation.z *= 0.85;
      for (const r of rig.rightLegs) r.rotation.z *= 0.85;
      for (const la of rig.leftArms) la.rotation.z *= 0.85;
      for (const ra of rig.rightArms) ra.rotation.z *= 0.85;
    }
  }
}

export function buildTreeMesh(scale = 1.0): THREE.Group {
  const g = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: '#5c4033', roughness: 0.92 });
  const leafMat1 = new THREE.MeshStandardMaterial({ color: '#2d5a27', roughness: 0.85 });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: '#3b7a32', roughness: 0.82 });

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.36, 2.8, 8), trunkMat);
  trunk.position.y = 1.4;
  trunk.castShadow = true;
  g.add(trunk);

  const puffs = [
    { x: 0, y: 3.6, z: 0, r: 1.7, m: leafMat1 },
    { x: 0.85, y: 3.1, z: 0.55, r: 1.25, m: leafMat2 },
    { x: -0.8, y: 3.2, z: -0.5, r: 1.3, m: leafMat2 },
    { x: 0.2, y: 4.3, z: -0.4, r: 1.2, m: leafMat2 },
  ];
  for (const p of puffs) {
    const sphere = new THREE.Mesh(new THREE.DodecahedronGeometry(p.r, 1), p.m);
    sphere.position.set(p.x, p.y, p.z);
    sphere.castShadow = true;
    sphere.receiveShadow = true;
    g.add(sphere);
  }
  g.scale.setScalar(scale);
  return g;
}

export function buildStreetlightMesh(facingZSign: number): THREE.Group {
  const g = new THREE.Group();
  const poleMat = new THREE.MeshStandardMaterial({ color: '#475569', metalness: 0.7, roughness: 0.4 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 6.2, 8), poleMat);
  pole.position.y = 3.1;
  pole.castShadow = true;
  g.add(pole);

  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.8), poleMat);
  arm.position.set(0, 6.1, facingZSign * 0.85);
  g.add(arm);

  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.35, 0.12, 0.55),
    new THREE.MeshStandardMaterial({
      color: '#fef3c7',
      emissive: '#fbbf24',
      emissiveIntensity: 1.2,
    })
  );
  lamp.position.set(0, 6.02, facingZSign * 1.65);
  g.add(lamp);

  return g;
}

export function buildPropMesh(prop: RoadProp): THREE.Group {
  const g = new THREE.Group();
  const textures = getProceduralTextures();

  if (prop.kind === 'tree') {
    return buildTreeMesh(1.05);
  }

  if (prop.kind === 'stall') {
    const wallMat = new THREE.MeshStandardMaterial({ color: '#9a3412', roughness: 0.88 });
    const counterMat = new THREE.MeshStandardMaterial({ color: '#78350f', roughness: 0.85 });
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(prop.length * 0.92, 2.2, prop.width * 0.85),
      wallMat
    );
    base.position.y = 1.1;
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    const counter = new THREE.Mesh(
      new THREE.BoxGeometry(prop.length, 0.95, prop.width * 0.35),
      counterMat
    );
    counter.position.set(0, 0.48, prop.width * 0.45);
    g.add(counter);

    const awning = new THREE.Mesh(
      new THREE.BoxGeometry(prop.length * 1.05, 0.12, prop.width * 1.25),
      new THREE.MeshStandardMaterial({ map: textures.awningStripe, roughness: 0.8 })
    );
    awning.position.set(0, 2.45, prop.width * 0.18);
    awning.rotation.x = 0.18;
    awning.castShadow = true;
    g.add(awning);

    // Warm shop lantern bulb
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 8, 8),
      new THREE.MeshStandardMaterial({
        color: '#fef3c7',
        emissive: '#f59e0b',
        emissiveIntensity: 2.0,
      })
    );
    bulb.position.set(0, 2.15, prop.width * 0.55);
    g.add(bulb);
  } else if (prop.kind === 'building') {
    const height = 10 + ((prop.x + prop.y) % 5);
    const bldg = new THREE.Mesh(
      new THREE.BoxGeometry(prop.length, height, prop.width),
      new THREE.MeshStandardMaterial({
        map: textures.buildingFacade,
        roughness: 0.78,
        metalness: 0.1,
      })
    );
    bldg.position.y = height * 0.5;
    bldg.castShadow = true;
    bldg.receiveShadow = true;
    g.add(bldg);

    // Rooftop parapet & water tank
    const roofCap = new THREE.Mesh(
      new THREE.BoxGeometry(prop.length + 0.4, 0.45, prop.width + 0.4),
      new THREE.MeshStandardMaterial({ color: '#334155', roughness: 0.85 })
    );
    roofCap.position.y = height + 0.22;
    g.add(roofCap);

    const tank = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 1.8, 12),
      new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.5 })
    );
    tank.position.set(prop.length * 0.22, height + 1.3, -prop.width * 0.2);
    g.add(tank);
  } else if (prop.kind === 'divider') {
    const divMat = new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.7 });
    const barrier = new THREE.Mesh(
      new THREE.BoxGeometry(prop.length, 0.85, prop.width),
      divMat
    );
    barrier.position.y = 0.42;
    barrier.castShadow = true;
    barrier.receiveShadow = true;
    g.add(barrier);

    const yellowTop = new THREE.Mesh(
      new THREE.BoxGeometry(prop.length, 0.14, prop.width * 0.65),
      new THREE.MeshStandardMaterial({ color: '#facc15', roughness: 0.5 })
    );
    yellowTop.position.y = 0.88;
    g.add(yellowTop);
  } else if (prop.kind === 'sign_missing') {
    // Non-functioning signal gantry pole to highlight signal-less intersection
    const poleMat = new THREE.MeshStandardMaterial({ color: '#475569', metalness: 0.7, roughness: 0.4 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 5.8, 10), poleMat);
    post.position.y = 2.9;
    post.castShadow = true;
    g.add(post);

    const crossArm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 4.2), poleMat);
    crossArm.position.set(0, 5.5, 2.0);
    g.add(crossArm);

    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.95, 0.36),
      new THREE.MeshStandardMaterial({ color: '#0f172a' })
    );
    box.position.set(0, 5.05, 3.3);
    g.add(box);

    // Unlit/dim amber caution lens
    const amber = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 10, 10),
      new THREE.MeshStandardMaterial({
        color: '#f59e0b',
        emissive: '#f59e0b',
        emissiveIntensity: 0.7,
      })
    );
    amber.position.set(-0.18, 5.05, 3.3);
    g.add(amber);
  }

  return g;
}
