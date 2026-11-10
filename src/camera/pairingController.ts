/**
 * Phone-side pairing controller.
 *
 * Why this is not a React hook
 * ----------------------------
 * The pairing socket is authorised by a *single-use* token and the server
 * allows exactly one phone peer per session. React StrictMode (and Vite's fast
 * refresh) mount effects twice, so a `useEffect`-owned WebSocket opened twice:
 * the second socket was rejected with `phone_already_connected` and the first
 * was orphaned. Owning the socket, the peer connection and the camera stream at
 * module scope means the connection is created exactly once per pairing URL,
 * and React is only a view over its state.
 *
 * Teardown rules
 * --------------
 *   - The user pressing "Stop & disconnect" tears everything down.
 *   - The page being hidden/closed (`pagehide`) tears everything down.
 *   - A React unmount does NOT — that is what StrictMode does on startup — but
 *     the state survives so a remount renders the same live session.
 */
import {
  joinSession,
  signalSocketUrl,
  SignalSocket,
  type IceServerConfig,
  type SignalMessage,
} from './signalClient';
import { observeVideoReady } from './videoReady';

export type PairingPhase =
  | 'preflight'
  | 'joining'
  | 'permission'
  | 'waiting'
  | 'streaming'
  | 'ended'
  | 'error';

export type Facing = 'environment' | 'user';

export interface PairingSnapshot {
  phase: PairingPhase;
  message: string;
  facing: Facing;
  ticketValidated: boolean;
  cameraLive: boolean;
  previewSize: { width: number; height: number } | null;
  iceServers: IceServerConfig[];
}

interface ControllerOptions {
  sessionId: string;
  token: string;
  onSnapshot: (snapshot: PairingSnapshot) => void;
}

const INITIAL: Omit<PairingSnapshot, 'facing'> = {
  phase: 'preflight',
  message: '',
  ticketValidated: false,
  cameraLive: false,
  previewSize: null,
  iceServers: [],
};

