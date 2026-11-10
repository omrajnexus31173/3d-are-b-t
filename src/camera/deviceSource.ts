/**
 * Local camera source: laptop webcam, USB-A webcam, USB-C UVC webcam, capture
 * cards. All of these are exposed by the browser through
 * `navigator.mediaDevices` — the application never claims direct hardware
 * access beyond what the OS/browser actually exposes.
 *
 * UVC phones: a phone only appears here if the operating system exposes it as a
 * video capture device (Android USB webcam mode / iPhone Continuity Camera).
 * When it does not, `listCameraDevices()` explains that and the UI points the
 * user to the QR/WebRTC path.
 */
import type { CameraDeviceInfo, CameraError, CameraSourceKind } from '../vision/types';
import type { CameraDeviceListResult, FrameSource, FrameSourceInfo } from './types';
import { observeVideoReady } from './videoReady';

/** Map a MediaDeviceInfo to a human-friendly label + inferred source kind. */
export function classifyVideoDevice(device: MediaDeviceInfo, index: number): CameraDeviceInfo {
  const raw = device.label || `Camera ${index + 1}`;
  const lower = raw.toLowerCase();
  let kind: CameraSourceKind = 'webcam';
  if (/usb|uvc|web ?cam|hd camera|external|capture|elgato|logitech|brio|c920|c922/.test(lower)) {
    kind = 'usb_uvc';
  }
  if (/iphone|android|pixel|galaxy|redmi|oneplus|phone|continuity/.test(lower)) {
    kind = 'usb_uvc';
  }
  return {
    deviceId: device.deviceId,
    label: raw,
    kind,
    groupId: device.groupId,
  };
}

export function cameraErrorFrom(err: unknown): CameraError {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'permission_denied',
        message: 'Camera permission was denied.',
        hint: 'Allow camera access in the browser site settings, then try again. Permission prompts are blocked inside some embedded previews.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        code: 'no_device',
        message: 'No camera device was found.',
        hint: 'Connect a USB/UVC camera or use the QR pairing flow to stream from a phone.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        code: 'device_busy',
        message: 'The camera exists but could not be started.',
        hint: 'Another application (Zoom, Teams, OBS…) may be using it. Close it and retry.',
      };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        code: 'overconstrained',
        message: 'The requested camera resolution/mode is not supported by this device.',
        hint: 'Try a lower resolution or a different device.',
      };
    case 'AbortError':
      return { code: 'device_busy', message: 'The camera start was aborted by the system.' };
    default:
      return { code: 'unknown', message: message || 'Unknown camera error.' };
  }
}

/**
 * Enumerate video inputs. Labels are only populated after permission has been
 * granted at least once — we therefore request a throw-away permission probe
 * when the caller allows it (never silently in the background without the user
 * clicking something).
 */
export async function listCameraDevices(options: { requestPermission?: boolean } = {}): Promise<CameraDeviceListResult> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return {
      ok: false,
      error: {
        code: 'unsupported_browser',
        message: 'This browser does not expose camera enumeration (navigator.mediaDevices).',
        hint: 'Use a current Chrome, Edge, Firefox or Safari over HTTPS (or localhost).',
      },
    };
  }

  let permission: 'granted' | 'prompt' | 'unknown' | 'denied' = 'unknown';
  try {
    const status = await navigator.permissions?.query?.({ name: 'camera' as PermissionName });
    if (status?.state) permission = status.state === 'denied' ? 'denied' : status.state;
  } catch {
    /* Safari does not support querying the camera permission */
  }

  if (options.requestPermission) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach((t) => t.stop());
      permission = 'granted';
    } catch (err) {
      const mapped = cameraErrorFrom(err);
      // Enumeration may still work (labels hidden); report the error but keep
      // whatever devices we can see so the UI can render a disabled list.
      const devices = await safeEnumerate();
      return { ok: false, error: mapped, devices } as unknown as CameraDeviceListResult;
    }
  }

  const devices = await safeEnumerate();
  return { ok: true, devices, permission };
}

async function safeEnumerate(): Promise<CameraDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => classifyVideoDevice(d, i));
  } catch {
    return [];
  }
}

export interface LocalCameraOptions {
  deviceId?: string;
  /** Preferred capture size; the browser may pick a closer supported mode. */
  width?: number;
  height?: number;
  frameRate?: number;
  facingMode?: 'user' | 'environment';
}

