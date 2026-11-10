import React from 'react';
import { Blend, Camera, Boxes } from 'lucide-react';
import type { OperatingMode } from '../../vision/types';

interface Props {
  mode: OperatingMode;
  onChange: (mode: OperatingMode) => void;
  cameraLive: boolean;
  detecting: boolean;
}

const MODES: { id: OperatingMode; label: string; short: string; icon: React.ReactNode; title: string }[] = [
  {
    id: 'simulation',
    label: 'Simulation',
    short: 'SIM',
    icon: <Boxes className="w-3 h-3" />,
    title: 'Existing virtual scenarios — virtual agents and sensors only',
  },
  {
    id: 'camera',
    label: 'Real Camera',
    short: 'CAM',
    icon: <Camera className="w-3 h-3" />,
    title: 'Live camera detections only (no simulated objects)',
  },
  {
    id: 'hybrid',
    label: 'Hybrid',
    short: 'HYB',
    icon: <Blend className="w-3 h-3" />,
    title: 'Simulation + real camera; sources stay explicitly separated',
  },
];

/** Operating-mode selector. Kept visually consistent with the TopBar controls. */
export const ModeSwitcher: React.FC<Props> = ({ mode, onChange, cameraLive, detecting }) => (
  <div className="flex items-center bg-[#0B0F17] rounded-lg border border-slate-400/15 p-0.5 text-[10px] font-mono-tech">
    {MODES.map((m) => {
      const active = mode === m.id;
      return (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          title={m.title}
          className={`px-1.5 py-1 rounded flex items-center gap-1 cursor-pointer transition-colors ${
            active
              ? m.id === 'camera'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40 font-semibold'
                : m.id === 'hybrid'
                ? 'bg-purple-500/20 text-purple-300 border border-purple-400/40 font-semibold'
                : 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 font-semibold'
              : 'text-slate-400 hover:text-slate-200 border border-transparent'
          }`}
        >
          {m.icon}
          <span className="hidden xl:inline">{m.label}</span>
          <span className="xl:hidden">{m.short}</span>
          {m.id !== 'simulation' && cameraLive && (
            <span
              className={`w-1 h-1 rounded-full ${
                detecting ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'
              }`}
            />
          )}
        </button>
      );
    })}
  </div>
);
