import * as THREE from 'three';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  return [canvas, ctx];
}

function configureRepeatTexture(
  canvas: HTMLCanvasElement,
  repX: number,
  repY: number,
  srgb = true
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repX, repY);
  tex.anisotropy = 8;
  if (srgb) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}

export interface RoadTextureSet {
  asphaltRural: THREE.CanvasTexture;
  asphaltUrban: THREE.CanvasTexture;
  asphaltHighway: THREE.CanvasTexture;
  mudShoulder: THREE.CanvasTexture;
  urbanSidewalk: THREE.CanvasTexture;
  terrainGrass: THREE.CanvasTexture;
  terrainUrban: THREE.CanvasTexture;
  buildingFacade: THREE.CanvasTexture;
  awningStripe: THREE.CanvasTexture;
  dispose: () => void;
}

let cachedTextures: RoadTextureSet | null = null;

export function getProceduralTextures(): RoadTextureSet {
  if (cachedTextures) return cachedTextures;

  // 1. Rural Weathered Asphalt (uneven aggregate, patched tar, dusty edges)
  const [cRur, ctxRur] = makeCanvas(256, 256);
  ctxRur.fillStyle = '#2d323b';
  ctxRur.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3500; i++) {
    const x = (i * 73) % 256;
    const y = ((i * 137) ^ (i * 29)) % 256;
    const shade = 35 + (i % 26);
    ctxRur.fillStyle = `rgb(${shade},${shade + 2},${shade + 5})`;
    ctxRur.fillRect(x, y, 2, 2);
  }
  // Subtle tar crack lines
  ctxRur.strokeStyle = 'rgba(18, 20, 26, 0.55)';
  ctxRur.lineWidth = 1.4;
  ctxRur.beginPath();
  ctxRur.moveTo(20, 0);
  ctxRur.lineTo(44, 70);
  ctxRur.lineTo(35, 145);
  ctxRur.lineTo(58, 256);
  ctxRur.moveTo(185, 0);
  ctxRur.lineTo(170, 110);
  ctxRur.lineTo(192, 256);
  ctxRur.stroke();
  // Dusty edge wear
  const gradL = ctxRur.createLinearGradient(0, 0, 28, 0);
  gradL.addColorStop(0, 'rgba(110, 90, 68, 0.45)');
  gradL.addColorStop(1, 'rgba(110, 90, 68, 0)');
  ctxRur.fillStyle = gradL;
  ctxRur.fillRect(0, 0, 28, 256);

  // 2. Urban Asphalt
  const [cUrb, ctxUrb] = makeCanvas(256, 256);
  ctxUrb.fillStyle = '#242933';
  ctxUrb.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3200; i++) {
    const x = (i * 97) % 256;
    const y = (i * 53) % 256;
    const shade = 30 + (i % 20);
    ctxUrb.fillStyle = `rgb(${shade},${shade + 3},${shade + 7})`;
    ctxUrb.fillRect(x, y, 2, 2);
  }
  // Subtle tire wear tracks
  ctxUrb.fillStyle = 'rgba(15, 19, 26, 0.25)';
  ctxUrb.fillRect(52, 0, 32, 256);
  ctxUrb.fillRect(168, 0, 32, 256);

  // 3. Highway Crisp Asphalt
  const [cHw, ctxHw] = makeCanvas(256, 256);
  ctxHw.fillStyle = '#1f242d';
  ctxHw.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2800; i++) {
    const x = (i * 83) % 256;
    const y = (i * 61) % 256;
    const shade = 26 + (i % 16);
    ctxHw.fillStyle = `rgb(${shade},${shade + 3},${shade + 8})`;
    ctxHw.fillRect(x, y, 2, 2);
  }
  // White highway edge markings on texture sides
  ctxHw.fillStyle = 'rgba(226, 232, 240, 0.72)';
  ctxHw.fillRect(8, 0, 5, 256);
  ctxHw.fillRect(243, 0, 5, 256);

  // 4. Indian Laterite / Mud Shoulder
  const [cMud, ctxMud] = makeCanvas(256, 256);
  ctxMud.fillStyle = '#6b5640';
  ctxMud.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3500; i++) {
    const x = (i * 113) % 256;
    const y = (i * 47) % 256;
    const r = 88 + (i % 34);
    const g = 70 + (i % 26);
    const b = 50 + (i % 20);
    ctxMud.fillStyle = `rgb(${r},${g},${b})`;
    ctxMud.fillRect(x, y, 3, 3);
  }

  // 5. Urban Concrete Sidewalk Tiles
  const [cSide, ctxSide] = makeCanvas(256, 256);
  ctxSide.fillStyle = '#525866';
  ctxSide.fillRect(0, 0, 256, 256);
  ctxSide.strokeStyle = '#3b414d';
  ctxSide.lineWidth = 2;
  for (let x = 0; x <= 256; x += 64) {
    ctxSide.beginPath();
    ctxSide.moveTo(x, 0);
    ctxSide.lineTo(x, 256);
    ctxSide.stroke();
  }
  for (let y = 0; y <= 256; y += 64) {
    ctxSide.beginPath();
    ctxSide.moveTo(0, y);
    ctxSide.lineTo(256, y);
    ctxSide.stroke();
  }

  // 6. Rural Terrain (warm grassland & dry earth patches)
  const [cGrass, ctxGrass] = makeCanvas(256, 256);
  ctxGrass.fillStyle = '#2d4227';
  ctxGrass.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4000; i++) {
    const x = (i * 131) % 256;
    const y = (i * 89) % 256;
    ctxGrass.fillStyle = i % 5 === 0 ? '#4d5233' : i % 3 === 0 ? '#24361f' : '#374f2f';
    ctxGrass.fillRect(x, y, 3, 3);
  }

  // 7. Urban Ground Terrain
  const [cUrbGnd, ctxUrbGnd] = makeCanvas(256, 256);
  ctxUrbGnd.fillStyle = '#1e242e';
  ctxUrbGnd.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1600; i++) {
    const x = (i * 91) % 256;
    const y = (i * 71) % 256;
    ctxUrbGnd.fillStyle = '#262d3a';
    ctxUrbGnd.fillRect(x, y, 2, 2);
  }

  // 8. Indian Urban Building Facade (windows + warm balconies)
  const [cBldg, ctxBldg] = makeCanvas(256, 256);
  ctxBldg.fillStyle = '#475061';
  ctxBldg.fillRect(0, 0, 256, 256);
  // Horizontal floor ledges
  ctxBldg.fillStyle = '#333a47';
  for (let y = 0; y < 256; y += 64) {
    ctxBldg.fillRect(0, y, 256, 6);
  }
  // Windows
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const wx = 18 + col * 60;
      const wy = 16 + row * 64;
      const lit = (row + col * 3) % 3 === 0;
      ctxBldg.fillStyle = lit ? '#fde68a' : '#1e293b';
      ctxBldg.fillRect(wx, wy, 32, 34);
      ctxBldg.strokeStyle = '#94a3b8';
      ctxBldg.lineWidth = 2;
      ctxBldg.strokeRect(wx, wy, 32, 34);
    }
  }

  // 9. Market Canopy Stripe
  const [cAwn, ctxAwn] = makeCanvas(128, 128);
  const stripes = ['#ea580c', '#fef3c7', '#0284c7', '#fef3c7'];
  for (let i = 0; i < 4; i++) {
    ctxAwn.fillStyle = stripes[i];
    ctxAwn.fillRect(i * 32, 0, 32, 128);
  }

  const asphaltRural = configureRepeatTexture(cRur, 1, 1);
  const asphaltUrban = configureRepeatTexture(cUrb, 1, 1);
  const asphaltHighway = configureRepeatTexture(cHw, 1, 1);
  const mudShoulder = configureRepeatTexture(cMud, 1, 1);
  const urbanSidewalk = configureRepeatTexture(cSide, 1, 1);
  const terrainGrass = configureRepeatTexture(cGrass, 42, 42);
  const terrainUrban = configureRepeatTexture(cUrbGnd, 40, 40);
  const buildingFacade = configureRepeatTexture(cBldg, 2, 2);
  const awningStripe = configureRepeatTexture(cAwn, 2, 1);

  cachedTextures = {
    asphaltRural,
    asphaltUrban,
    asphaltHighway,
    mudShoulder,
    urbanSidewalk,
    terrainGrass,
    terrainUrban,
    buildingFacade,
    awningStripe,
    dispose: () => {
      asphaltRural.dispose();
      asphaltUrban.dispose();
      asphaltHighway.dispose();
      mudShoulder.dispose();
      urbanSidewalk.dispose();
      terrainGrass.dispose();
      terrainUrban.dispose();
      buildingFacade.dispose();
      awningStripe.dispose();
      cachedTextures = null;
    },
  };

  return cachedTextures;
}