export class PairingController {
  private snapshot: PairingSnapshot = { ...INITIAL, facing: 'environment' };
  private socket: SignalSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private stopped = false;
  /** The local camera stream currently published to the laptop. */
  private localStream: MediaStream | null = null;
  private negotiating = false;
  private negotiationNeeded = false;
  /**
   * In-flight `start()`. StrictMode re-runs the mount effect while the first
   * token redemption is still awaiting, so a guard on `this.socket` alone is not
   * enough — the second call would redeem the single-use token again and get
   * 409 `token_already_used`.
   */
  private starting: Promise<void> | null = null;
  private readonly opts: ControllerOptions;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
  }

  getSnapshot = (): PairingSnapshot => this.snapshot;

  /** Attach the <video> element the local preview should render into. */
  attachVideo(video: HTMLVideoElement | null): void {
    this.video = video;
    if (video && this.stream && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      video.muted = true;
      video.playsInline = true;
      void video.play().catch(() => undefined);
    }
  }

  private patch(patch: Partial<PairingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.opts.onSnapshot(this.snapshot);
  }

  /**
   * Redeem the token and open the signalling socket. Safe to call repeatedly:
   * it is a no-op once the socket exists or after the session ended.
   */
  async start(): Promise<void> {
    if (this.socket || this.starting) return this.starting ?? undefined;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (this.stopped) return;
    if (!this.opts.sessionId || !this.opts.token) {
      this.patch({ phase: 'error', message: 'This pairing link is incomplete. Generate a new QR code on the laptop.' });
      return;
    }
    this.patch({ phase: 'joining', message: 'Validating pairing token…' });

    let joined;
    try {
      joined = await joinSession(this.opts.sessionId, this.opts.token);
    } catch (err) {
      this.patch({ phase: 'error', message: describeJoinFailure(err) });
      return;
    }
    if (this.stopped) return;

    this.patch({
      ticketValidated: true,
      iceServers: joined.iceServers ?? [],
      message: 'Token accepted. Waiting for the laptop to negotiate…',
      phase: 'waiting',
    });

    const socket = new SignalSocket(
      signalSocketUrl(this.opts.sessionId, 'phone', joined.joinTicket),
      {
        onMessage: (msg) => void this.handleSignal(msg),
        onOpen: () => this.patch({ phase: this.snapshot.cameraLive ? 'waiting' : this.snapshot.phase }),
        onError: (message) => this.patch({ message: `${this.snapshot.message} (${message})` }),
        onClose: (code, reason) => {
          if (code === 4000 || code === 4001) {
            this.patch({
              phase: 'ended',
              message: `Session ended by the laptop (${reason || 'session closed'}).`,
            });
            this.teardown();
          }
        },
      }
    );
    this.socket = socket;
    socket.connect();
  }

  /** Request camera permission and publish the stream to the laptop. */
  async startCamera(mode: Facing = this.snapshot.facing): Promise<void> {
    if (this.stopped) return;
    this.patch({ phase: 'permission', facing: mode, message: 'Requesting camera permission…' });
    try {
      if (!window.isSecureContext) {
        throw new Error(
          'Camera access requires HTTPS. Re-open this link over https:// (the laptop can run `npm run dev:https`).'
        );
      }
      this.stream?.getTracks().forEach((t) => t.stop());

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: mode === 'environment' ? { ideal: 'environment' } : { ideal: 'user' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      if (this.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;

      const video = this.video;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => undefined);
        await observeVideoReady(video).catch(() => undefined);
      }
      const size = video?.videoWidth
        ? { width: video.videoWidth, height: video.videoHeight }
        : null;

      /*
       * Publish the camera track.
       *
       * Two cases, and the second one is the important one:
       *   - A sender already exists (user flipped cameras): replaceTrack, which
       *     needs no renegotiation.
       *   - No sender yet: the laptop's offer may already have been answered
       *     *before* permission was granted, so its m-line is receive-only with
       *     nothing to receive. Adding a track then requires a fresh offer from
       *     this side, otherwise no media ever flows and the connection dies of
       *     DTLS consent timeout.
       */
      const track = stream.getVideoTracks()[0];
      if (track) await this.publishTrack(track, stream);

      this.patch({
        cameraLive: true,
        previewSize: size,
        phase: this.pc?.connectionState === 'connected' ? 'streaming' : 'waiting',
        message: 'Camera ready — connecting to the laptop…',
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      this.patch({
        phase: 'error',
        cameraLive: false,
        message:
          name === 'NotAllowedError'
            ? 'Camera permission was denied on this phone. Allow camera access in the browser settings and reload this page.'
            : name === 'NotFoundError'
              ? 'No camera found on this device.'
              : err instanceof Error
                ? err.message
                : 'Could not start the camera.',
      });
    }
  }

  async switchFacing(): Promise<void> {
    const next: Facing = this.snapshot.facing === 'environment' ? 'user' : 'environment';
    this.patch({ facing: next });
    await this.startCamera(next);
  }

  /**
   * Publish the camera track exactly once.
   *
   * Two distinct situations:
   *  - A sender already exists (the user flipped cameras): `replaceTrack` keeps
   *    the same m-line, needs no renegotiation and never duplicates a track.
   *  - No sender yet: `addTrack` creates one and schedules negotiation, which
   *    `onnegotiationneeded` performs. We deliberately do NOT create an offer
   *    inline: if an offer/answer exchange is already in flight the signalling
   *    state is not `stable`, and a second offer there is "glare" — the remote
   *    answer would be applied to the wrong description and the peer connection
   *    wedges (or gets torn down).
   */
  private async publishTrack(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    this.localStream = stream;
    const pc = this.pc;
    if (!pc) return; // no offer yet — the track is attached when the offer arrives

    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) {
      if (sender.track === track) return; // already published, nothing to do
      await sender.replaceTrack(track);
      return;
    }
    pc.addTrack(track, stream);
    // `onnegotiationneeded` fires from here; `makeOffer` is the single place
    // that serialises offer creation.
    this.negotiationNeeded = true;
    await this.drainNegotiation();
  }

  /**
   * Create and send one offer, serialised.
   *
   * `negotiating` guards against concurrent runs; `negotiationNeeded` records
   * that another round is required once the current one settles (e.g. the track
   * was added while an exchange was still pending).
   */
  private async drainNegotiation(): Promise<void> {
    if (this.negotiating) return;
    const pc = this.pc;
    if (!pc) return;
    this.negotiating = true;
    try {
      while (this.negotiationNeeded) {
        this.negotiationNeeded = false;
        // Wait for a stable state: an offer or answer exchange may be in flight.
        if (pc.signalingState !== 'stable') return;
        if (!pc.getSenders().some((s) => s.track?.kind === 'video')) return;
        const offer = await pc.createOffer();
        // Re-check after the await: the state can change while createOffer runs.
        if (pc.signalingState !== 'stable') {
          this.negotiationNeeded = true;
          return;
        }
        await pc.setLocalDescription(offer);
        this.socket?.send({
          type: 'offer',
          sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
        } as unknown as SignalMessage);
        this.patch({ message: 'Publishing camera to the laptop…' });
        return; // wait for the answer before any further negotiation
      }
    } catch (err) {
      this.patch({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Could not publish the camera track.',
      });
    } finally {
      this.negotiating = false;
    }
  }

  private attachPeerHandlers(pc: RTCPeerConnection): void {
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket?.send({ type: 'ice', candidate: e.candidate.toJSON() } as unknown as SignalMessage);
      }
    };
    pc.onnegotiationneeded = () => {
      this.negotiationNeeded = true;
      void this.drainNegotiation();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.patch({ phase: 'streaming', message: 'Streaming to the laptop.' });
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.patch({
          phase: 'error',
          message:
            'The connection to the laptop dropped. If you are not on the same Wi-Fi, the server needs TURN configured.',
        });
      }
    };
  }

  private async handleSignal(msg: SignalMessage): Promise<void> {
    if (msg.type === 'offer') {
      try {
        let pc = this.pc;
        if (!pc) {
          pc = new RTCPeerConnection({
            iceServers: this.snapshot.iceServers.length
              ? this.snapshot.iceServers
              : [{ urls: 'stun:stun.l.google.com:19302' }],
          });
          this.pc = pc;
          this.remoteDescriptionSet = false;
          this.attachPeerHandlers(pc);
        }
        /*
         * Glare: we sent an offer and the laptop sent one at the same time.
         * The polite peer (the phone) rolls back and accepts the laptop's
         * offer instead of failing the session.
         */
        if (pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription({ type: 'rollback' });
          this.negotiationNeeded = false;
        }
        if (pc.signalingState !== 'stable') return;

        // Attach the camera track if the user has already granted permission.
        if (this.localStream && !pc.getSenders().some((s) => s.track?.kind === 'video')) {
          for (const track of this.localStream.getVideoTracks()) {
            pc.addTrack(track, this.localStream);
          }
        }

        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        this.remoteDescriptionSet = true;
        for (const c of this.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(c).catch(() => undefined);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket?.send({
          type: 'answer',
          sdp: pc.localDescription?.sdp ?? answer.sdp ?? '',
        } as unknown as SignalMessage);
        this.patch({ phase: 'waiting', message: 'Answer sent — establishing the video link…' });
      } catch (err) {
        this.patch({ phase: 'error', message: err instanceof Error ? err.message : 'Negotiation failed.' });
      }
      return;
    }

    if (msg.type === 'answer') {
      // Answer to our own re-offer (the one that carries the camera track).
      const pc = this.pc;
      if (!pc) return;
      if (pc.signalingState !== 'have-local-offer') return; // stale answer
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        this.remoteDescriptionSet = true;
        for (const c of this.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(c).catch(() => undefined);
        }
        this.patch({ message: 'Camera published — waiting for the laptop to render it…' });
      } catch (err) {
        this.patch({
          phase: 'error',
          message: err instanceof Error ? err.message : 'The laptop sent an invalid answer.',
        });
      }
      return;
    }

    if (msg.type === 'ice') {
      const pc = this.pc;
      if (!pc) return;
      if (!this.remoteDescriptionSet) this.pendingCandidates.push(msg.candidate);
      else await pc.addIceCandidate(msg.candidate).catch(() => undefined);
      return;
    }

    if (msg.type === 'bye' || msg.type === 'session_closed') {
      this.patch({ phase: 'ended', message: 'The laptop ended the camera session.' });
      this.teardown();
    }
  }

  /** Explicit user stop: release the camera and close every connection. */
  stop(): void {
    this.teardown();
    this.patch({ phase: 'ended', message: 'Camera stopped. You can close this page.', cameraLive: false });
  }

  private teardown(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.localStream = null;
    this.negotiating = false;
    this.negotiationNeeded = false;
    for (const sender of this.pc?.getSenders() ?? []) {
      try {
        this.pc?.removeTrack(sender);
      } catch {
        /* ignore */
      }
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.socket?.send({ type: 'bye' });
    this.socket?.close();
    this.socket = null;
    if (this.video) this.video.srcObject = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
  }

  /**
   * Final release. Called only when the page is really going away (pagehide),
   * never on a React unmount.
   */
  destroy(): void {
    this.stopped = true;
    this.teardown();
  }
}

function describeJoinFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Could not validate the pairing link.';
  if (message === 'unknown_session' || message === 'invalid_token') {
    return 'This pairing link is invalid or has already been used. Scan a fresh QR code from the laptop.';
  }
  if (message === 'pairing_expired') {
    return 'This pairing session expired. Scan a fresh QR code from the laptop.';
  }
  if (message === 'token_already_used') {
    return 'This pairing link was already used by another device. Generate a new QR code on the laptop.';
  }
  if (message.startsWith('Cannot reach')) {
    return `${message} — the phone must be able to reach the laptop/signalling server. Use the same Wi-Fi or configure a public host with TURN.`;
  }
  return message;
}

/**
 * One controller per pairing URL for the lifetime of the page. Remounting the
 * component (StrictMode, fast refresh) reuses it instead of opening a second
 * signalling socket.
 */
const controllers = new Map<string, PairingController>();

export function getPairingController(
  sessionId: string,
  token: string,
  onSnapshot: (snapshot: PairingSnapshot) => void
): PairingController {
  const key = `${sessionId}:${token}`;
  const existing = controllers.get(key);
  if (existing) return existing;
  const controller = new PairingController({ sessionId, token, onSnapshot });
  controllers.set(key, controller);
  window.addEventListener('pagehide', () => controller.destroy(), { once: true });
  return controller;
}
