import React, { useEffect, useState } from 'react';
import {
  Award,
  CheckCircle2,
  Download,
  Play,
  RefreshCw,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { runAllScenariosBenchmark } from '../simulation/engine';
import { ScenarioBenchmarkResult, ScenarioId } from '../types/simulation';

interface ValidationModalProps {
  open: boolean;
  onClose: () => void;
  onJumpToScenario: (id: ScenarioId) => void;
}

export const ValidationModal: React.FC<ValidationModalProps> = ({
  open,
  onClose,
  onJumpToScenario,
}) => {
  const [results, setResults] = useState<ScenarioBenchmarkResult[]>([]);
  const [running, setRunning] = useState(false);

  const runSuite = () => {
    setRunning(true);
    // Yield briefly so spinner paints before synchronous headless physics run (~120ms)
    setTimeout(() => {
      const res = runAllScenariosBenchmark();
      setResults(res);
      setRunning(false);
    }, 30);
  };

  useEffect(() => {
    if (open && results.length === 0) {
      runSuite();
    }
  }, [open]);

  if (!open) return null;

  const passedCount = results.filter((r) => r.passed).length;
  const completionRate = results.length > 0 ? (passedCount / results.length) * 100 : 0;
  const totalCollisions = results.reduce((s, r) => s + r.collisions, 0);
  const avgReplan =
    results.length > 0
      ? results.reduce((s, r) => s + r.meanReplanMs, 0) / results.length
      : 0;
  const maxP95Replan =
    results.length > 0 ? Math.max(...results.map((r) => r.p95ReplanMs)) : 0;
  const avgJerk =
    results.length > 0
      ? results.reduce((s, r) => s + r.rmsJerk, 0) / results.length
      : 0;

  const exportJson = () => {
    const payload = {
      problemStatementId: '26037',
      organization: 'MathWorks',
      timestamp: new Date().toISOString(),
      summary: {
        scenariosTested: results.length,
        scenariosPassed: passedCount,
        completionRatePct: completionRate,
        totalCollisions,
        fleetMeanReplanLatencyMs: +avgReplan.toFixed(3),
        fleetMaxP95ReplanLatencyMs: +maxP95Replan.toFixed(3),
        fleetMeanRmsJerkMs3: +avgJerk.toFixed(3),
      },
      scenarios: results,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bharat-av-validation-metrics-ps26037.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const headers = [
      'Code',
      'Scenario',
      'Completed',
      'Passed',
      'Collisions',
      'NearMisses',
      'Duration_s',
      'MeanSpeed_kmh',
      'MinClearance_m',
      'MeanReplan_ms',
      'P95Replan_ms',
      'RMSJerk_ms3',
      'MeanCurvature_invM',
      'StateTransitions',
    ];
    const rows = results.map((r) =>
      [
        r.scenarioCode,
        `"${r.title}"`,
        r.completed,
        r.passed,
        r.collisions,
        r.nearMisses,
        r.durationS.toFixed(2),
        r.meanSpeedKmh.toFixed(2),
        r.minClearanceM.toFixed(3),
        r.meanReplanMs.toFixed(3),
        r.p95ReplanMs.toFixed(3),
        r.rmsJerk.toFixed(3),
        r.meanCurvature.toFixed(4),
        r.stateTransitions,
      ].join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bharat-av-validation-metrics-ps26037.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#111827] border border-slate-400/25 rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-slate-400/15 flex items-center justify-between bg-[#0E1420]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-400/40 flex items-center justify-center text-emerald-300">
              <Award className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">
                Closed-Loop 5-Scenario Validation & Benchmark Suite
              </h2>
              <p className="text-xs text-slate-400">
                Live deterministic execution of Perception → Prediction → Frenet Lattice Planner → Bicycle Controller
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={runSuite}
              disabled={running}
              className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/40 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} />
              <span>{running ? 'Simulating...' : 'Re-Run Suite'}</span>
            </button>
            <button
              onClick={exportCsv}
              disabled={results.length === 0}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-400/20 text-slate-200 text-xs flex items-center gap-1 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV</span>
            </button>
            <button
              onClick={exportJson}
              disabled={results.length === 0}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-400/20 text-slate-200 text-xs flex items-center gap-1 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>JSON</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
            >
              <X className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto telemetry-scroll space-y-5">
          {/* Summary KPI Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[#0B0F17] border border-slate-400/15 rounded-xl p-3">
              <div className="text-[11px] text-slate-400">Scenario Completion Rate</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono-tech text-emerald-400">
                  {completionRate.toFixed(0)}%
                </span>
                <span className="text-xs font-mono-tech text-slate-400">
                  ({passedCount}/{results.length} Passed)
                </span>
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-slate-400/15 rounded-xl p-3">
              <div className="text-[11px] text-slate-400">Total Safety Collisions</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-bold font-mono-tech ${
                    totalCollisions === 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {totalCollisions}
                </span>
                <span className="text-xs font-mono-tech text-emerald-300/80 flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" /> Zero-Collision Target
                </span>
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-slate-400/15 rounded-xl p-3">
              <div className="text-[11px] text-slate-400">Replanning Latency (Mean / P95)</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono-tech text-cyan-300">
                  {avgReplan.toFixed(2)}ms
                </span>
                <span className="text-xs font-mono-tech text-slate-400">
                  / {maxP95Replan.toFixed(2)}ms P95
                </span>
              </div>
            </div>
            <div className="bg-[#0B0F17] border border-slate-400/15 rounded-xl p-3">
              <div className="text-[11px] text-slate-400">Fleet Path Smoothness (RMS Jerk)</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono-tech text-indigo-300">
                  {avgJerk.toFixed(2)}
                </span>
                <span className="text-xs font-mono-tech text-slate-400">m/s³ avg</span>
              </div>
            </div>
          </div>

          {/* Per-Scenario Metrics Table */}
          <div className="bg-[#0B0F17] border border-slate-400/15 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs font-mono-tech">
                <thead className="bg-[#151E2E] text-slate-300 border-b border-slate-400/15">
                  <tr>
                    <th className="py-2.5 px-3">Scenario</th>
                    <th className="py-2.5 px-2.5">Status</th>
                    <th className="py-2.5 px-2.5 text-right">Collisions</th>
                    <th className="py-2.5 px-2.5 text-right">Min Clr</th>
                    <th className="py-2.5 px-2.5 text-right">Mean Speed</th>
                    <th className="py-2.5 px-2.5 text-right">Replan Avg</th>
                    <th className="py-2.5 px-2.5 text-right">Replan P95</th>
                    <th className="py-2.5 px-2.5 text-right">RMS Jerk</th>
                    <th className="py-2.5 px-2.5 text-right">Duration</th>
                    <th className="py-2.5 px-3 text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {results.map((r) => (
                    <tr key={r.scenarioId} className="hover:bg-slate-800/35">
                      <td className="py-2.5 px-3">
                        <div className="font-semibold text-slate-100 font-sans">
                          {r.title}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {r.scenarioCode} · {r.stateTransitions} adaptive transitions
                        </div>
                      </td>
                      <td className="py-2.5 px-2.5">
                        {r.passed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px]">
                            <CheckCircle2 className="w-3 h-3" /> PASS ({r.progressPct.toFixed(0)}%)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px]">
                            <XCircle className="w-3 h-3" /> FAIL ({r.progressPct.toFixed(0)}%)
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2.5 text-right text-emerald-400 font-semibold">
                        {r.collisions}
                      </td>
                      <td className="py-2.5 px-2.5 text-right text-slate-200">
                        {r.minClearanceM.toFixed(2)}m
                      </td>
                      <td className="py-2.5 px-2.5 text-right text-slate-200">
                        {r.meanSpeedKmh.toFixed(1)} km/h
                      </td>
                      <td className="py-2.5 px-2.5 text-right text-cyan-300">
                        {r.meanReplanMs.toFixed(2)}ms
                      </td>
                      <td className="py-2.5 px-2.5 text-right text-cyan-200">
                        {r.p95ReplanMs.toFixed(2)}ms
                      </td>
                      <td className="py-2.5 px-2.5 text-right text-indigo-300">
                        {r.rmsJerk.toFixed(2)} m/s³
                      </td>
                      <td className="py-2.5 px-2.5 text-right text-slate-300">
                        {r.durationS.toFixed(1)}s
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          onClick={() => {
                            onJumpToScenario(r.scenarioId);
                            onClose();
                          }}
                          className="px-2 py-1 rounded bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-[10px] inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Play className="w-2.5 h-2.5" /> Watch
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Visual Comparison Charts: Latency vs 20ms Budget & Minimum Clearance */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#0B0F17] border border-slate-400/15 rounded-xl p-3.5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-slate-200">
                  Replanning Latency vs 20ms Real-Time Budget
                </h3>
                <span className="text-[10px] font-mono-tech text-cyan-400">Lower is faster</span>
              </div>
              <div className="space-y-2.5">
                {results.map((r) => {
                  const pct = Math.min(100, (r.p95ReplanMs / 20) * 100);
                  const meanPct = Math.min(100, (r.meanReplanMs / 20) * 100);
                  return (
                    <div key={r.scenarioId} className="space-y-1">
                      <div className="flex justify-between text-[11px] font-mono-tech">
                        <span className="text-slate-300">{r.scenarioCode}</span>
                        <span className="text-cyan-300">
                          {r.meanReplanMs.toFixed(2)}ms avg / {r.p95ReplanMs.toFixed(2)}ms p95
                        </span>
                      </div>
                      <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden relative">
                        <div
                          className="absolute inset-y-0 left-0 bg-cyan-500/35 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                        <div
                          className="absolute inset-y-0 left-0 bg-cyan-400 rounded-full"
                          style={{ width: `${meanPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-[#0B0F17] border border-slate-400/15 rounded-xl p-3.5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-slate-200">
                  Minimum Safety Clearance & Lateral Smoothness
                </h3>
                <span className="text-[10px] font-mono-tech text-emerald-400">&gt; 0.35m Safe</span>
              </div>
              <div className="space-y-2.5">
                {results.map((r) => {
                  const clrPct = Math.min(100, (r.minClearanceM / 2.5) * 100);
                  return (
                    <div key={r.scenarioId} className="space-y-1">
                      <div className="flex justify-between text-[11px] font-mono-tech">
                        <span className="text-slate-300">{r.scenarioCode}</span>
                        <span className="text-emerald-300">
                          {r.minClearanceM.toFixed(2)}m clr · {r.rmsJerk.toFixed(2)} m/s³ jerk
                        </span>
                      </div>
                      <div className="h-2.5 bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-400 rounded-full"
                          style={{ width: `${clrPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
