import React from 'react';
import { VISION_CLASS_COLORS, VISION_CLASS_LABELS } from '../../vision/detector';
import type { CameraDetection, DetectionFrame } from '../../vision/types';

interface Props {
  frame: DetectionFrame | null;
  videoWidth: number;
  videoHeight: number;
  showLabels: boolean;
  showLowConfidence: boolean;
  /** Minimum confidence to draw (above this the box is drawn solid). */
  minConfidence: number;
  /**
   * How many labels to print. Every box is still drawn — a dense scene can hold
   * 40+ detections in a 640x480 frame, and text for all of them turns the
   * picture into an unreadable wall. Labels go to the strongest detections.
   */
  maxLabels?: number;
}

const RISK_RING: Record<CameraDetection['riskLevel'], string> = {
  CRITICAL: 'ring-2 ring-rose-400/80',
  HIGH: 'ring-1 ring-amber-300/70',
  MEDIUM: '',
  LOW: '',
};

/**
 * Bounding-box overlay drawn in *video frame* coordinates and scaled with CSS
 * percentages, so boxes stay locked to the picture at any container size
 * (object-fit: contain letterboxing is accounted for).
 */
export const DetectionOverlay: React.FC<Props> = ({
  frame,
  videoWidth,
  videoHeight,
  showLabels,
  showLowConfidence,
  minConfidence,
  maxLabels = 8,
}) => {
  if (!frame || !frame.detections.length || !videoWidth || !videoHeight) return null;

  const labelBudget = new Set(
    [...frame.detections]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxLabels)
      .map((d) => d.trackId)
  );

  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
      {frame.detections.map((d) => {
        const dim = d.confidence < minConfidence;
        if (dim && !showLowConfidence) return null;
        const color = VISION_CLASS_COLORS[d.classId];
        const left = (d.box.x / d.frameWidth) * 100;
        const top = (d.box.y / d.frameHeight) * 100;
        const width = (d.box.width / d.frameWidth) * 100;
        const height = (d.box.height / d.frameHeight) * 100;
        const label = VISION_CLASS_LABELS[d.classId] ?? d.classId;
        // Keep the tag inside the frame: anchor it right when the box sits in the
        // right third of the picture.
        // (the tag may extend past the box, so anchor it to the side that keeps
        // the whole label inside the picture)
        const labelSide = left + width / 2 > 50 ? { right: 0 } : { left: 0 };
        return (
          <div
            key={d.trackId}
            className={`absolute ${RISK_RING[d.riskLevel]}`}
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${width}%`,
              height: `${height}%`,
              border: `1.5px solid ${color}`,
              borderColor: color,
              boxShadow: `0 0 0 1px rgba(0,0,0,0.35), 0 0 8px ${color}55`,
              opacity: dim ? 0.4 : 1,
              borderRadius: 2,
            }}
          >
            {showLabels && labelBudget.has(d.trackId) && (
              <div
                className="absolute -top-[15px] px-1 rounded-sm text-[9.5px] font-mono-tech font-semibold whitespace-nowrap leading-[14px]"
                style={{ ...labelSide, backgroundColor: color, color: '#08101C' }}
              >
                {d.trackId} · {label} {(d.confidence * 100).toFixed(0)}%
                {d.distance.provenance === 'estimated' && d.distance.value !== null
                  ? ` · ~${d.distance.value}m`
                  : ''}
              </div>
            )}
            {d.riskLevel === 'CRITICAL' && (
              <div className="absolute -bottom-[15px] left-0 px-1 rounded-sm bg-rose-600 text-white text-[9px] font-mono-tech font-bold leading-[14px]">
                IMAGE-SPACE RISK
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
