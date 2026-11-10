/**
 * Unified camera input interface.
 *
 * Every source (laptop webcam, USB/UVC webcam, phone over WebRTC) implements
 * `FrameSource`, so the detection engine, the review overlay and the hybrid
 * adapter never need to know where pixels came from.
 */
import type { CameraDeviceInfo, CameraError, CameraSourceKind, CameraStatus } from '../vision/types';

export interface FrameSourceEvents {
  onStatus: (status: CameraStatus, detail?: string) => void;
  onError: (error: CameraError) => void;
  onTrackInfo: (info: FrameSourceInfo) => void;
}

export interface FrameSourceInfo {
  sourceId: string;
  sourceKind: CameraSourceKind;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  /** e.g. facingMode for phones. */
  facingMode?: string;
}

export interface FrameSource {
  readonly kind: CameraSourceKind;
  readonly id: string;
  readonly label: string;
  /** HTMLVideoElement that owns the live frames (null before start). */
  readonly video: HTMLVideoElement | null;
  readonly status: CameraStatus;
  start(): Promise<void>;
  stop(): void;
  /** Snapshot the most recent frame size (0 until playback begins). */
  getFrameSize(): { width: number; height: number };
  /** Phone-only: switch between environment / user cameras. */
  switchFacingMode?(): Promise<void>;
  /** Free-form descriptor for the UI. */
  describe(): string;
}

export type CameraDeviceListResult =
  | {
      ok: true;
      devices: CameraDeviceInfo[];
      permission: 'granted' | 'prompt' | 'unknown' | 'denied';
    }
  | { ok: false; error: CameraError };

export class CameraHttpError extends Error {
  constructor(message: string, readonly code: CameraError['code'] = 'unknown') {
    super(message);
    this.name = 'CameraHttpError';
  }
}
