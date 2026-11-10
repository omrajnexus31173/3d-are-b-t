import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  AlertTriangle,
  Camera,
  Compass,
  Crosshair,
  Eye,
  LocateFixed,
  PlusCircle,
  Radio,
  Radar,
  Route,
  Scan,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import {
  LayerVisibility,
  PlannerState,
  SensorNoiseConfig,
  SimulationState,
} from '../types/simulation';
import { HazardInjectionType } from '../simulation/engine';
import {
  AnimatedRig,
  buildAgentRig,
  buildEgoVehicleMesh,
  updateRigAnimation,
} from '../three/models';
import { buildScenario3DEnvironment } from '../three/roadBuilder';
import { AutonomyVisualManager, createAutonomyVisuals } from '../three/autonomyVisuals';

export type CameraMode = 'chase' | 'driver' | 'drone' | 'bev';

interface Simulation3DViewportProps {
  simStateRef: React.MutableRefObject<SimulationState>;
  uiSnapshot: SimulationState;
  layers: LayerVisibility;
  weatherMode: SensorNoiseConfig['weatherMode'];
  isRecording: boolean;
  onToggleLayer: (key: keyof LayerVisibility) => void;
  onInjectHazard: (kind: HazardInjectionType) => void;
  canvasElementRef: React.MutableRefObject<HTMLCanvasElement | null>;
}

const STATE_BADGE_STYLES: Record<
  PlannerState,
  { bg: string; text: string; border: string; label: string }
> = {
  CRUISE_NOMINAL: {
    bg: 'bg-cyan-500/15',
    text: 'text-cyan-300',
    border: 'border-cyan-400/40',
    label: 'CRUISE NOMINAL',
  },
  ADAPTIVE_OVERTAKE: {
    bg: 'bg-indigo-500/20',
    text: 'text-indigo-300',
    border: 'border-indigo-400/45',
    label: 'ADAPTIVE OVERTAKE',
  },
  YIELD_CREEP: {
    bg: 'bg-amber-500/20',
    text: 'text-amber-300',
    border: 'border-amber-400/45',
    label: 'YIELD / CREEP',
  },
  EMERGENCY_EVADE: {
    bg: 'bg-rose-500/25',
    text: 'text-rose-200',
    border: 'border-rose-400/60',
    label: 'EMERGENCY EVADE',
  },
  GOAL_REACHED: {
    bg: 'bg-emerald-500/20',
    text: 'text-emerald-300',
    border: 'border-emerald-400/50',
    label: 'SCENARIO COMPLETE',
  },
};

const MAX_HUD_TAGS = 12;

