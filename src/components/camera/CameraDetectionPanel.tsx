import React from 'react';
import { Camera, CircleAlert, ScanEye, Waypoints } from 'lucide-react';
import type { DetectionFrame } from '../../vision/types';
import { VISION_CLASS_COLORS, VISION_CLASS_LABELS } from '../../vision/detector';

interface Props {
  frame: DetectionFrame | null;
  detecting: boolean;
  cameraLive: boolean;
  modelReady: boolean;
}

const RISK_TEXT: Record<string, string> = {
  CRITICAL: 'text-rose-400',
  HIGH: 'text-amber-400',
  MEDIUM: 'text-cyan-300',
  LOW: 'text-slate-400',
};

/**
 * Camera detections table for the telemetry sidebar.
 *
 * Every value here is what a monocular camera can actually provide: class,
 * confidence, image-space box, image-space risk and *estimated* distance (only
 * when calibration is configured — otherwise "—" with a provenance column).
 */
export const CameraDetectionPanel: React.FC<Props> = ({ frame, detecting, cameraLive, modelReady }) => {
  const detections = frame?.detections ?? [];

  return (
    <section className="bg-[#111827] border border-slate-400/15 rounded-xl p-2.5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
          <ScanEye className="w-3.5 h-3.5 text-emerald-400" />
          <span>Camera Detections ({detections.length})</span>
        </h2>
        <span
          className={`text-[9px] font-mono-tech px-1.5 py-0.5 rounded border ${
            detecting
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
              : 'bg-slate-700/40 text-slate-300 border-slate-500/30'
          }`}
        >
          {detecting ? 'LIVE CV' : 'PAUSED'}
        </span>
      </div>

      {!detecting && (
        <div className="rounded-lg border border-slate-400/15 bg-[#0B0F17] p-2 text-[10px] text-slate-400 leading-snug">
          {!cameraLive
            ? 'Connect a camera to start real-time detection.'
            : modelReady
            ? 'Camera is live. Press "Start detection" in the Live Camera panel.'
            : 'Detection model not loaded — open the Camera tab and press "Load detection model".'}
        </div>
      )}

      {detecting && (
        <div className="max-h-[172px] overflow-y-auto telemetry-scroll rounded-lg border border-slate-400/10 bg-[#0B0F17]">
          <table className="w-full text-left border-collapse text-[10.5px] font-mono-tech">
            <thead className="sticky top-0 bg-[#151E2E] text-slate-400 border-b border-slate-400/15">
              <tr>
                <th className="py-1.5 px-2 font-medium">ID</th>
                <th className="py-1.5 px-1.5 font-medium">Class</th>
                <th className="py-1.5 px-1.5 font-medium text-right">Conf</th>
                <th className="py-1.5 px-1.5 font-medium text-right">Range</th>
                <th className="py-1.5 px-2 font-medium text-right">Risk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {detections.slice(0, 10).map((d) => (
                <tr key={d.trackId} className="hover:bg-slate-800/40">
                  <td className="py-1 px-2 text-slate-300">{d.trackId}</td>
                  <td className="py-1 px-1.5 truncate max-w-[92px]">
                    <span className="flex items-center gap-1">
                      <span
                        className="w-1.5 h-1.5 rounded-sm shrink-0"
                        style={{ backgroundColor: VISION_CLASS_COLORS[d.classId] }}
                      />
                      <span className="text-slate-200 truncate">
                        {VISION_CLASS_LABELS[d.classId]}
                      </span>
                    </span>
                  </td>
                  <td className="py-1 px-1.5 text-right text-slate-300">
                    {(d.confidence * 100).toFixed(0)}%
                  </td>
                  <td
                    className="py-1 px-1.5 text-right"
                    title={d.distance.basis}
                  >
                    {d.distance.value !== null ? (
                      <span className={d.distance.provenance === 'estimated' ? 'text-amber-300' : 'text-slate-300'}>
                        ~{d.distance.value}m
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className={`py-1 px-2 text-right text-[9.5px] font-semibold ${RISK_TEXT[d.riskLevel]}`}>
                    {d.riskLevel}
                  </td>
                </tr>
              ))}
              {detections.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-500">
                    No objects detected in the current frame
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-[9px] font-mono-tech text-slate-500">
        <span className="flex items-center gap-1">
          <Waypoints className="w-3 h-3" />
          IoU tracker: {frame ? `${frame.detections.length} tracks` : 'idle'}
        </span>
        <span className="flex items-center gap-1 justify-end">
          <Camera className="w-3 h-3" />
          {frame ? `${frame.frameWidth}×${frame.frameHeight}` : 'no frame'}
        </span>
      </div>

      {detections.some((d) => d.distance.provenance === 'unavailable') && (
        <p className="mt-1 flex items-start gap-1 text-[9px] text-slate-500 leading-snug">
          <CircleAlert className="w-3 h-3 shrink-0 mt-[1px] text-slate-500" />
          <span>
            Range is only shown when camera calibration (focal length + sensor width) is configured;
            monocular distance is an <span className="text-amber-400">estimate</span>, never a
            measurement. No metric TTC is claimed.
          </span>
        </p>
      )}
    </section>
  );
};
