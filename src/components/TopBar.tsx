import React from 'react';
import {
  Activity,
  Award,
  BookOpen,
  Box,
  CloudRain,
  Compass,
  Map as MapIcon,
  Pause,
  Play,
  RotateCcw,
  StepForward,
  Sun,
  Video,
  VideoOff,
  Wind,
} from 'lucide-react';
import { ScenarioId, SensorNoiseConfig } from '../types/simulation';
import { ENDLESS_LIST_META, SCENARIO_LIST_META } from '../simulation/scenarios';

interface TopBarProps {
  activeScenarioId: ScenarioId;
  completedScenarios: Record<ScenarioId, boolean>;
  running: boolean;
  simSpeed: number;
  autoDemo: boolean;
  isRecording: boolean;
  weatherMode: SensorNoiseConfig['weatherMode'];
  viewMode: '3d' | '2d';
  onChangeViewMode: (mode: '3d' | '2d') => void;
  onSelectScenario: (id: ScenarioId) => void;
  onToggleRun: () => void;
  onStepOnce: () => void;
  onReset: () => void;
  onChangeSimSpeed: (speed: number) => void;
  onToggleAutoDemo: () => void;
  onToggleRecord: () => void;
  onCycleWeather: () => void;
  onOpenValidation: () => void;
  onOpenReport: () => void;
  /** Operating-mode selector (Simulation / Real Camera / Hybrid). */
  modeControl?: React.ReactNode;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeScenarioId,
  completedScenarios,
  running,
  simSpeed,
  autoDemo,
  isRecording,
  weatherMode,
  viewMode,
  onChangeViewMode,
  onSelectScenario,
  onToggleRun,
  onStepOnce,
  onReset,
  onChangeSimSpeed,
  onToggleAutoDemo,
  onToggleRecord,
  onCycleWeather,
  onOpenValidation,
  onOpenReport,
  modeControl,
}) => {
  const weatherLabel =
    weatherMode === 'clear'
      ? 'Clear'
      : weatherMode === 'monsoon_haze'
      ? 'Monsoon Haze'
      : 'Dust Glare';

  const WeatherIcon =
    weatherMode === 'clear' ? Sun : weatherMode === 'monsoon_haze' ? CloudRain : Wind;

  return (
    <header className="h-[54px] shrink-0 bg-[#111827] border-b border-slate-400/15 px-3 flex items-center justify-between gap-2 overflow-x-auto">
      {/* Left: Brand Identity */}
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-cyan-500/15 border border-cyan-400/40 flex items-center justify-center text-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.2)]">
          <Compass className="w-4.5 h-4.5" />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-bold tracking-tight text-slate-100">
              BHARAT-AV
            </span>
            <span className="text-[10px] font-mono-tech px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
              PS-26037
            </span>
          </div>
          <p className="text-[10px] text-slate-400 hidden xl:block">
            Adaptive Unstructured Road PathBench
          </p>
        </div>
      </div>

      {/* Operating mode: Simulation / Real Camera / Hybrid */}
      {modeControl && (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[9px] font-mono-tech uppercase tracking-wider text-slate-500 hidden 2xl:inline">
            Mode
          </span>
          {modeControl}
        </div>
      )}

      {/* Center: 5 Scenario Selector Pills */}
      <nav className="flex items-center gap-1 bg-[#0B0F17] p-1 rounded-lg border border-slate-400/15 shrink-0">
        {SCENARIO_LIST_META.map((sc) => {
          const isActive = sc.id === activeScenarioId;
          const isDone = completedScenarios[sc.id];
          return (
            <button
              key={sc.id}
              onClick={() => onSelectScenario(sc.id)}
              title={`${sc.title} — ${sc.roadType}`}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/45 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/70 border border-transparent'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isDone
                    ? 'bg-emerald-400 shadow-[0_0_6px_#10B981]'
                    : isActive
                    ? 'bg-cyan-400 animate-pulse'
                    : 'bg-slate-600'
                }`}
              />
              <span>{sc.shortTitle}</span>
            </button>
          );
        })}
        {/* Infinite Free Drive: a separate experience, visually distinct so it
            never reads as a sixth scored scenario. */}
        <div className="w-px h-5 bg-slate-600/40 mx-0.5" />
        {ENDLESS_LIST_META.map((sc) => {
          const isActive = sc.id === activeScenarioId;
          return (
            <button
              key={sc.id}
              onClick={() => onSelectScenario(sc.id)}
              title={`${sc.title} — endless procedural road, no goal`}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/50 shadow-sm'
                  : 'text-emerald-300/80 hover:text-emerald-200 hover:bg-emerald-500/10 border border-emerald-400/25'
              }`}
            >
              <span className="text-[10px] leading-none">∞</span>
              <span>{sc.shortTitle}</span>
            </button>
          );
        })}
      </nav>

      {/* Right: Playback + Tools */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Play / Pause / Step / Reset */}
        <div className="flex items-center bg-[#0B0F17] rounded-lg border border-slate-400/15 p-0.5">
          <button
            onClick={onToggleRun}
            title={running ? 'Pause Simulation (Space)' : 'Run Simulation (Space)'}
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer ${
              running
                ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
                : 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
            }`}
          >
            {running ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{running ? 'Pause' : 'Run'}</span>
          </button>
          <button
            onClick={onStepOnce}
            disabled={running}
            title="Step Single Physics Tick (50ms)"
            className="p-1.5 text-slate-300 hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
          >
            <StepForward className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onReset}
            title="Reset Scenario (R)"
            className="p-1.5 text-slate-300 hover:text-white cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Speed Multiplier */}
        <div className="flex items-center bg-[#0B0F17] rounded-lg border border-slate-400/15 p-0.5 text-[11px] font-mono-tech">
          {[0.5, 1, 2].map((spd) => (
            <button
              key={spd}
              onClick={() => onChangeSimSpeed(spd)}
              className={`px-1.5 py-1 rounded cursor-pointer transition-colors ${
                simSpeed === spd
                  ? 'bg-slate-700 text-cyan-300 font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {spd}x
            </button>
          ))}
        </div>

        {/* 3D WebGL / 2D Tactical View Toggle */}
        <div className="flex items-center bg-[#0B0F17] rounded-lg border border-slate-400/15 p-0.5 text-[10.5px] font-mono-tech">
          <button
            onClick={() => onChangeViewMode('3d')}
            title="Interactive 3D WebGL Environment"
            className={`px-2 py-1 rounded flex items-center gap-1 cursor-pointer transition-colors ${
              viewMode === '3d'
                ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/35'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            <Box className="w-3 h-3" />
            <span>3D</span>
          </button>
          <button
            onClick={() => onChangeViewMode('2d')}
            title="2D Bird's-Eye Tactical Lattice View"
            className={`px-2 py-1 rounded flex items-center gap-1 cursor-pointer transition-colors ${
              viewMode === '2d'
                ? 'bg-cyan-500/20 text-cyan-300 font-semibold border border-cyan-500/35'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            <MapIcon className="w-3 h-3" />
            <span>2D</span>
          </button>
        </div>

        {/* Weather / Sensor Noise Toggle */}
        <button
          onClick={onCycleWeather}
          title="Cycle Environmental Sensor Conditions (Clear / Monsoon Haze / Dust Glare)"
          className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 cursor-pointer transition-colors ${
            weatherMode === 'clear'
              ? 'bg-[#0B0F17] border-slate-400/15 text-slate-300 hover:border-slate-400/30'
              : 'bg-amber-500/10 border-amber-400/35 text-amber-300'
          }`}
        >
          <WeatherIcon className="w-3.5 h-3.5" />
          <span className="hidden 2xl:inline">{weatherLabel}</span>
        </button>

        {/* Auto-Demo All 5 Scenarios */}
        <button
          onClick={onToggleAutoDemo}
          title="Auto-Demo Tour: Sequentially navigate all 5 scenarios automatically"
          className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 cursor-pointer transition-colors ${
            autoDemo
              ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-300'
              : 'bg-[#0B0F17] border-slate-400/15 text-slate-300 hover:text-white'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Demo Tour</span>
        </button>

        {/* Canvas Video Capture */}
        <button
          onClick={onToggleRecord}
          title={isRecording ? 'Stop & Download Demonstration Video (.webm)' : 'Record Demonstration Video (.webm)'}
          className={`px-2 py-1.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 cursor-pointer transition-colors ${
            isRecording
              ? 'bg-rose-500/25 border-rose-400/60 text-rose-200 animate-pulse'
              : 'bg-[#0B0F17] border-slate-400/15 text-slate-300 hover:text-white'
          }`}
        >
          {isRecording ? <VideoOff className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
          <span className="hidden xl:inline">{isRecording ? 'Stop Rec' : 'Record'}</span>
        </button>

        {/* Run Full 5-Scenario Validation Suite */}
        <button
          onClick={onOpenValidation}
          className="px-2.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/40 text-emerald-300 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
        >
          <Award className="w-3.5 h-3.5" />
          <span>Validate 5 Scenarios</span>
        </button>

        {/* Technical Report */}
        <button
          onClick={onOpenReport}
          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-400/25 text-slate-200 text-[11px] font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
        >
          <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
          <span className="hidden md:inline">Tech Report</span>
        </button>
      </div>
    </header>
  );
};