export const Simulation3DViewport: React.FC<Simulation3DViewportProps> = ({
  simStateRef,
  uiSnapshot,
  layers,
  weatherMode,
  isRecording,
  onToggleLayer,
  onInjectHazard,
  canvasElementRef,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const labelOverlayRef = useRef<HTMLDivElement | null>(null);
  const miniMapRef = useRef<HTMLCanvasElement | null>(null);

  const [cameraMode, setCameraMode] = useState<CameraMode>('chase');
  const [followEgo, setFollowEgo] = useState(true);

  const cameraModeRef = useRef<CameraMode>('chase');
  const followEgoRef = useRef<boolean>(true);
  const layersRef = useRef<LayerVisibility>(layers);
  const weatherRef = useRef<SensorNoiseConfig['weatherMode']>(weatherMode);
  const customOrbitDeltaRef = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
    customOrbitDeltaRef.current = null;
    setFollowEgo(true);
    followEgoRef.current = true;
  }, [cameraMode]);

  useEffect(() => {
    followEgoRef.current = followEgo;
  }, [followEgo]);

  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  useEffect(() => {
    weatherRef.current = weatherMode;
  }, [weatherMode]);

  // References to active Three.js scene objects for scenario hot-swapping
  const threeCtxRef = useRef<{
    scene: THREE.Scene;
    envGroup: THREE.Group | null;
    envDispose: (() => void) | null;
    agentRigs: Map<string, AnimatedRig>;
    egoRig: AnimatedRig;
    autonomyVisuals: AutonomyVisualManager;
    dirLight: THREE.DirectionalLight;
    hemiLight: THREE.HemisphereLight;
    rainSystem: THREE.Points;
    loadedScenarioId: string;
  } | null>(null);

  // Helper to sync scenario 3D road & static environment whenever scenario changes
  const syncScenarioEnvironment = (scenarioId: string) => {
    const ctx = threeCtxRef.current;
    if (!ctx || ctx.loadedScenarioId === scenarioId) return;

    const sim = simStateRef.current;

    // Dispose old road environment
    if (ctx.envGroup) {
      ctx.scene.remove(ctx.envGroup);
      ctx.envDispose?.();
      ctx.envGroup = null;
      ctx.envDispose = null;
    }

    // Clear old agent rigs
    ctx.agentRigs.forEach((rig) => {
      ctx.scene.remove(rig.group);
    });
    ctx.agentRigs.clear();

    // Build new 3D road environment
    const built = buildScenario3DEnvironment(sim.scenario);
    ctx.scene.add(built.group);
    ctx.envGroup = built.group;
    ctx.envDispose = built.dispose;
    ctx.loadedScenarioId = scenarioId;
  };

  // Initialize Three.js WebGL Pipeline once
  useEffect(() => {
    const container = mountRef.current;
    const canvas = canvasElementRef.current;
    if (!container || !canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // ensures video recording stream captures frames cleanly
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#132238');
    scene.fog = new THREE.FogExp2('#162438', 0.0068);

    // Subtle PBR environment reflections
    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.25, 420);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.485;
    controls.minDistance = 4;
    controls.maxDistance = 95;

    let isUserInteracting = false;
    const onControlStart = () => {
      isUserInteracting = true;
      if (cameraModeRef.current === 'driver') {
        setCameraMode('chase');
      }
    };
    const onControlEnd = () => {
      isUserInteracting = false;
      // Preserve user's rotated angle & zoom relative to controls.target while continuing to follow Ego
      customOrbitDeltaRef.current = camera.position.clone().sub(controls.target);
      const egoPos = simStateRef.current.ego;
      const targetDistFromEgo = Math.hypot(
        controls.target.x - egoPos.x,
        controls.target.z - egoPos.y
      );
      if (targetDistFromEgo > 24) {
        setFollowEgo(false);
        followEgoRef.current = false;
      }
    };
    controls.addEventListener('start', onControlStart);
    controls.addEventListener('end', onControlEnd);

    // Sky Hemisphere + Sun Directional Light with dynamic shadow frustum
    const hemiLight = new THREE.HemisphereLight('#bae6fd', '#334155', 0.9);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight('#fff7ed', 2.2);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.near = 2;
    dirLight.shadow.camera.far = 180;
    const d = 48;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);
    scene.add(dirLight.target);

    // Ego AV 3D Rig + Forward Headlight Illumination
    const egoRig = buildEgoVehicleMesh();
    const headSpot = new THREE.SpotLight('#e0f2fe', 16, 42, Math.PI / 4.8, 0.55, 1.3);
    headSpot.position.set(2.15, 0.85, 0);
    headSpot.target.position.set(22, 0, 0);
    egoRig.group.add(headSpot);
    egoRig.group.add(headSpot.target);
    scene.add(egoRig.group);

    // Autonomy Visuals Manager
    const autonomyVisuals = createAutonomyVisuals();
    scene.add(autonomyVisuals.group);

    // 3D Monsoon Rain Particle System
    const rainCount = 900;
    const rainPositions = new Float32Array(rainCount * 3);
    for (let i = 0; i < rainCount; i++) {
      rainPositions[i * 3] = (Math.random() - 0.5) * 85;
      rainPositions[i * 3 + 1] = Math.random() * 26;
      rainPositions[i * 3 + 2] = (Math.random() - 0.5) * 85;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
    const rainMat = new THREE.PointsMaterial({
      color: '#bae6fd',
      size: 0.16,
      transparent: true,
      opacity: 0.6,
    });
    const rainSystem = new THREE.Points(rainGeo, rainMat);
    rainSystem.visible = false;
    scene.add(rainSystem);

    threeCtxRef.current = {
      scene,
      envGroup: null,
      envDispose: null,
      agentRigs: new Map(),
      egoRig,
      autonomyVisuals,
      dirLight,
      hemiLight,
      rainSystem,
      loadedScenarioId: '',
    };

    // Build initial scenario environment
    syncScenarioEnvironment(simStateRef.current.scenario.id);

    // Initial camera pose
    const s0 = simStateRef.current.ego;
    camera.position.set(
      s0.x - Math.cos(s0.theta) * 14,
      6.4,
      s0.y - Math.sin(s0.theta) * 14
    );
    controls.target.set(
      s0.x + Math.cos(s0.theta) * 10,
      1.0,
      s0.y + Math.sin(s0.theta) * 10
    );

    // Imperative HUD DOM Tag Pool for 3D-projected IDD labels
    const labelEls: HTMLDivElement[] = [];
    if (labelOverlayRef.current) {
      labelOverlayRef.current.innerHTML = '';
      for (let i = 0; i < MAX_HUD_TAGS; i++) {
        const el = document.createElement('div');
        el.className =
          'absolute top-0 left-0 px-1.5 py-0.5 rounded text-[9.5px] font-mono-tech font-semibold whitespace-nowrap border shadow-md pointer-events-none hidden';
        labelOverlayRef.current.appendChild(el);
        labelEls.push(el);
      }
    }

    // Resize Observer
    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(100, rect.width);
      const h = Math.max(100, rect.height);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);

    const projVec = new THREE.Vector3();
    const desiredCamPos = new THREE.Vector3();
    const desiredTarget = new THREE.Vector3();

    let lastTime = performance.now();
    let rafId = 0;

    const animate = (nowMs: number) => {
      const dt = Math.min(0.08, (nowMs - lastTime) / 1000);
      lastTime = nowMs;
      const nowSec = nowMs * 0.001;

      const sim = simStateRef.current;
      const ctx3d = threeCtxRef.current!;

      // Swap scenario 3D environment if scenario changed
      if (ctx3d.loadedScenarioId !== sim.scenario.id) {
        syncScenarioEnvironment(sim.scenario.id);
        customOrbitDeltaRef.current = null;
        setFollowEgo(true);
        followEgoRef.current = true;
      }

      // Weather lighting, wet road specular reflections & rain
      const wMode = weatherRef.current;
      const asphaltObj = ctx3d.envGroup?.getObjectByName('asphalt_surface') as
        | THREE.Mesh
        | undefined;
      const asphaltMat = asphaltObj?.material as THREE.MeshStandardMaterial | undefined;

      if (wMode === 'monsoon_haze') {
        (scene.background as THREE.Color).set('#101d2b');
        (scene.fog as THREE.FogExp2).color.set('#142436');
        (scene.fog as THREE.FogExp2).density = 0.013;
        dirLight.intensity = 1.25;
        dirLight.color.set('#cbd5e1');
        headSpot.intensity = 34;
        if (asphaltMat) {
          asphaltMat.roughness = 0.24;
          asphaltMat.metalness = 0.34;
        }
        rainSystem.visible = true;
        rainSystem.position.set(sim.ego.x, 0, sim.ego.y);
        const rAttr = rainGeo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < rainCount; i++) {
          let ry = rAttr.getY(i) - dt * 26;
          if (ry < 0) ry = 26;
          rAttr.setY(i, ry);
        }
        rAttr.needsUpdate = true;
      } else if (wMode === 'dust_glare') {
        (scene.background as THREE.Color).set('#362819');
        (scene.fog as THREE.FogExp2).color.set('#3d2d1b');
        (scene.fog as THREE.FogExp2).density = 0.011;
        dirLight.intensity = 2.6;
        dirLight.color.set('#fed7aa');
        headSpot.intensity = 12;
        if (asphaltMat) {
          asphaltMat.roughness = 0.85;
          asphaltMat.metalness = 0.03;
        }
        rainSystem.visible = false;
      } else {
        (scene.background as THREE.Color).set('#112034');
        (scene.fog as THREE.FogExp2).color.set('#152438');
        (scene.fog as THREE.FogExp2).density = 0.0058;
        dirLight.intensity = 2.25;
        dirLight.color.set('#fff7ed');
        headSpot.intensity = 16;
        if (asphaltMat) {
          asphaltMat.roughness = 0.82;
          asphaltMat.metalness = 0.04;
        }
        rainSystem.visible = false;
      }

      // 1. Update Ego AV 3D Pose & Articulation
      const { ego } = sim;
      ctx3d.egoRig.group.position.set(ego.x, 0.02, ego.y);
      ctx3d.egoRig.group.rotation.y = -ego.theta;
      updateRigAnimation(
        ctx3d.egoRig,
        ego.speed,
        dt,
        ego.steerAngle,
        sim.lidarSpinAngle,
        ego.isBraking,
        ego.blinker,
        nowSec
      );

      // Keep crisp dynamic sun shadows centered near Ego AV
      dirLight.position.set(ego.x + 28, 42, ego.y - 24);
      dirLight.target.position.set(ego.x + 10, 0, ego.y);
      dirLight.target.updateMatrixWorld();

      // 2. Sync Agent 3D Rigs (create dynamically for newly injected hazards)
      const activeIds = new Set<string>();
      for (let i = 0; i < sim.agents.length; i++) {
        const ag = sim.agents[i];
        activeIds.add(ag.id);
        let rig = ctx3d.agentRigs.get(ag.id);
        if (!rig) {
          rig = buildAgentRig(ag.agentClass, i);
          ctx3d.agentRigs.set(ag.id, rig);
          ctx3d.scene.add(rig.group);
        }
        rig.group.position.set(ag.x, 0.015, ag.y);
        rig.group.rotation.y = -ag.theta;
        updateRigAnimation(rig, ag.speed, dt, 0, 0, false, 'none', nowSec);
      }

      // Remove stale agent rigs if any
      ctx3d.agentRigs.forEach((rig, id) => {
        if (!activeIds.has(id)) {
          ctx3d.scene.remove(rig.group);
          ctx3d.agentRigs.delete(id);
        }
      });

      // 3. Update 3D Autonomous Driving Overlays
      ctx3d.autonomyVisuals.update(sim, layersRef.current, nowSec);

      // 4. Camera Tracking Controller
      const cosT = Math.cos(ego.theta);
      const sinT = Math.sin(ego.theta);
      const rCos = -sinT;
      const rSin = cosT;

      if (cameraModeRef.current === 'driver') {
        controls.enabled = false;
        camera.position.set(ego.x + cosT * 0.65, 1.85, ego.y + sinT * 0.65);
        controls.target.set(ego.x + cosT * 22, 1.15, ego.y + sinT * 22);
        camera.lookAt(controls.target);
      } else {
        controls.enabled = true;
        if (followEgoRef.current && !isUserInteracting) {
          if (cameraModeRef.current === 'chase') {
            desiredTarget.set(ego.x + cosT * 9.5, 0.9, ego.y + sinT * 9.5);
            desiredCamPos.set(
              ego.x - cosT * 13.5 + rCos * 0.5,
              5.9,
              ego.y - sinT * 13.5 + rSin * 0.5
            );
          } else if (cameraModeRef.current === 'drone') {
            desiredTarget.set(ego.x + cosT * 10, 0.5, ego.y + sinT * 10);
            desiredCamPos.set(
              ego.x - cosT * 17 + rCos * 12,
              15.5,
              ego.y - sinT * 17 + rSin * 12
            );
          } else {
            // Top-Down BEV
            desiredTarget.set(ego.x + cosT * 12, 0, ego.y + sinT * 12);
            desiredCamPos.set(ego.x + cosT * 11.8, 38, ego.y + sinT * 11.8);
          }

          if (customOrbitDeltaRef.current) {
            desiredCamPos.copy(desiredTarget).add(customOrbitDeltaRef.current);
          }

          camera.position.lerp(desiredCamPos, 0.095);
          controls.target.lerp(desiredTarget, 0.12);
        }
        controls.update();
      }

      // Render 3D Frame
      renderer.render(scene, camera);

      // 5. Project 3D Tracked Objects -> Crisp Floating HUD Labels
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (layersRef.current.labels && labelEls.length > 0) {
        let lblIdx = 0;
        for (
          let i = 0;
          i < sim.perception.trackedObjects.length && lblIdx < MAX_HUD_TAGS;
          i++
        ) {
          const obj = sim.perception.trackedObjects[i];
          if (obj.dist > 46) continue;
          const yOff =
            obj.agentClass === 'bus_truck'
              ? 3.3
              : obj.agentClass === 'pothole'
              ? 0.6
              : 2.25;
          projVec.set(obj.x, yOff, obj.y);
          projVec.project(camera);

          // Check in front of camera & inside viewport
          if (projVec.z > 0 && projVec.z < 1) {
            const sx = (projVec.x * 0.5 + 0.5) * cw;
            const sy = (-projVec.y * 0.5 + 0.5) * ch;
            if (sx > 20 && sx < cw - 20 && sy > 20 && sy < ch - 20) {
              const el = labelEls[lblIdx++];
              const borderCol =
                obj.riskLevel === 'CRITICAL'
                  ? 'border-rose-400 text-rose-100 bg-rose-950/85'
                  : obj.riskLevel === 'HIGH'
                  ? 'border-amber-400 text-amber-100 bg-amber-950/85'
                  : obj.riskLevel === 'MEDIUM'
                  ? 'border-cyan-400 text-cyan-100 bg-slate-950/85'
                  : 'border-slate-500 text-slate-200 bg-slate-950/80';

              el.className = `absolute top-0 left-0 px-1.5 py-0.5 rounded text-[9px] font-mono-tech font-semibold whitespace-nowrap border shadow-lg pointer-events-none ${borderCol}`;
              const ttcStr = Number.isFinite(obj.ttc) ? ` · TTC ${obj.ttc.toFixed(1)}s` : '';
              el.textContent = `${obj.trackId} ${obj.agentClass
                .replace('_', ' ')
                .toUpperCase()} ${(obj.confidence * 100).toFixed(0)}%${ttcStr}`;
              el.style.transform = `translate3d(${sx.toFixed(0)}px, ${sy.toFixed(
                0
              )}px, 0) translate(-50%, -100%)`;
            }
          }
        }
        for (let k = lblIdx; k < MAX_HUD_TAGS; k++) {
          labelEls[k].className = 'hidden';
        }
      } else {
        for (let k = 0; k < MAX_HUD_TAGS; k++) {
          labelEls[k].className = 'hidden';
        }
      }

      // 6. Render Picture-in-Picture BEV Tactical Radar Mini-Map
      const mm = miniMapRef.current;
      if (mm) {
        const mCtx = mm.getContext('2d');
        if (mCtx) {
          const mw = mm.width;
          const mh = mm.height;
          mCtx.clearRect(0, 0, mw, mh);
          mCtx.fillStyle = 'rgba(11, 15, 23, 0.92)';
          mCtx.fillRect(0, 0, mw, mh);

          // Radar rings
          mCtx.strokeStyle = 'rgba(6, 182, 212, 0.16)';
          mCtx.lineWidth = 1;
          for (const rad of [24, 48]) {
            mCtx.beginPath();
            mCtx.arc(mw / 2, mh * 0.72, rad, 0, Math.PI * 2);
            mCtx.stroke();
          }

          const scale = 1.65; // px per meter
          const toMap = (wx: number, wy: number) => {
            const dx = wx - ego.x;
            const dy = wy - ego.y;
            // Rotate so Ego points UP on mini-map
            const fwd = dx * cosT + dy * sinT;
            const right = -dx * sinT + dy * cosT;
            return {
              x: mw / 2 + right * scale,
              y: mh * 0.72 - fwd * scale,
            };
          };

          // Corridor boundaries
          const drawPts = (pts: { x: number; y: number }[], col: string) => {
            if (pts.length < 2) return;
            mCtx.strokeStyle = col;
            mCtx.lineWidth = 1.2;
            mCtx.beginPath();
            pts.forEach((p, idx) => {
              const mp = toMap(p.x, p.y);
              if (idx === 0) mCtx.moveTo(mp.x, mp.y);
              else mCtx.lineTo(mp.x, mp.y);
            });
            mCtx.stroke();
          };
          drawPts(sim.perception.corridor.leftPoints, 'rgba(148,163,184,0.45)');
          drawPts(sim.perception.corridor.rightPoints, 'rgba(148,163,184,0.45)');

          // Planned path
          if (sim.planner.selectedTrajectory) {
            drawPts(sim.planner.selectedTrajectory.points, '#22d3ee');
          }

          // Tracked agents
          for (const obj of sim.perception.trackedObjects) {
            const mp = toMap(obj.x, obj.y);
            mCtx.fillStyle =
              obj.riskLevel === 'CRITICAL'
                ? '#f43f5e'
                : obj.riskLevel === 'HIGH'
                ? '#f59e0b'
                : '#38bdf8';
            mCtx.beginPath();
            mCtx.arc(mp.x, mp.y, 3.2, 0, Math.PI * 2);
            mCtx.fill();
          }

          // Ego triangle at center-bottom
          mCtx.fillStyle = '#f8fafc';
          mCtx.beginPath();
          mCtx.moveTo(mw / 2, mh * 0.72 - 6);
          mCtx.lineTo(mw / 2 - 4, mh * 0.72 + 4);
          mCtx.lineTo(mw / 2 + 4, mh * 0.72 + 4);
          mCtx.closePath();
          mCtx.fill();
        }
      }

      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.removeEventListener('start', onControlStart);
      controls.removeEventListener('end', onControlEnd);
      controls.dispose();
      autonomyVisuals.dispose();
      if (threeCtxRef.current?.envDispose) threeCtxRef.current.envDispose();
      rainGeo.dispose();
      rainMat.dispose();
      envTarget.dispose();
      renderer.dispose();
      threeCtxRef.current = null;
    };
  }, [simStateRef, canvasElementRef]);

  const badge = STATE_BADGE_STYLES[uiSnapshot.planner.state];
  const speedKmh = (uiSnapshot.ego.speed * 3.6).toFixed(1);
  const steerDeg = ((uiSnapshot.ego.steerAngle * 180) / Math.PI).toFixed(1);
  const minTtcText = Number.isFinite(uiSnapshot.metrics.minTtcS)
    ? `${uiSnapshot.metrics.minTtcS.toFixed(1)}s`
    : 'SAFE';
  const curTtc =
    uiSnapshot.perception.trackedObjects[0]?.ttc !== undefined &&
    Number.isFinite(uiSnapshot.perception.trackedObjects[0].ttc)
      ? `${uiSnapshot.perception.trackedObjects[0].ttc.toFixed(1)}s`
      : 'CLEAR';

  const hasCritical = uiSnapshot.perception.trackedObjects.some(
    (o) => o.riskLevel === 'CRITICAL'
  );
  const hasHigh = uiSnapshot.perception.trackedObjects.some(
    (o) => o.riskLevel === 'HIGH'
  );
  const riskStatus = hasCritical
    ? { label: 'CRITICAL RISK', cls: 'bg-rose-500/20 text-rose-300 border-rose-400/50' }
    : hasHigh
    ? { label: 'ELEVATED CAUTION', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/45' }
    : { label: 'PATH CLEAR', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/40' };

  const layerChips: { key: keyof LayerVisibility; label: string; icon: React.ReactNode }[] = [
    { key: 'lidar', label: 'LiDAR', icon: <Scan className="w-3 h-3" /> },
    { key: 'cameraFov', label: 'Cam FOV', icon: <Eye className="w-3 h-3" /> },
    { key: 'radar', label: 'Radar', icon: <Radar className="w-3 h-3" /> },
    { key: 'predictions', label: 'Pred Tubes', icon: <Radio className="w-3 h-3" /> },
    { key: 'candidates', label: 'Lattice', icon: <Route className="w-3 h-3" /> },
    { key: 'corridor', label: 'Corridor', icon: <Crosshair className="w-3 h-3" /> },
    { key: 'labels', label: '3D Boxes', icon: <AlertTriangle className="w-3 h-3" /> },
  ];

  const cameraButtons: { id: CameraMode; label: string }[] = [
    { id: 'chase', label: 'Chase 3D' },
    { id: 'driver', label: 'Driver POV' },
    { id: 'drone', label: 'Drone' },
    { id: 'bev', label: 'Top BEV' },
  ];

  return (
    <div
      ref={mountRef}
      className="relative flex-1 h-full bg-[#0B0F17] overflow-hidden select-none"
    >
      <canvas
        ref={canvasElementRef}
        className="w-full h-full block cursor-grab active:cursor-grabbing"
      />

      {/* 3D Projected Floating IDD Object Detection Tags */}
      <div
        ref={labelOverlayRef}
        className="absolute inset-0 pointer-events-none overflow-hidden"
      />

      {/* Recording Frame Indicator */}
      {isRecording && (
        <div className="absolute inset-0 pointer-events-none border-2 border-rose-500/80 animate-pulse" />
      )}

      {/* TOP-LEFT HUD: Planner State, Collision Risk & Speed Telemetry */}
      <div className="absolute top-3 left-3 flex flex-col gap-2 max-w-[475px] pointer-events-none">
        <div className="bg-[#0E1420]/88 backdrop-blur-md border border-slate-400/20 rounded-xl px-3 py-2 shadow-2xl">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span
                className={`px-2 py-0.5 rounded-md text-[10px] font-mono-tech font-bold border ${badge.bg} ${badge.text} ${badge.border}`}
              >
                {badge.label}
              </span>
              <span
                className={`px-2 py-0.5 rounded-md text-[9.5px] font-mono-tech font-semibold border flex items-center gap-1 ${riskStatus.cls}`}
              >
                {hasCritical ? (
                  <ShieldAlert className="w-3 h-3" />
                ) : (
                  <ShieldCheck className="w-3 h-3" />
                )}
                {riskStatus.label}
              </span>
            </div>
            <div className="flex items-center gap-2.5 text-[11px] font-mono-tech text-slate-300">
              <span>
                <strong className="text-cyan-300">{speedKmh}</strong> km/h
              </span>
              <span>
                STR <strong className="text-slate-100">{steerDeg}°</strong>
              </span>
              <span>
                TTC <strong className="text-amber-300">{curTtc}</strong>
              </span>
              <span>
                PLAN{' '}
                <strong className="text-emerald-300">
                  {uiSnapshot.metrics.lastReplanMs.toFixed(1)}ms
                </strong>
              </span>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-300 leading-snug">
            <span className="text-cyan-400 font-mono-tech mr-1.5">
              [{uiSnapshot.scenario.code}]
            </span>
            {uiSnapshot.planner.reason}
          </p>
        </div>

        {/* Scenario Metadata Pill */}
        <div className="bg-[#0B0F17]/82 backdrop-blur-sm border border-slate-400/15 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-semibold text-slate-200">
            {uiSnapshot.scenario.roadType}:
          </span>
          {uiSnapshot.scenario.keyChallenges.map((c) => (
            <span
              key={c}
              className="text-[9.5px] font-mono-tech px-1.5 py-0.5 rounded bg-slate-800/90 text-slate-300 border border-slate-700"
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* TOP-RIGHT HUD: Camera View Selector & Autonomy Layer Toggles */}
      <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
        {/* Camera Angle Selector */}
        <div className="flex items-center gap-1 bg-[#0E1420]/90 backdrop-blur-md p-1 rounded-xl border border-slate-400/20 shadow-xl">
          <span className="px-1.5 text-[10px] font-mono-tech text-slate-400 flex items-center gap-1">
            <Camera className="w-3 h-3 text-cyan-400" />
            <span className="hidden sm:inline">CAM</span>
          </span>
          {cameraButtons.map((cam) => (
            <button
              key={cam.id}
              onClick={() => setCameraMode(cam.id)}
              className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                cameraMode === cam.id
                  ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/45 shadow-sm'
                  : 'text-slate-400 hover:text-slate-100 border border-transparent'
              }`}
            >
              {cam.label}
            </button>
          ))}
          <button
            onClick={() => {
              customOrbitDeltaRef.current = null;
              setFollowEgo(true);
              followEgoRef.current = true;
            }}
            title="Reset & re-center camera onto Ego AV"
            className={`px-2 py-1 rounded-lg text-[10px] font-mono-tech flex items-center gap-1 cursor-pointer ${
              followEgo
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/20 text-amber-300 animate-pulse'
            }`}
          >
            <LocateFixed className="w-3 h-3" />
          </button>
        </div>

        {/* Sensor & Autonomy Overlay Toggles */}
        <div className="flex flex-wrap justify-end gap-1 bg-[#0E1420]/88 backdrop-blur-md p-1 rounded-xl border border-slate-400/20 shadow-xl max-w-[385px]">
          {layerChips.map((chip) => {
            const on = layers[chip.key];
            return (
              <button
                key={chip.key}
                onClick={() => onToggleLayer(chip.key)}
                className={`px-2 py-1 rounded-lg text-[10px] font-medium flex items-center gap-1 transition-all cursor-pointer ${
                  on
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                {chip.icon}
                <span>{chip.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* BOTTOM-LEFT HUD: Live Hazard / Chaos Event Injector */}
      <div className="absolute bottom-3 left-3 flex flex-col gap-1.5 items-start">
        <div className="bg-[#0E1420]/90 backdrop-blur-md border border-slate-400/20 rounded-xl p-1.5 flex items-center gap-1.5 shadow-xl flex-wrap">
          <span className="text-[10px] font-mono-tech uppercase tracking-wider text-slate-400 px-1.5 flex items-center gap-1">
            <PlusCircle className="w-3 h-3 text-amber-400" />
            Inject Hazard:
          </span>
          <button
            onClick={() => onInjectHazard('cattle')}
            className="px-2 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/35 text-rose-200 text-[10.5px] font-medium cursor-pointer transition-colors"
          >
            + Stray Cattle
          </button>
          <button
            onClick={() => onInjectHazard('pedestrian')}
            className="px-2 py-1 rounded-lg bg-pink-500/15 hover:bg-pink-500/25 border border-pink-400/35 text-pink-200 text-[10.5px] font-medium cursor-pointer transition-colors"
          >
            + Jaywalker
          </button>
          <button
            onClick={() => onInjectHazard('auto_merge')}
            className="px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/35 text-amber-200 text-[10.5px] font-medium cursor-pointer transition-colors"
          >
            + Informal Auto
          </button>
          <button
            onClick={() => onInjectHazard('pothole')}
            className="px-2 py-1 rounded-lg bg-purple-500/15 hover:bg-purple-500/25 border border-purple-400/35 text-purple-200 text-[10.5px] font-medium cursor-pointer transition-colors"
          >
            + Crater Pothole
          </button>
        </div>

        <div className="bg-[#0B0F17]/75 backdrop-blur-sm border border-slate-400/10 rounded-md px-2 py-0.5 text-[9.5px] font-mono-tech text-slate-400 pointer-events-none">
          3D Orbit: Drag to rotate · Right-drag to pan · Scroll to zoom · Space Play/Pause
        </div>
      </div>

      {/* BOTTOM-RIGHT HUD: Live BEV Tactical Radar Mini-Map */}
      <div className="absolute bottom-3 right-3 bg-[#0E1420]/90 backdrop-blur-md border border-slate-400/25 rounded-xl p-2 shadow-2xl pointer-events-none hidden sm:flex flex-col gap-1">
        <div className="flex items-center justify-between text-[9.5px] font-mono-tech text-slate-300">
          <span className="flex items-center gap-1 text-cyan-300 font-semibold">
            <Compass className="w-3 h-3" /> BEV RADAR
          </span>
          <span>MIN TTC: {minTtcText}</span>
        </div>
        <canvas
          ref={miniMapRef}
          width={142}
          height={128}
          className="rounded-lg border border-slate-400/15 block"
        />
        <div className="flex items-center justify-between text-[9px] font-mono-tech text-slate-400">
          <span>LHT (Keep Left)</span>
          <span>{uiSnapshot.perception.trackedObjects.length} Tracks</span>
        </div>
      </div>
    </div>
  );
};
