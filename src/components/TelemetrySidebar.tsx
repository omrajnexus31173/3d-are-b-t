import React from 'react';
import {
  Activity,
  AlertTriangle,
  Car,
  CheckCircle2,
  Cpu,
  Gauge,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { SimulationState, TelemetryPoint } from '../types/simulation';

interface TelemetrySidebarProps {
  sim: SimulationState;
}

function buildSparklinePath(
  points: TelemetryPoint[],
  accessor: (p: TelemetryPoint) => number,
  width: number,
  height: number,
  maxValue: number
): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const y = height - (Math.min(maxValue, accessor(points[0])) / maxValue) * (height - 4) - 2;
    return `M 0 ${y.toFixed(1)} L ${width} ${y.toFixed(1)}`;
  }
  return points
    .map((pt, i) => {
      const x = (i / (points.length - 1)) * width;
      const v = Math.max(0, Math.min(maxValue, accessor(pt)));
      const y = height - (v / maxValue) * (height - 6) - 3;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

export const TelemetrySidebar: React.FC<TelemetrySidebarProps> = ({ sim }) => {
  const { metrics, telemetryHistory, perception, logs } = sim;

  const replanMaxScale = Math.max(22, metrics.maxReplanMs * 1.1);
  const replanPath = buildSparklinePath(
    telemetryHistory,
    (p) => p.replanMs,
    320,
    46,
    replanMaxScale
  );
  const speedPath = buildSparklinePath(
    telemetryHistory,
    (p) => p.speedKmh,
    320,
    46,
    65
  );
  const jerkPath = buildSparklinePath(
    telemetryHistory,
    (p) => p.jerk,
    320,
    46,
    15
  );

  const budgetLineY = 46 - (20 / replanMaxScale) * 40 - 3;

  const criticalCount = perception.trackedObjects.filter(
    (o) => o.riskLevel === 'CRITICAL'
  ).length;
  const highCount = perception.trackedObjects.filter(
    (o) => o.riskLevel === 'HIGH'
  ).length;
  const vruCount = perception.trackedObjects.filter(
    (o) =>
      o.agentClass === 'pedestrian' ||
      o.agentClass === 'cattle' ||
      o.agentClass === 'two_wheeler'
  ).length;
  const riskScorePct =
    criticalCount > 0 ? 88 : highCount > 0 ? 54 : perception.trackedObjects.length > 0 ? 22 : 6;
  const riskLabel =
    criticalCount > 0 ? 'CRITICAL' : highCount > 0 ? 'ELEVATED' : 'SAFE';
  const riskBadgeStyle =
    criticalCount > 0
      ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
      : highCount > 0
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
      : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35';

  return (
    <aside className="w-full lg:w-[390px] xl:w-[410px] shrink-0 h-full bg-[#0E1420] border-l border-slate-400/15 flex flex-col overflow-y-auto telemetry-scroll p-3 gap-2.5">
      {/* CARD 0: EGO STATUS, DETECTED OBJECTS COUNTER & COLLISION RISK */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Car className="w-3.5 h-3.5 text-cyan-400" />
            <span>AV Telemetry & Collision Risk</span>
          </h2>
          <span
            className={`text-[10px] font-mono-tech px-1.5 py-0.5 rounded border flex items-center gap-1 ${riskBadgeStyle}`}
          >
            {criticalCount > 0 ? (
              <ShieldAlert className="w-3 h-3" />
            ) : highCount > 0 ? (
              <AlertTriangle className="w-3 h-3" />
            ) : (
              <ShieldCheck className="w-3 h-3" />
            )}
            <span>RISK: {riskLabel}</span>
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5 mb-2">
          <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-1.5">
            <div className="text-[9.5px] text-slate-400">Ego Speed</div>
            <div className="text-sm font-bold font-mono-tech text-cyan-300">
              {(sim.ego.speed * 3.6).toFixed(1)}{' '}
              <span className="text-[9.5px] font-normal text-slate-400">km/h</span>
            </div>
          </div>
          <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-1.5">
            <div className="text-[9.5px] text-slate-400">Detected Objects</div>
            <div className="text-sm font-bold font-mono-tech text-slate-100">
              {perception.trackedObjects.length}{' '}
              <span className="text-[9.5px] font-normal text-amber-300">
                ({vruCount} VRU)
              </span>
            </div>
          </div>
          <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-1.5">
            <div className="text-[9.5px] text-slate-400">Control Mode</div>
            <div className="text-[11px] font-bold font-mono-tech text-indigo-300 truncate mt-0.5">
              {sim.ego.isBraking
                ? 'BRAKING'
                : sim.ego.blinker !== 'none'
                ? `EVADE ${sim.ego.blinker.toUpperCase()}`
                : 'CRUISE'}
            </div>
          </div>
        </div>

        {/* Collision Risk Gauge Bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[9.5px] font-mono-tech text-slate-400">
            <span>Collision Risk Envelope</span>
            <span>
              {criticalCount} Critical · {highCount} Caution
            </span>
          </div>
          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-200 ${
                criticalCount > 0
                  ? 'bg-rose-500'
                  : highCount > 0
                  ? 'bg-amber-400'
                  : 'bg-emerald-400'
              }`}
              style={{ width: `${riskScorePct}%` }}
            />
          </div>
        </div>
      </section>

      {/* CARD 1: 2x2 PERFORMANCE VALIDATION KPI GRID */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-cyan-400" />
            <span>Closed-Loop Performance Metrics</span>
          </h2>
          <span
            className={`text-[10px] font-mono-tech px-1.5 py-0.5 rounded border ${
              metrics.collisions === 0
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
                : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
            }`}
          >
            {metrics.collisions === 0 ? 'COLLISION-FREE' : `${metrics.collisions} COLLISIONS`}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {/* Metric 1: Replan Latency */}
          <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-2">
            <div className="text-[10px] text-slate-400">Replanning Latency</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-lg font-bold font-mono-tech text-cyan-300">
                {metrics.meanReplanMs.toFixed(2)}
              </span>
              <span className="text-[10px] font-mono-tech text-slate-400">ms avg</span>
            </div>
            <div className="text-[10px] font-mono-tech text-slate-500 mt-0.5">
              P95: <span className="text-slate-300">{metrics.p95ReplanMs.toFixed(2)}ms</span> · &lt;20ms OK
            </div>
          </div>

          {/* Metric 2: Path Smoothness */}
          <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-2">
            <div className="text-[10px] text-slate-400">Path Smoothness (Jerk)</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-lg font-bold font-mono-tech text-indigo-300">
                {metrics.rmsJerk.toFixed(2)}
              </span>
              <span className="text-[10px] font-mono-tech text-slate-400">m/s³ RMS</span>
            </div>
            <div className="text-[10px] font-mono-tech text-slate-500 mt-0.5">
              κ̄: <span className="text-slate-300">{metrics.meanCurvature.toFixed(3)} m⁻¹</span>
            </div>
          </div>

          {/* Metric 3: Obstacle Clearance */}
          <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-2">
            <div className="text-[10px] text-slate-400">Min Obstacle Clearance</div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span
                className={`text-lg font-bold font-mono-tech ${
                  metrics.minClearanceM >= 0.5 ? 'text-emerald-300' : 'text-amber-300'
                }`}
              >
                {metrics.minClearanceM > 50 ? '—' : metrics.minClearanceM.toFixed(2)}
              </span>
              <span className="text-[10px] font-mono-tech text-slate-400">m</span>
            </div>
            <div className="text-[10px] font-mono-tech text-slate-500 mt-0.5">
              Collisions: <span className="text-emerald-400 font-semibold">{metrics.collisions}</span> · Near: {metrics.nearMisses}
            </div>
          </div>

          {/* Metric 4: Scenario Progress */}
          <div className="bg-[#0B0F17] border border-slate-400/10 rounded-lg p-2">
            <div className="flex items-center justify-between text-[10px] text-slate-400">
              <span>Completion</span>
              <span className="font-mono-tech text-slate-300">{metrics.simTime.toFixed(1)}s</span>
            </div>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-lg font-bold font-mono-tech text-slate-100">
                {metrics.progressPct.toFixed(0)}%
              </span>
              {metrics.completed && (
                <span className="text-[10px] font-mono-tech text-emerald-400 flex items-center gap-0.5">
                  <CheckCircle2 className="w-3 h-3" /> PASS
                </span>
              )}
            </div>
            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mt-1.5">
              <div
                className={`h-full transition-all duration-150 ${
                  metrics.completed ? 'bg-emerald-400' : 'bg-cyan-400'
                }`}
                style={{ width: `${metrics.progressPct}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      {/* CARD 2: REAL-TIME LATENCY & SMOOTHNESS SPARKLINES */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
            <span>Replanning Latency & Kinematics</span>
          </h2>
          <span className="text-[9.5px] font-mono-tech text-slate-400">
            {metrics.totalReplans} replans
          </span>
        </div>

        {/* Latency trace */}
        <div className="bg-[#0B0F17] rounded-lg border border-slate-400/10 p-2 mb-2">
          <div className="flex items-center justify-between text-[10px] font-mono-tech mb-1">
            <span className="text-cyan-300">Replan Time (ms)</span>
            <span className="text-slate-500">20ms RT budget</span>
          </div>
          <svg viewBox="0 0 320 46" className="w-full h-[46px] overflow-visible">
            <line
              x1="0"
              y1={budgetLineY}
              x2="320"
              y2={budgetLineY}
              stroke="rgba(244, 63, 94, 0.45)"
              strokeDasharray="4 3"
              strokeWidth="1"
            />
            <path
              d={replanPath}
              fill="none"
              stroke="#22D3EE"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Speed & Jerk trace */}
        <div className="bg-[#0B0F17] rounded-lg border border-slate-400/10 p-2">
          <div className="flex items-center justify-between text-[10px] font-mono-tech mb-1">
            <span className="text-emerald-300">
              Speed {(sim.ego.speed * 3.6).toFixed(0)} km/h
            </span>
            <span className="text-amber-300">
              |Jerk| {Math.abs(sim.ego.jerk).toFixed(1)} m/s³
            </span>
          </div>
          <svg viewBox="0 0 320 46" className="w-full h-[46px] overflow-visible">
            <path
              d={speedPath}
              fill="none"
              stroke="#10B981"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d={jerkPath}
              fill="none"
              stroke="#F59E0B"
              strokeWidth="1.35"
              strokeOpacity="0.85"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </section>

      {/* CARD 3: MULTI-SENSOR PERCEPTION & IDD OBJECT TRACKER */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            <span>IDD Multi-Sensor Tracker ({perception.trackedObjects.length})</span>
          </h2>
          <div className="flex items-center gap-1 text-[9px] font-mono-tech">
            <span className="px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300">LiDAR</span>
            <span className="px-1 py-0.5 rounded bg-blue-500/15 text-blue-300">CAM</span>
            <span className="px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300">RADAR</span>
          </div>
        </div>

        <div className="max-h-[168px] overflow-y-auto telemetry-scroll rounded-lg border border-slate-400/10 bg-[#0B0F17]">
          <table className="w-full text-left border-collapse text-[10.5px] font-mono-tech">
            <thead className="sticky top-0 bg-[#151E2E] text-slate-400 border-b border-slate-400/15">
              <tr>
                <th className="py-1.5 px-2 font-medium">ID</th>
                <th className="py-1.5 px-1.5 font-medium">Class</th>
                <th className="py-1.5 px-1.5 font-medium text-right">Dist</th>
                <th className="py-1.5 px-1.5 font-medium text-right">TTC</th>
                <th className="py-1.5 px-2 font-medium text-right">Behavior</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {perception.trackedObjects.slice(0, 8).map((obj) => {
                const riskText =
                  obj.riskLevel === 'CRITICAL'
                    ? 'text-rose-400'
                    : obj.riskLevel === 'HIGH'
                    ? 'text-amber-400'
                    : obj.riskLevel === 'MEDIUM'
                    ? 'text-cyan-300'
                    : 'text-slate-400';

                return (
                  <tr key={obj.id} className="hover:bg-slate-800/40">
                    <td className="py-1 px-2 text-slate-300">{obj.trackId}</td>
                    <td className="py-1 px-1.5 text-slate-200 capitalize truncate max-w-[85px]">
                      {obj.agentClass.replace('_', ' ')}
                    </td>
                    <td className="py-1 px-1.5 text-right text-slate-300">
                      {obj.dist.toFixed(1)}m
                    </td>
                    <td className={`py-1 px-1.5 text-right font-semibold ${riskText}`}>
                      {Number.isFinite(obj.ttc) ? `${obj.ttc.toFixed(1)}s` : '—'}
                    </td>
                    <td className={`py-1 px-2 text-right text-[9.5px] ${riskText}`}>
                      {obj.behaviorHint}
                    </td>
                  </tr>
                );
              })}
              {perception.trackedObjects.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-500">
                    No active road users within sensor horizon
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono-tech text-slate-500">
          <span className="flex items-center gap-1">
            <Cpu className="w-3 h-3 text-slate-400" /> Fusion: {perception.sensorLatencyMs.toFixed(1)}ms
          </span>
          <span className="flex items-center gap-1">
            <ShieldCheck className="w-3 h-3 text-emerald-400" /> IDD-Net Active
          </span>
        </div>
      </section>

      {/* CARD 4: PLANNER DECISION & EVENT STREAM */}
      <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5 flex-1 min-h-[135px] flex flex-col">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-cyan-400" />
            <span>Planner Decision Log</span>
          </h2>
          <span className="text-[9.5px] font-mono-tech text-slate-500">Real-time</span>
        </div>

        <div className="flex-1 overflow-y-auto telemetry-scroll bg-[#0B0F17] rounded-lg border border-slate-400/10 p-2 space-y-1.5 max-h-[175px]">
          {logs.map((entry) => {
            const tagColor =
              entry.level === 'CRITICAL'
                ? 'text-rose-400'
                : entry.level === 'WARN'
                ? 'text-amber-400'
                : entry.level === 'ADAPT'
                ? 'text-indigo-300'
                : entry.level === 'SUCCESS'
                ? 'text-emerald-400'
                : 'text-cyan-400';

            return (
              <div key={entry.id} className="text-[10.5px] leading-snug font-mono-tech flex gap-1.5">
                <span className="text-slate-500 shrink-0">[{entry.simTime.toFixed(1)}s]</span>
                <span className={`font-semibold shrink-0 ${tagColor}`}>{entry.tag}</span>
                <span className="text-slate-300 font-sans">{entry.message}</span>
              </div>
            );
          })}
        </div>
      </section>
    </aside>
  );
};
