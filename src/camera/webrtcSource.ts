/**
 * Phone-as-camera source over WebRTC.
 *
 * Laptop side:
 *   createOffer() → wait for the phone's answer → receive the phone's media
 *   track into a local <video> element which then behaves exactly like a webcam
 *   for the rest of the pipeline (`FrameSource` contract).
 *
 * Security notes:
 *   - The offer/answer/ICE exchange goes through the signalling server, which
 *     only relays between the two authorised peers of a session.
 *   - We never accept a remote stream whose track is not video (audio is not
 *     requested by the phone page, and any audio track is stopped on arrival).
 *   - Disconnects (peer leaving, ICE failure, session expiry) tear down the
 *     peer connection and every track so no camera LED stays on.
 */
import type { CameraError, CameraSourceKind, CameraStatus } from '../vision/types';
import type { FrameSource, FrameSourceInfo } from './types';
import { SignalSocket, type IceServerConfig, type SignalMessage } from './signalClient';
import { observeVideoReady } from './videoReady';

export interface WebRtcSourceOptions {
  sessionId: string;
  socketUrl: string;
  iceServers: IceServerConfig[];
  onStatus: (status: CameraStatus, detail?: string) => void;
  onError: (error: CameraError) => void;
  onTrackInfo: (info: FrameSourceInfo) => void;
  onPeerState?: (state: 'waiting' | 'connecting' | 'connected' | 'disconnected') => void;
}

const CONNECT_TIMEOUT_MS = 25_000;

export class WebRtcCameraSource implements FrameSource {
  readonly kind: CameraSourceKind = 'mobile_webrtc';
  readonly id: string;
  readonly label = 'Mobile camera (WebRTC)';
  video: HTMLVideoElement | null = null;
  status: CameraStatus = 'idle';

  private socket: SignalSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private timeoutHandle: number | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private readonly opts: WebRtcSourceOptions;

  constructor(opts: WebRtcSourceOptions) {
    this.opts = opts;
    this.id = `webrtc:${opts.sessionId}`;
  }

  describe(): string {
    const size = this.getFrameSize();
    return size.width ? `WebRTC ${size.width}×${size.height}` : 'awaiting phone';
  }

  getFrameSize(): { width: number; height: number } {
    const v = this.video;
    if (!v) return { width: 0, height: 0 };
    return { width: v.videoWidth || 0, height: v.videoHeight || 0 };
  }

  private setStatus(s: CameraStatus, detail?: string) {
    this.status = s;
    this.opts.onStatus(s, detail);
  }

