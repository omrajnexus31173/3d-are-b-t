import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Crosshair,
  Eye,
  LocateFixed,
  PlusCircle,
  Radio,
  Radar,
  Route,
  Scan,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  LayerVisibility,
  PlannerState,
  RoadAgent,
  SensorNoiseConfig,
  SimulationState,
} from '../types/simulation';
import { HazardInjectionType } from '../simulation/engine';
import { frenetToWorld } from '../simulation/roadMath';

interface SimulationCanvasProps {
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

function drawAgentSprite(ctx: CanvasRenderingContext2D, ag: RoadAgent) {
  ctx.save();
  ctx.translate(ag.x, ag.y);
  ctx.rotate(ag.theta);

  const hl = ag.length * 0.5;
  const hw = ag.width * 0.5;

  switch (ag.agentClass) {
    case 'pothole': {
      // Irregular dark crater with cracked rim
      ctx.fillStyle = '#0F131A';
      ctx.beginPath();
      ctx.ellipse(0, 0, hl, hw, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#6B7280';
      ctx.lineWidth = 0.16;
      ctx.setLineDash([0.35, 0.2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(168, 85, 247, 0.22)';
      ctx.beginPath();
      ctx.ellipse(0, 0, hl * 0.65, hw * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'barricade': {
      ctx.fillStyle = '#EA580C';
      ctx.fillRect(-hl, -hw, ag.length, ag.width);
      ctx.fillStyle = '#F8FAFC';
      for (let y = -hw + 0.2; y < hw - 0.15; y += 0.55) {
        ctx.fillRect(-hl * 0.75, y, ag.length * 0.75, 0.24);
      }
      ctx.strokeStyle = '#1E293B';
      ctx.lineWidth = 0.08;
      ctx.strokeRect(-hl, -hw, ag.length, ag.width);
      break;
    }

    case 'pushcart': {
      // Wooden cart bed + handles + colorful produce baskets
      ctx.fillStyle = '#78350F';
      ctx.beginPath();
      ctx.roundRect(-hl, -hw, ag.length, ag.width, 0.18);
      ctx.fill();
      ctx.strokeStyle = '#D97706';
      ctx.lineWidth = 0.1;
      ctx.stroke();
      // Produce crates
      const crates = [
        { cx: -0.45, cy: -0.25, col: '#22C55E' },
        { cx: 0.35, cy: -0.25, col: '#EF4444' },
        { cx: -0.35, cy: 0.28, col: '#F59E0B' },
        { cx: 0.4, cy: 0.28, col: '#EC4899' },
      ];
      for (const c of crates) {
        ctx.fillStyle = c.col;
        ctx.beginPath();
        ctx.arc(c.cx, c.cy, 0.27, 0, Math.PI * 2);
        ctx.fill();
      }
      // Vendor silhouette behind cart
      ctx.fillStyle = '#FDA4AF';
      ctx.beginPath();
      ctx.arc(-hl - 0.35, 0, 0.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'pedestrian': {
      // Shoulders + head
      ctx.fillStyle = '#FB7185';
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.24, 0.36, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFE4E6';
      ctx.beginPath();
      ctx.arc(0.06, 0, 0.18, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'cattle': {
      // Organic top-down cow/bull silhouette with horns and spotted coat
      ctx.fillStyle = '#E7E5E4';
      ctx.beginPath();
      ctx.ellipse(-0.1, 0, hl * 0.78, hw * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      // Brown patch
      ctx.fillStyle = '#92400E';
      ctx.beginPath();
      ctx.ellipse(-0.25, 0.1, hl * 0.38, hw * 0.52, 0.3, 0, Math.PI * 2);
      ctx.fill();
      // Head
      ctx.fillStyle = '#D6D3D1';
      ctx.beginPath();
      ctx.ellipse(hl * 0.72, 0, 0.34, 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      // Horns
      ctx.strokeStyle = '#FEF3C7';
      ctx.lineWidth = 0.09;
      ctx.beginPath();
      ctx.moveTo(hl * 0.72, -0.22);
      ctx.quadraticCurveTo(hl * 0.95, -0.45, hl * 1.05, -0.28);
      ctx.moveTo(hl * 0.72, 0.22);
      ctx.quadraticCurveTo(hl * 0.95, 0.45, hl * 1.05, 0.28);
      ctx.stroke();
      break;
    }

    case 'auto_rickshaw': {
      // Iconic Indian green & yellow 3-wheeler teardrop/trapezoid silhouette
      ctx.fillStyle = '#15803D'; // Green body
      ctx.beginPath();
      ctx.moveTo(hl, 0);
      ctx.lineTo(hl * 0.25, -hw);
      ctx.lineTo(-hl, -hw);
      ctx.lineTo(-hl, hw);
      ctx.lineTo(hl * 0.25, hw);
      ctx.closePath();
      ctx.fill();
      // Yellow canopy roof
      ctx.fillStyle = '#FACC15';
      ctx.beginPath();
      ctx.roundRect(-hl * 0.88, -hw * 0.78, ag.length * 0.58, ag.width * 0.78, 0.16);
      ctx.fill();
      // Front windshield
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(hl * 0.22, -hw * 0.52, 0.22, ag.width * 0.52);
      break;
    }

    case 'two_wheeler': {
      // Frame + handlebars + helmet
      ctx.fillStyle = '#D97706';
      ctx.beginPath();
      ctx.roundRect(-hl, -hw * 0.55, ag.length, ag.width * 0.55, 0.18);
      ctx.fill();
      // Handlebar
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.moveTo(hl * 0.45, -hw * 0.95);
      ctx.lineTo(hl * 0.45, hw * 0.95);
      ctx.stroke();
      // Rider helmet
      ctx.fillStyle = '#FDE047';
      ctx.beginPath();
      ctx.arc(-0.08, 0, 0.25, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'bus_truck': {
      // Heavy Indian truck/bus with cab & cargo roof
      ctx.fillStyle = '#4F46E5';
      ctx.beginPath();
      ctx.roundRect(-hl, -hw, ag.length, ag.width, 0.28);
      ctx.fill();
      ctx.strokeStyle = '#818CF8';
      ctx.lineWidth = 0.1;
      ctx.stroke();
      // Roof cargo details
      ctx.fillStyle = '#312E81';
      ctx.fillRect(-hl * 0.85, -hw * 0.75, ag.length * 0.68, ag.width * 0.75);
      // Windshield
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(hl * 0.62, -hw * 0.8, ag.length * 0.14, ag.width * 0.8);
      // Headlights
      ctx.fillStyle = '#FEF08A';
      ctx.fillRect(hl - 0.14, -hw * 0.75, 0.14, 0.3);
      ctx.fillRect(hl - 0.14, hw * 0.75 - 0.3, 0.14, 0.3);
      break;
    }

    case 'car':
    default: {
      ctx.fillStyle = '#2563EB';
      ctx.beginPath();
      ctx.roundRect(-hl, -hw, ag.length, ag.width, 0.32);
      ctx.fill();
      ctx.strokeStyle = '#60A5FA';
      ctx.lineWidth = 0.08;
      ctx.stroke();
      // Cabin roof & glass
      ctx.fillStyle = '#0F172A';
      ctx.beginPath();
      ctx.roundRect(-hl * 0.52, -hw * 0.76, ag.length * 0.58, ag.width * 0.76, 0.2);
      ctx.fill();
      ctx.fillStyle = '#3B82F6';
      ctx.fillRect(-hl * 0.3, -hw * 0.62, ag.length * 0.32, ag.width * 0.62);
      // Headlights
      ctx.fillStyle = '#FEF08A';
      ctx.fillRect(hl - 0.12, -hw * 0.72, 0.12, 0.24);
      ctx.fillRect(hl - 0.12, hw * 0.72 - 0.24, 0.12, 0.24);
      break;
    }
  }

  ctx.restore();
}

function drawEgoVehicle(
  ctx: CanvasRenderingContext2D,
  sim: SimulationState,
  nowMs: number
) {
  const { ego, lidarSpinAngle } = sim;
  ctx.save();
  ctx.translate(ego.x, ego.y);
  ctx.rotate(ego.theta);

  const hl = ego.length * 0.5;
  const hw = ego.width * 0.5;

  // Ground shadow glow
  ctx.shadowColor = 'rgba(6, 182, 212, 0.35)';
  ctx.shadowBlur = 14;

  // Front steerable wheels
  const wheelPositions = [
    { x: hl * 0.62, y: -hw - 0.04, steer: ego.steerAngle },
    { x: hl * 0.62, y: hw + 0.04, steer: ego.steerAngle },
    { x: -hl * 0.6, y: -hw - 0.04, steer: 0 },
    { x: -hl * 0.6, y: hw + 0.04, steer: 0 },
  ];
  for (const w of wheelPositions) {
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.rotate(w.steer);
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(-0.34, -0.11, 0.68, 0.22);
    ctx.restore();
  }

  // Chassis body
  ctx.fillStyle = '#E2E8F0';
  ctx.beginPath();
  ctx.roundRect(-hl, -hw, ego.length, ego.width, 0.38);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = '#06B6D4';
  ctx.lineWidth = 0.14;
  ctx.stroke();

  // Windshield & cabin
  ctx.fillStyle = '#0F172A';
  ctx.beginPath();
  ctx.roundRect(-hl * 0.54, -hw * 0.76, ego.length * 0.6, ego.width * 0.76, 0.24);
  ctx.fill();

  // Roof white plate + LiDAR spinning sensor dome
  ctx.fillStyle = '#F8FAFC';
  ctx.beginPath();
  ctx.roundRect(-hl * 0.35, -hw * 0.62, ego.length * 0.36, ego.width * 0.62, 0.16);
  ctx.fill();

  // Spinning roof LiDAR unit
  ctx.save();
  ctx.translate(-0.1, 0);
  ctx.rotate(lidarSpinAngle);
  ctx.fillStyle = '#06B6D4';
  ctx.beginPath();
  ctx.arc(0, 0, 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0B0F17';
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  ctx.moveTo(-0.22, 0);
  ctx.lineTo(0.22, 0);
  ctx.stroke();
  ctx.restore();

  // Headlights
  ctx.fillStyle = '#BAE6FD';
  ctx.fillRect(hl - 0.14, -hw * 0.76, 0.14, 0.28);
  ctx.fillRect(hl - 0.14, hw * 0.76 - 0.28, 0.14, 0.28);

  // Brake lights
  ctx.fillStyle = ego.isBraking ? '#EF4444' : '#7F1D1D';
  ctx.fillRect(-hl, -hw * 0.76, 0.15, 0.32);
  ctx.fillRect(-hl, hw * 0.76 - 0.32, 0.15, 0.32);

  // Dynamic Turn Blinkers when maneuvering laterally
  const blinkOn = Math.floor(nowMs / 220) % 2 === 0;
  if (blinkOn && ego.blinker !== 'none') {
    ctx.fillStyle = '#F59E0B';
    const by = ego.blinker === 'left' ? -hw * 0.88 : hw * 0.88 - 0.16;
    ctx.fillRect(hl - 0.26, by, 0.22, 0.16);
    ctx.fillRect(-hl + 0.04, by, 0.22, 0.16);
  }

  ctx.restore();
}

export const SimulationCanvas: React.FC<SimulationCanvasProps> = ({
  simStateRef,
  uiSnapshot,
  layers,
  weatherMode,
  isRecording,
  onToggleLayer,
  onInjectHazard,
  canvasElementRef,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [followEgo, setFollowEgo] = useState(true);
  const [zoomPxPerM, setZoomPxPerM] = useState(11.5);
  const cameraRef = useRef({ x: 30, y: 0, zoom: 11.5, initialized: false });
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0 });

  useEffect(() => {
    cameraRef.current.zoom = zoomPxPerM;
  }, [zoomPxPerM]);

  // Reset camera smoothly when scenario switches
  useEffect(() => {
    const s = simStateRef.current;
    cameraRef.current.x = s.ego.x + Math.cos(s.ego.theta) * 14;
    cameraRef.current.y = s.ego.y + Math.sin(s.ego.theta) * 14;
    cameraRef.current.initialized = true;
    setFollowEgo(true);
  }, [uiSnapshot.scenario.id, simStateRef]);

  // Main 60 FPS Canvas Rendering Loop
  useEffect(() => {
    let rafId = 0;

    const renderFrame = (nowMs: number) => {
      const canvas = canvasElementRef.current;
      const container = containerRef.current;
      if (canvas && container) {
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.max(100, Math.floor(rect.width * dpr));
        const targetH = Math.max(100, Math.floor(rect.height * dpr));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          const sim = simStateRef.current;
          const w = rect.width;
          const h = rect.height;
          const pxPerM = cameraRef.current.zoom;

          // Smooth camera tracking with forward lookahead
          if (followEgo) {
            const lookX = sim.ego.x + Math.cos(sim.ego.theta) * 14;
            const lookY = sim.ego.y + Math.sin(sim.ego.theta) * 14;
            if (!cameraRef.current.initialized) {
              cameraRef.current.x = lookX;
              cameraRef.current.y = lookY;
              cameraRef.current.initialized = true;
            } else {
              cameraRef.current.x += (lookX - cameraRef.current.x) * 0.12;
              cameraRef.current.y += (lookY - cameraRef.current.y) * 0.12;
            }
          }

          ctx.save();
          ctx.scale(dpr, dpr);

          // 1. Background terrain
          ctx.fillStyle = sim.scenario.terrainTint;
          ctx.fillRect(0, 0, w, h);

          // World transform
          ctx.save();
          ctx.translate(w * 0.44, h * 0.5);
          ctx.scale(pxPerM, pxPerM);
          ctx.translate(-cameraRef.current.x, -cameraRef.current.y);

          // Subtle 10m engineering coordinate grid
          const viewHalfW = w / pxPerM;
          const viewHalfH = h / pxPerM;
          const gxStart = Math.floor((cameraRef.current.x - viewHalfW) / 10) * 10;
          const gxEnd = Math.ceil((cameraRef.current.x + viewHalfW) / 10) * 10;
          const gyStart = Math.floor((cameraRef.current.y - viewHalfH) / 10) * 10;
          const gyEnd = Math.ceil((cameraRef.current.y + viewHalfH) / 10) * 10;

          ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
          ctx.lineWidth = 1 / pxPerM;
          ctx.beginPath();
          for (let gx = gxStart; gx <= gxEnd; gx += 10) {
            ctx.moveTo(gx, gyStart);
            ctx.lineTo(gx, gyEnd);
          }
          for (let gy = gyStart; gy <= gyEnd; gy += 10) {
            ctx.moveTo(gxStart, gy);
            ctx.lineTo(gxEnd, gy);
          }
          ctx.stroke();

          // 2. Cross-roads & merge ramps (drawn under main carriageway)
          for (const cr of sim.scenario.crossRoads) {
            ctx.save();
            ctx.strokeStyle = sim.scenario.shoulderTint;
            ctx.lineWidth = cr.width + 2.4;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.moveTo(cr.x1, cr.y1);
            ctx.lineTo(cr.x2, cr.y2);
            ctx.stroke();

            ctx.strokeStyle = sim.scenario.surfaceTint;
            ctx.lineWidth = cr.width;
            ctx.beginPath();
            ctx.moveTo(cr.x1, cr.y1);
            ctx.lineTo(cr.x2, cr.y2);
            ctx.stroke();
            ctx.restore();
          }

          // 3. Main Unstructured Road Shoulders & Asphalt Polygon
          const samples = sim.scenario.roadSamples;
          if (samples.length > 1) {
            // Unpaved mud/gravel shoulder strip
            ctx.fillStyle = sim.scenario.shoulderTint;
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
              const s = samples[i];
              const off = -(s.leftWidth + s.shoulderLeft);
              const px = s.x + off * s.nx;
              const py = s.y + off * s.ny;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            for (let i = samples.length - 1; i >= 0; i--) {
              const s = samples[i];
              const off = s.rightWidth + s.shoulderRight;
              ctx.lineTo(s.x + off * s.nx, s.y + off * s.ny);
            }
            ctx.closePath();
            ctx.fill();

            // Main Asphalt Carriageway
            ctx.fillStyle = sim.scenario.surfaceTint;
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
              const s = samples[i];
              const off = -s.leftWidth;
              const px = s.x + off * s.nx;
              const py = s.y + off * s.ny;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            for (let i = samples.length - 1; i >= 0; i--) {
              const s = samples[i];
              const off = s.rightWidth;
              ctx.lineTo(s.x + off * s.nx, s.y + off * s.ny);
            }
            ctx.closePath();
            ctx.fill();

            // Rough road edge texture lines
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
            ctx.lineWidth = 0.16;
            ctx.setLineDash([1.6, 1.1]);
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
              const s = samples[i];
              const px = s.x - s.leftWidth * s.nx;
              const py = s.y - s.leftWidth * s.ny;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.stroke();
            ctx.beginPath();
            for (let i = 0; i < samples.length; i++) {
              const s = samples[i];
              const px = s.x + s.rightWidth * s.nx;
              const py = s.y + s.rightWidth * s.ny;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            // Faded lane centerline ONLY where road has formal markings
            ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
            ctx.lineWidth = 0.16;
            ctx.setLineDash([2.8, 3.2]);
            ctx.beginPath();
            let drawing = false;
            for (let i = 0; i < samples.length; i++) {
              const s = samples[i];
              if (s.hasLaneMarks) {
                if (!drawing) {
                  ctx.moveTo(s.x, s.y);
                  drawing = true;
                } else {
                  ctx.lineTo(s.x, s.y);
                }
              } else {
                drawing = false;
              }
            }
            ctx.stroke();
            ctx.setLineDash([]);
          }

          // Goal Finish Corridor Gate
          const goalLeft = frenetToWorld(samples, sim.scenario.goalS, -4.5);
          const goalRight = frenetToWorld(samples, sim.scenario.goalS, 4.5);
          ctx.strokeStyle = 'rgba(16, 185, 129, 0.7)';
          ctx.lineWidth = 0.45;
          ctx.setLineDash([0.8, 0.8]);
          ctx.beginPath();
          ctx.moveTo(goalLeft.x, goalLeft.y);
          ctx.lineTo(goalRight.x, goalRight.y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#10B981';
          ctx.beginPath();
          ctx.arc(goalLeft.x, goalLeft.y, 0.48, 0, Math.PI * 2);
          ctx.arc(goalRight.x, goalRight.y, 0.48, 0, Math.PI * 2);
          ctx.fill();

          // 4. Roadside Environment Props (Stalls, Trees, Buildings, Dividers)
          for (const prop of sim.scenario.props) {
            ctx.save();
            ctx.translate(prop.x, prop.y);
            ctx.rotate(prop.theta);
            if (prop.kind === 'tree') {
              ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
              ctx.beginPath();
              ctx.arc(0.3, 0.3, prop.width * 0.56, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = '#166534';
              ctx.beginPath();
              ctx.arc(0, 0, prop.width * 0.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = '#15803D';
              ctx.beginPath();
              ctx.arc(-0.3, -0.3, prop.width * 0.32, 0, Math.PI * 2);
              ctx.fill();
            } else if (prop.kind === 'stall') {
              ctx.fillStyle = '#7C2D12';
              ctx.fillRect(-prop.length * 0.5, -prop.width * 0.5, prop.length, prop.width);
              ctx.fillStyle = '#F97316';
              ctx.fillRect(-prop.length * 0.45, -prop.width * 0.42, prop.length * 0.9, prop.width * 0.4);
              ctx.fillStyle = '#38BDF8';
              ctx.fillRect(-prop.length * 0.45, 0, prop.length * 0.9, prop.width * 0.36);
            } else if (prop.kind === 'building') {
              ctx.fillStyle = '#1E293B';
              ctx.fillRect(-prop.length * 0.5, -prop.width * 0.5, prop.length, prop.width);
              ctx.strokeStyle = '#334155';
              ctx.lineWidth = 0.25;
              ctx.strokeRect(-prop.length * 0.5, -prop.width * 0.5, prop.length, prop.width);
            } else if (prop.kind === 'divider') {
              ctx.fillStyle = '#FDE047';
              ctx.fillRect(-prop.length * 0.5, -prop.width * 0.5, prop.length, prop.width);
            } else if (prop.kind === 'sign_missing') {
              ctx.fillStyle = '#F43F5E';
              ctx.beginPath();
              ctx.arc(0, 0, 0.55, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }

          // 5. Drivable Corridor Envelope (Lane-Free Estimation)
          if (layers.corridor) {
            const { leftPoints, rightPoints } = sim.perception.corridor;
            if (leftPoints.length > 1) {
              ctx.strokeStyle = 'rgba(6, 182, 212, 0.42)';
              ctx.lineWidth = 0.18;
              ctx.setLineDash([0.9, 0.7]);
              ctx.beginPath();
              leftPoints.forEach((p, idx) =>
                idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
              );
              ctx.stroke();

              ctx.beginPath();
              rightPoints.forEach((p, idx) =>
                idx === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
              );
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }

          // 6. Camera FOV & Radar Cones
          if (layers.cameraFov) {
            ctx.save();
            ctx.translate(sim.ego.x, sim.ego.y);
            ctx.rotate(sim.ego.theta);
            const halfFov = sim.perception.cameraFovRad * 0.5;
            const grad = ctx.createRadialGradient(
              0,
              0,
              1,
              0,
              0,
              sim.perception.cameraRangeM
            );
            grad.addColorStop(0, 'rgba(59, 130, 246, 0.14)');
            grad.addColorStop(1, 'rgba(59, 130, 246, 0.01)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, sim.perception.cameraRangeM, -halfFov, halfFov);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }

          if (layers.radar) {
            ctx.save();
            ctx.translate(sim.ego.x, sim.ego.y);
            ctx.rotate(sim.ego.theta);
            const radarHalf = (23 * Math.PI) / 180;
            ctx.fillStyle = 'rgba(16, 185, 129, 0.06)';
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.25)';
            ctx.lineWidth = 0.1;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, sim.perception.radarRangeM, -radarHalf, radarHalf);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }

          // 7. 360-deg LiDAR Ray Hits
          if (layers.lidar) {
            ctx.lineWidth = 0.05;
            for (const hit of sim.perception.lidarHits) {
              if (hit.hitType === 'clear') continue;
              ctx.strokeStyle =
                hit.hitType === 'agent'
                  ? 'rgba(34, 211, 238, 0.18)'
                  : 'rgba(148, 163, 184, 0.08)';
              ctx.beginPath();
              ctx.moveTo(sim.ego.x, sim.ego.y);
              ctx.lineTo(hit.x, hit.y);
              ctx.stroke();

              ctx.fillStyle =
                hit.hitType === 'agent' ? '#22D3EE' : 'rgba(148, 163, 184, 0.55)';
              ctx.beginPath();
              ctx.arc(hit.x, hit.y, hit.hitType === 'agent' ? 0.2 : 0.13, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          // 8. Non-Lane-Based Irregular Motion Predictions (Uncertainty Ellipses)
          if (layers.predictions) {
            for (const pred of sim.predictions) {
              const isHighEntropy = pred.entropyScore > 0.7;
              const strokeCol = isHighEntropy
                ? 'rgba(244, 63, 94, 0.45)'
                : 'rgba(245, 158, 11, 0.42)';
              const fillCol = isHighEntropy
                ? 'rgba(244, 63, 94, 0.08)'
                : 'rgba(245, 158, 11, 0.07)';

              if (pred.steps.length > 0) {
                ctx.strokeStyle = strokeCol;
                ctx.lineWidth = 0.1;
                ctx.setLineDash([0.35, 0.35]);
                ctx.beginPath();
                pred.steps.forEach((st, idx) =>
                  idx === 0 ? ctx.moveTo(st.x, st.y) : ctx.lineTo(st.x, st.y)
                );
                ctx.stroke();
                ctx.setLineDash([]);

                for (let k = 0; k < pred.steps.length; k++) {
                  const st = pred.steps[k];
                  ctx.save();
                  ctx.translate(st.x, st.y);
                  ctx.rotate(st.theta);
                  ctx.fillStyle = fillCol;
                  ctx.strokeStyle = strokeCol;
                  ctx.lineWidth = 0.06;
                  ctx.beginPath();
                  ctx.ellipse(0, 0, st.rx, st.ry, 0, 0, Math.PI * 2);
                  ctx.fill();
                  ctx.stroke();
                  ctx.restore();
                }
              }
            }
          }

          // 9. Candidate Lattice Trajectories & Optimal Selected Path
          if (layers.candidates && sim.planner.candidates.length > 0) {
            // Draw rejected / alternative samples first
            for (const cand of sim.planner.candidates) {
              if (cand.isSelected) continue;
              // Thin out stopping duplicates visually
              if (cand.targetV === 0 && cand.feasible) continue;

              ctx.strokeStyle = cand.feasible
                ? 'rgba(148, 163, 184, 0.14)'
                : 'rgba(244, 63, 94, 0.10)';
              ctx.lineWidth = cand.feasible ? 0.08 : 0.06;
              ctx.beginPath();
              ctx.moveTo(sim.ego.x, sim.ego.y);
              for (const pt of cand.points) ctx.lineTo(pt.x, pt.y);
              ctx.stroke();
            }

            // Draw Selected Optimal Trajectory with Cyan Glow
            const sel = sim.planner.selectedTrajectory;
            if (sel && sel.points.length > 0) {
              ctx.save();
              ctx.shadowColor = 'rgba(6, 182, 212, 0.75)';
              ctx.shadowBlur = 10;
              ctx.strokeStyle =
                sim.planner.state === 'EMERGENCY_EVADE'
                  ? '#FB7185'
                  : sim.planner.state === 'YIELD_CREEP'
                  ? '#FBBF24'
                  : '#06B6D4';
              ctx.lineWidth = 0.36;
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(sim.ego.x, sim.ego.y);
              for (const pt of sel.points) ctx.lineTo(pt.x, pt.y);
              ctx.stroke();
              ctx.restore();

              // Forward Breadcrumb Nodes
              ctx.fillStyle = '#ECFEFF';
              for (let i = 2; i < sel.points.length; i += 3) {
                const pt = sel.points[i];
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 0.18, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }

          // 10. All Traffic Agents & Hazards
          for (const ag of sim.agents) {
            drawAgentSprite(ctx, ag);
          }

          // 11. Ego Autonomous Vehicle
          drawEgoVehicle(ctx, sim, nowMs);

          // 12. IDD Semantic Detection Bounding Boxes & Labels (in crisp screen-scaled text)
          if (layers.labels) {
            for (const obj of sim.perception.trackedObjects) {
              if (obj.dist > 44) continue;
              const boxCol =
                obj.riskLevel === 'CRITICAL'
                  ? '#F43F5E'
                  : obj.riskLevel === 'HIGH'
                  ? '#F59E0B'
                  : obj.riskLevel === 'MEDIUM'
                  ? '#22D3EE'
                  : '#64748B';

              ctx.save();
              ctx.translate(obj.x, obj.y);
              ctx.rotate(obj.theta);
              ctx.strokeStyle = boxCol;
              ctx.lineWidth = 0.12;
              const pad = 0.25;
              ctx.strokeRect(
                -obj.length * 0.5 - pad,
                -obj.width * 0.5 - pad,
                obj.length + pad * 2,
                obj.width + pad * 2
              );
              ctx.restore();

              // Crisp upright HUD tag above agent
              ctx.save();
              ctx.translate(obj.x, obj.y - obj.width * 0.5 - 0.9);
              ctx.scale(1 / pxPerM, 1 / pxPerM);
              const tagText = `${obj.trackId} ${obj.agentClass
                .replace('_', ' ')
                .toUpperCase()} ${(obj.confidence * 100).toFixed(0)}%`;
              ctx.font = '600 9.5px "JetBrains Mono", monospace';
              const tw = ctx.measureText(tagText).width;
              ctx.fillStyle = 'rgba(11, 15, 23, 0.84)';
              ctx.strokeStyle = boxCol;
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.roundRect(-tw / 2 - 5, -13, tw + 10, 15, 3);
              ctx.fill();
              ctx.stroke();
              ctx.fillStyle = '#F8FAFC';
              ctx.textAlign = 'center';
              ctx.fillText(tagText, 0, -2.5);
              ctx.restore();
            }
          }

          ctx.restore(); // end world transform

          // Atmospheric Weather Overlay (Monsoon Haze / Dust Glare)
          if (weatherMode === 'monsoon_haze') {
            ctx.fillStyle = 'rgba(14, 116, 144, 0.08)';
            ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = 'rgba(186, 230, 253, 0.16)';
            ctx.lineWidth = 1;
            const offset = (nowMs * 0.35) % 45;
            ctx.beginPath();
            for (let rx = -40; rx < w + 40; rx += 38) {
              for (let ry = -40 + offset; ry < h + 40; ry += 45) {
                ctx.moveTo(rx, ry);
                ctx.lineTo(rx - 7, ry + 14);
              }
            }
            ctx.stroke();
          } else if (weatherMode === 'dust_glare') {
            ctx.fillStyle = 'rgba(217, 119, 6, 0.08)';
            ctx.fillRect(0, 0, w, h);
          }

          // Recording red frame border indicator
          if (isRecording) {
            ctx.strokeStyle = 'rgba(244, 63, 94, 0.8)';
            ctx.lineWidth = 4;
            ctx.strokeRect(2, 2, w - 4, h - 4);
          }

          ctx.restore();
        }
      }
      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [followEgo, layers, weatherMode, isRecording, simStateRef, canvasElementRef]);

  // Interactive Zoom & Pan handlers
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -1.1 : 1.1;
    setZoomPxPerM((z) => Math.max(5.5, Math.min(22, +(z + delta).toFixed(1))));
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    if (Math.hypot(dx, dy) > 2) {
      setFollowEgo(false);
    }
    cameraRef.current.x -= dx / cameraRef.current.zoom;
    cameraRef.current.y -= dy / cameraRef.current.zoom;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
  };

  const handleMouseUp = () => {
    dragRef.current.dragging = false;
  };

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

  const layerChips: { key: keyof LayerVisibility; label: string; icon: React.ReactNode }[] = [
    { key: 'lidar', label: 'LiDAR', icon: <Scan className="w-3 h-3" /> },
    { key: 'cameraFov', label: 'Cam FOV', icon: <Eye className="w-3 h-3" /> },
    { key: 'radar', label: 'Radar', icon: <Radar className="w-3 h-3" /> },
    { key: 'predictions', label: 'Pred Tubes', icon: <Radio className="w-3 h-3" /> },
    { key: 'candidates', label: 'Lattice', icon: <Route className="w-3 h-3" /> },
    { key: 'corridor', label: 'Corridor', icon: <Crosshair className="w-3 h-3" /> },
    { key: 'labels', label: 'IDD Boxes', icon: <AlertTriangle className="w-3 h-3" /> },
  ];

  return (
    <div
      ref={containerRef}
      className="relative flex-1 h-full bg-[#0B0F17] overflow-hidden select-none"
    >
      <canvas
        ref={canvasElementRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className="w-full h-full block cursor-grab active:cursor-grabbing"
      />

      {/* TOP-LEFT HUD: Planner State & Vehicle Telemetry Pill */}
      <div className="absolute top-3 left-3 flex flex-col gap-2 max-w-[440px] pointer-events-none">
        <div className="bg-[#111827]/90 backdrop-blur-md border border-slate-400/20 rounded-xl px-3 py-2 shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <span
              className={`px-2 py-0.5 rounded-md text-[10px] font-mono-tech font-bold border ${badge.bg} ${badge.text} ${badge.border}`}
            >
              {badge.label}
            </span>
            <div className="flex items-center gap-3 text-[11px] font-mono-tech text-slate-300">
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
                PLAN <strong className="text-emerald-300">{uiSnapshot.metrics.lastReplanMs.toFixed(1)}ms</strong>
              </span>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-300 leading-snug">
            <span className="text-slate-500 font-mono-tech mr-1.5">[{uiSnapshot.scenario.code}]</span>
            {uiSnapshot.planner.reason}
          </p>
        </div>

        {/* Scenario Description Pill */}
        <div className="bg-[#0B0F17]/80 backdrop-blur-sm border border-slate-400/15 rounded-lg px-2.5 py-1.5 flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold text-slate-300">
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

      {/* TOP-RIGHT HUD: Perception Layer Toggles & Camera Controls */}
      <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
        <div className="flex flex-wrap justify-end gap-1 bg-[#111827]/88 backdrop-blur-md p-1 rounded-xl border border-slate-400/20 shadow-xl max-w-[360px]">
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

        {/* Zoom & Follow Ego Controls */}
        <div className="flex items-center gap-1 bg-[#111827]/88 backdrop-blur-md p-1 rounded-lg border border-slate-400/20">
          <button
            onClick={() => setZoomPxPerM((z) => Math.min(22, +(z + 2).toFixed(1)))}
            title="Zoom In"
            className="p-1 text-slate-300 hover:text-white cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setZoomPxPerM((z) => Math.max(5.5, +(z - 2).toFixed(1)))}
            title="Zoom Out"
            className="p-1 text-slate-300 hover:text-white cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setFollowEgo(true)}
            title="Lock Camera to Ego AV"
            className={`px-2 py-1 rounded text-[10px] font-mono-tech flex items-center gap-1 cursor-pointer ${
              followEgo
                ? 'bg-cyan-500/20 text-cyan-300'
                : 'bg-amber-500/20 text-amber-300 animate-pulse'
            }`}
          >
            <LocateFixed className="w-3 h-3" />
            <span>{followEgo ? 'FOLLOW AV' : 'RE-CENTER'}</span>
          </button>
        </div>
      </div>

      {/* BOTTOM-LEFT HUD: Live Hazard / Chaos Event Injector */}
      <div className="absolute bottom-3 left-3 bg-[#111827]/90 backdrop-blur-md border border-slate-400/20 rounded-xl p-1.5 flex items-center gap-1.5 shadow-xl flex-wrap">
        <span className="text-[10px] font-mono-tech uppercase tracking-wider text-slate-400 px-1.5 flex items-center gap-1">
          <PlusCircle className="w-3 h-3 text-amber-400" />
          Inject Hazard Ahead:
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

      {/* BOTTOM-RIGHT HUD: Scale Calibration & Indian LHT Key */}
      <div className="absolute bottom-3 right-3 bg-[#111827]/85 backdrop-blur-md border border-slate-400/20 rounded-lg px-2.5 py-1.5 flex items-center gap-3 text-[10px] font-mono-tech text-slate-300 pointer-events-none">
        <div className="flex items-center gap-1.5">
          <div
            className="h-1.5 border-b-2 border-l-2 border-r-2 border-cyan-400"
            style={{ width: `${Math.round(10 * zoomPxPerM)}px` }}
          />
          <span>10m</span>
        </div>
        <span className="text-slate-600">|</span>
        <span className="text-slate-400">LHT (Keep Left)</span>
        <span className="text-slate-600">|</span>
        <span>
          MIN TTC: <strong className="text-slate-100">{minTtcText}</strong>
        </span>
      </div>
    </div>
  );
};
