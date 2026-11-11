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
  /**
   * Credential presented as the first frame after the socket opens. It is not
   * part of `socketUrl` because query strings leak into proxy access logs.
   */
  socketTicket: string;
  iceServers: IceServerConfig[];
  onStatus: (status: CameraStatus, detail?: string) => void;
  onError: (error: CameraError) => void;
  onTrackInfo: (info: FrameSourceInfo) => void;
  onPeerState?: (state: 'waiting' | 'connecting' | 'connected' | 'disconnected') => void;
  /** Fires whenever this source gains its remote video element. */
  onVideoChange?: (video: HTMLVideoElement | null) => void;
}

/**
 * Two distinct waits, because they fail for different reasons:
 *  - JOIN: the phone has not opened the QR link at all (scan/permission issue).
 *  - MEDIA: the phone joined and negotiated, but no frames arrived (it is still
 *    sitting on its permission prompt, or media is blocked).
 *
 * A single 25 s timer used to cover both, so a user who scanned, read the
 * consent dialog and pressed "Start camera" after 25 s had their session torn
 * down mid-negotiation ("peer_left" on the phone).
 */
const JOIN_TIMEOUT_MS = 120_000;
const MEDIA_TIMEOUT_MS = 60_000;

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
        this.settleStart = null;
        resolve();
      };
      this.settleStart = settleOk;
      const settleErr = (err: CameraError) => {
        if (settled) return;
        settled = true;
        this.teardown();
        this.opts.onError(err);
        this.setStatus('error', err.message);
        reject(new Error(err.message));
      };

      this.socket = new SignalSocket(
        this.opts.socketUrl,
        {
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
        },
        { role: 'laptop', sessionId: this.opts.sessionId, ticket: this.opts.socketTicket }
      );

      this.socket.connect();

      this.armTimeout(
        JOIN_TIMEOUT_MS,
        'The phone did not join in time.',
        'Open the QR link on the phone. Generate a fresh QR code if this one expired.',
        settleErr
      );
    });
  }

  /**
   * Stop and detach the remote stream without closing the signalling session or
   * the peer connection, so a reconnecting phone can resume. This is what stops
   * the detector from scoring the last frozen frame forever.
   */
  private releaseStream(): void {
    this.settleStart = null;
    this.opts.onVideoChange?.(null);
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
  }

  /** (Re)arm the one-shot connection timeout. */
  private armTimeout(
    ms: number,
    message: string,
    hint: string,
    settleErr: (e: CameraError) => void
  ) {
    if (this.timeoutHandle !== null) window.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = window.setTimeout(() => {
      settleErr({ code: 'peer_failed', message, hint });
    }, ms);
  }

  private createPeerConnection() {
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers.length ? this.opts.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
      iceCandidatePoolSize: 2,
    });
    this.pc = pc;
    this.localOfferSent = false;
    this.offering = false;

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
      /*
       * One element per source. A renegotiation can fire `ontrack` again for
       * the same stream (and a re-offer after a camera flip does exactly that);
       * creating a second hidden <video> there left the first attached to the
       * page forever, still holding a live MediaStream. Reuse the element when
       * it already carries this stream.
       */
      if (this.video && this.video.srcObject === incoming) {
        this.stream = incoming;
        if (this.timeoutHandle !== null) {
          window.clearTimeout(this.timeoutHandle);
          this.timeoutHandle = null;
        }
        this.setStatus('live', 'Phone camera streaming');
        this.settleStart?.();
        return;
      }
      if (this.video) {
        const stale = this.video;
        if (stale.srcObject) {
          for (const t of (stale.srcObject as MediaStream).getTracks()) {
            if (t !== incoming.getVideoTracks()[0]) t.stop();
          }
        }
        stale.srcObject = null;
        stale.remove();
        this.video = null;
      }
      this.stream = incoming;
      // A remote track can end (phone closed the page / stopped the camera)
      // without the peer connection closing immediately. Surface it right away.
      for (const track of incoming.getVideoTracks()) {
        track.addEventListener('ended', () => {
          this.opts.onPeerState?.('disconnected');
          this.setStatus('stopped', 'Phone stopped sending video');
        });
      }
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
        this.opts.onVideoChange?.(video);
        // Media is here: this is what "connected" means, so settle start() now
        // rather than waiting for a signalling message that may never come.
        this.settleStart?.();
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

  private offering = false;
  private localOfferSent = false;
  /**
   * Resolver for the in-flight `start()` promise.
   *
   * `start()` used to settle only from a signalling handler, i.e. only if
   * another message arrived after the peer became live. When the media track
   * was the last event — the normal case — the promise never settled, so
   * `connectMobile()` never reached `engine.setSource(source)` and the detection
   * engine had no source at all. The media path now settles it directly.
   */
  private settleStart: (() => void) | null = null;

  /**
   * Send the laptop's initial offer (recv-only: we never send our camera).
   *
   * `peer_joined` and `ready(peerPresent)` can both fire for the same phone, so
   * this is idempotent: the recvonly transceiver is created once and no second
   * offer is produced while an exchange is in flight or already answered.
   * A duplicated transceiver would put two video m-lines in the SDP and the
   * phone's single track would bind to only one of them.
   */
  private async sendOffer() {
    const pc = this.pc;
    if (!pc || this.offering || this.localOfferSent) return;
    if (pc.signalingState !== 'stable') return;
    this.offering = true;
    try {
      if (!pc.getTransceivers().some((t) => t.receiver?.track?.kind === 'video' || t.sender === null)) {
        pc.addTransceiver('video', { direction: 'recvonly' });
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.localOfferSent = true;
      this.socket?.send({
        type: 'offer',
        sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
      } as unknown as SignalMessage);
      this.setStatus('connecting', 'Offer sent — waiting for the phone');
    } catch (err) {
      this.opts.onError({
        code: 'peer_failed',
        message: `Failed to create WebRTC offer: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.setStatus('error', 'offer failed');
    } finally {
      this.offering = false;
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
        // The phone is here. What we are waiting for now is media, which the
        // phone cannot send until its user grants camera permission.
        this.armTimeout(
          MEDIA_TIMEOUT_MS,
          'The phone joined but sent no video.',
          'Press "Start camera" on the phone and allow camera access.',
          settleErr
        );
        void this.sendOffer();
        break;
      case 'peer_left':
        this.setStatus('stopped', 'Phone disconnected');
        this.opts.onPeerState?.('disconnected');
        this.releaseStream();
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
      case 'offer':
        /*
         * The phone re-offers when it adds its camera track after the first
         * negotiation (it must answer before the user has granted permission,
         * so the initial m-line carries no track). Without this answer the
         * video never flows.
         */
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          this.remoteDescriptionSet = true;
          for (const candidate of this.pendingCandidates.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => undefined);
          }
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket?.send({
            type: 'answer',
            sdp: pc.localDescription?.sdp ?? answer.sdp ?? '',
          } as unknown as SignalMessage);
        } catch (err) {
          settleErr({
            code: 'peer_failed',
            message: `Failed to answer the phone's re-offer: ${err instanceof Error ? err.message : String(err)}`,
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