  async start(): Promise<void> {
    this.setStatus('connecting', 'Opening signalling channel');
    this.opts.onPeerState?.('waiting');
    this.createPeerConnection();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleErr = (err: CameraError) => {
        if (settled) return;
        settled = true;
        this.teardown();
        this.opts.onError(err);
        this.setStatus('error', err.message);
        reject(new Error(err.message));
      };

      this.socket = new SignalSocket(this.opts.socketUrl, {
        onOpen: () => {
          // The laptop drives negotiation: send the offer as soon as the socket
          // is authorised, whether or not the phone is connected yet.
          void this.sendOffer();
        },
        onMessage: (msg) => this.handleSignal(msg, settleOk, settleErr),
        onClose: (code, reason) => {
          if (code === 4000) {
            settleErr({
              code: 'pairing_expired',
              message: `Pairing session closed: ${reason || 'expired'}.`,
              hint: 'Generate a new QR code and scan it again.',
            });
          } else if (this.status === 'live') {
            this.setStatus('stopped', 'Signalling channel closed');
          }
        },
        onError: (message) => {
          if (this.status !== 'live') {
            settleErr({
              code: 'signalling_unavailable',
              message,
              hint: 'Start the signalling server (npm run signal) and check VITE_SIGNAL_URL.',
            });
          }
        },
      });

      this.socket.connect();

      this.timeoutHandle = window.setTimeout(() => {
        settleErr({
          code: 'peer_failed',
          message: 'The phone did not connect in time.',
          hint: 'Make sure the phone opened the QR link, allowed the camera, and stays on this network.',
        });
      }, CONNECT_TIMEOUT_MS);
    });
  }

  private createPeerConnection() {
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers.length ? this.opts.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
      iceCandidatePoolSize: 2,
    });
    this.pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket?.send({ type: 'ice', candidate: event.candidate.toJSON() } as unknown as SignalMessage);
      }
    };

    pc.ontrack = (event) => {
      // Only video is accepted — audio is never requested and would be dropped.
      const [incoming] = event.streams;
      if (!incoming) return;
      for (const track of incoming.getAudioTracks()) {
        track.stop();
        incoming.removeTrack(track);
      }
      this.stream = incoming;
      const video = document.createElement('video');
      video.playsInline = true;
      video.autoplay = true;
      video.muted = true; // never play phone audio
      video.setAttribute('playsinline', 'true');
      video.style.display = 'none';
      video.srcObject = incoming;
      document.body.appendChild(video);
      this.video = video;
      void video.play().catch(() => undefined);
      void observeVideoReady(video).then(() => {
        if (this.timeoutHandle !== null) {
          window.clearTimeout(this.timeoutHandle);
          this.timeoutHandle = null;
        }
        this.setStatus('live', 'Phone camera streaming');
        this.opts.onPeerState?.('connected');
        this.opts.onTrackInfo({
          sourceId: this.id,
          sourceKind: this.kind,
          label: this.label,
          width: video.videoWidth,
          height: video.videoHeight,
          frameRate: 0,
        });
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.opts.onPeerState?.('connected');
      } else if (state === 'connecting') {
        this.opts.onPeerState?.('connecting');
      } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.opts.onPeerState?.('disconnected');
        if (this.status === 'live') {
          this.opts.onError({
            code: 'peer_failed',
            message: `WebRTC connection ${state}.`,
            hint:
              'If the phone is on mobile data, configure TURN (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL) on the signalling server.',
          });
          this.setStatus('error', `WebRTC ${state}`);
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this.opts.onError({
          code: 'peer_failed',
          message: 'ICE negotiation failed. The two devices likely cannot reach each other.',
          hint: 'Use the same Wi-Fi network, or configure TURN for internet-wide pairing.',
        });
      }
    };
  }

  private async sendOffer() {
    if (!this.pc) return;
    try {
      const pc = this.pc;
      // Receive-only transceiver: we never send our own camera to the phone.
      pc.addTransceiver('video', { direction: 'recvonly' });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket?.send({ type: 'offer', sdp: offer.sdp ?? '' } as unknown as SignalMessage);
      this.setStatus('connecting', 'Offer sent — waiting for the phone');
    } catch (err) {
      this.opts.onError({
        code: 'peer_failed',
        message: `Failed to create WebRTC offer: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.setStatus('error', 'offer failed');
    }
  }

  private async handleSignal(
    msg: SignalMessage,
    settleOk: () => void,
    settleErr: (e: CameraError) => void
  ) {
    const pc = this.pc;
    if (!pc) return;
    switch (msg.type) {
      case 'ready':
        // Socket authorised; if the phone is already waiting the offer is
        // re-sent so no message can be lost to a race.
        if (msg.peerPresent) void this.sendOffer();
        break;
      case 'peer_joined':
        this.setStatus('connecting', 'Phone joined — negotiating');
        void this.sendOffer();
        break;
      case 'peer_left':
        this.setStatus('stopped', 'Phone disconnected');
        this.opts.onPeerState?.('disconnected');
        break;
      case 'answer':
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          this.remoteDescriptionSet = true;
          for (const candidate of this.pendingCandidates.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => undefined);
          }
        } catch (err) {
          settleErr({
            code: 'peer_failed',
            message: `Invalid answer from phone: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break;
      case 'ice':
        if (!this.remoteDescriptionSet) {
          this.pendingCandidates.push(msg.candidate);
        } else {
          await pc.addIceCandidate(msg.candidate).catch(() => undefined);
        }
        break;
      case 'session_closed':
        settleErr({
          code: 'pairing_expired',
          message: `Pairing session closed (${msg.reason}).`,
        });
        break;
      case 'error':
        settleErr({
          code: 'signalling_unavailable',
          message: `Signalling server rejected the connection: ${msg.reason}`,
        });
        break;
      case 'peer_absent':
        this.setStatus('connecting', 'Connect the phone to continue');
        break;
      default:
        break;
    }
    if (this.status === 'live') settleOk();
  }

  stop(): void {
    this.socket?.send({ type: 'bye' });
    this.teardown();
    if (this.status !== 'error') this.setStatus('stopped', 'Stopped');
  }

  private teardown() {
    if (this.timeoutHandle !== null) {
      window.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.socket?.close();
    this.socket = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
  }
}