/** A camera backed by `getUserMedia` (webcam / USB / UVC). */
export class LocalCameraSource implements FrameSource {
  readonly kind: CameraSourceKind;
  readonly id: string;
  readonly label: string;
  video: HTMLVideoElement | null = null;
  status: 'idle' | 'requesting_permission' | 'connecting' | 'live' | 'error' | 'stopped' = 'idle';

  private stream: MediaStream | null = null;
  private options: LocalCameraOptions;
  private listeners: {
    status: (s: 'idle' | 'requesting_permission' | 'connecting' | 'live' | 'error' | 'stopped', detail?: string) => void;
    error: (e: CameraError) => void;
    trackInfo: (i: FrameSourceInfo) => void;
  };
  private deviceChangeHandler: (() => void) | null = null;

  constructor(options: LocalCameraOptions, listeners: {
    status: (s: 'idle' | 'requesting_permission' | 'connecting' | 'live' | 'error' | 'stopped', detail?: string) => void;
    error: (e: CameraError) => void;
    trackInfo: (i: FrameSourceInfo) => void;
  }) {
    this.options = options;
    this.listeners = listeners;
    this.id = options.deviceId ? `local:${options.deviceId}` : 'local:default';
    this.label = 'Local camera';
    this.kind = 'webcam';
  }

  describe(): string {
    const size = this.getFrameSize();
    return size.width ? `${size.width}×${size.height}` : 'not started';
  }

  getFrameSize(): { width: number; height: number } {
    const v = this.video;
    if (!v) return { width: 0, height: 0 };
    return { width: v.videoWidth || 0, height: v.videoHeight || 0 };
  }

  private setStatus(s: LocalCameraSource['status'], detail?: string) {
    this.status = s;
    this.listeners.status(s, detail);
  }

  async start(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const error: CameraError = {
        code: 'unsupported_browser',
        message: 'getUserMedia is not available in this browser context.',
        hint: 'Camera access requires HTTPS or localhost and a modern browser.',
      };
      this.setStatus('error');
      this.listeners.error(error);
      throw new Error(error.message);
    }

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      const error: CameraError = {
        code: 'security_context',
        message: 'Camera access requires a secure context (HTTPS or localhost).',
        hint: 'Open the app over https:// or on http://localhost. The dev server can serve HTTPS (npm run dev:https).',
      };
      this.setStatus('error');
      this.listeners.error(error);
      throw new Error(error.message);
    }

    this.setStatus('requesting_permission');
    try {
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: this.options.deviceId
          ? {
              deviceId: { exact: this.options.deviceId },
              width: this.options.width ? { ideal: this.options.width } : undefined,
              height: this.options.height ? { ideal: this.options.height } : undefined,
              frameRate: this.options.frameRate ? { ideal: this.options.frameRate } : undefined,
            }
          : {
              facingMode: this.options.facingMode ?? 'environment',
              width: this.options.width ? { ideal: this.options.width } : undefined,
              height: this.options.height ? { ideal: this.options.height } : undefined,
            },
      };
      this.setStatus('connecting');
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.stream = stream;

      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.setAttribute('playsinline', 'true');
      video.style.display = 'none';
      video.srcObject = stream;
      document.body.appendChild(video);
      this.video = video;

      await video.play().catch(() => undefined);
      await observeVideoReady(video);

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      this.listeners.trackInfo({
        sourceId: this.id,
        sourceKind: this.kind,
        label: track?.label || this.label,
        width: video.videoWidth,
        height: video.videoHeight,
        frameRate: settings.frameRate ?? 0,
        facingMode: settings.facingMode,
      });

      // Detect physical disconnection (cable pulled / device removed).
      this.deviceChangeHandler = () => {
        const stillThere = stream.getVideoTracks().some((t) => t.readyState === 'live');
        if (!stillThere) {
          this.listeners.error({
            code: 'device_busy',
            message: 'Camera disconnected.',
            hint: 'Reconnect the device and press Connect again.',
          });
          this.setStatus('error');
        }
      };
      navigator.mediaDevices.addEventListener('devicechange', this.deviceChangeHandler);

      track?.addEventListener('ended', () => {
        this.setStatus('stopped', 'Track ended by the operating system');
      });

      this.setStatus('live');
    } catch (err) {
      const error = cameraErrorFrom(err);
      this.setStatus('error');
      this.listeners.error(error);
      throw err instanceof Error ? err : new Error(error.message);
    }
  }

  stop(): void {
    if (this.deviceChangeHandler && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeHandler);
      this.deviceChangeHandler = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    if (this.status !== 'error') this.setStatus('stopped');
  }
}
