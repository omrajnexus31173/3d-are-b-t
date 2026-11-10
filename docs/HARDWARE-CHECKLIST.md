# BHARAT-AV — Physical Device Testing Checklist

Everything in this file requires real hardware. As of the Phase 3.5 audit, **none
of it has been executed**: the development environment has no GPU (`/dev/dri`
absent), no LAN interface, and outbound STUN/UDP is blocked. Automated
browser-context tests are recorded in the phase reports; they are not a
substitute for the checks below.

Record actual numbers. Do not copy the automated figures.

---

## 0. Prerequisites (all scenarios)

- [ ] Chrome or Edge ≥ 120, or Firefox ≥ 121, or Safari ≥ 17
- [ ] App served over **HTTPS** or `http://localhost` — `getUserMedia` refuses
      otherwise (`npm run dev:https`)
- [ ] Signalling server running: `npm run signal`
- [ ] Note the laptop model, OS version, browser version, and whether a discrete
      GPU is present

---

## 1. USB webcam (UVC)

- [ ] Plug in a UVC webcam (any Logitech/Brio/cheap no-name is fine)
- [ ] Live Camera → **Refresh camera list** → the device appears with its real
      name, not "Camera 1"
- [ ] Confirm the `[USB]` prefix matches the hardware actually plugged in. If it
      does not, note it — the label is inferred from the device string only
- [ ] Open the **Resolution** menu. Record which modes appear:
      `reported` modes come from `getCapabilities()`; `(unverified)` ones are
      presets the device may refuse
- [ ] Select the highest reported mode → **Connect camera** → confirm the feed
      label shows the size the track actually reports
- [ ] **Load detection model** → note the `runtime` line (`tfjs:webgl` vs
      `tfjs:cpu`)
- [ ] **Start detection** → record Capture FPS, Infer FPS, Latency, Avg lat, p95
- [ ] Confirm boxes render on the USB feed and IDs are `CAM-`
- [ ] Telemetry tab: confirm `SIM n · CAM m` split and that sim rows stay `TRK-`
- [ ] **Unplug the webcam while detecting** → expect a stopped/error status and
      no frozen "detections"; replug and confirm recovery
- [ ] Switch to a *second* USB camera if available; confirm only one capture
      device holds the camera at a time (no duplicate `<video>` elements)

**Record:** resolution, runtime line, infer FPS, latency, p95, detection count.

---

## 2. Android phone over QR + WebRTC

- [ ] Laptop and phone on the **same Wi-Fi**, laptop not on a VPN
- [ ] Live Camera → **Generate pairing QR**
- [ ] Note the QR host. It must be the laptop's **LAN IP**, never `localhost` or
      `169.254.*`. If it is wrong, record what it showed
- [ ] Scan with the phone → the pairing page opens over **https://**
      (plain http will block the camera)
- [ ] Token is validated once; pressing refresh on the phone must report
      "already used", not silently reconnect
- [ ] Press **Start camera**, grant permission, confirm the phone preview appears
- [ ] Flip **Rear → Front → Rear**; confirm the laptop keeps receiving video and
      the track count does not grow
- [ ] On the laptop: `PHONE FEED` appears, `peer: connected`
- [ ] Start detection → confirm `CAM-` boxes on the phone feed and hybrid split
- [ ] **Stop & disconnect** on the phone → laptop must stop scoring within a few
      seconds, not keep scoring a frozen frame
- [ ] Reconnect with a **fresh QR** → detection resumes
- [ ] Lock the phone screen mid-stream → expect a clean stop, then recovery

**Record:** QR host, ICE candidates chosen (host/srflx), connect time to first
frame, infer FPS, and whether any TURN traffic was needed.

---

## 3. Local Wi-Fi specifics

- [ ] Confirm both devices are on the same subnet (`192.168.x.*`)
- [ ] If the QR link fails to load at all, check the laptop firewall allows
      inbound 5173 (app) and 8787 (signalling)
- [ ] Test with the laptop on Wi-Fi **and** on Ethernet — both should work
- [ ] Try with client isolation enabled on the router (guest networks commonly
      block peer-to-peer). Record the failure mode: it should be an ICE failure
      with a clear message, not a silent hang

---

## 4. Remote / internet connection (TURN required)

This configuration is **not verified by any test yet** and is expected to fail
without TURN.

- [ ] Put the phone on **mobile data** (Wi-Fi off)
- [ ] Without TURN: confirm the failure is reported as an ICE/peer failure with
      the TURN hint in the UI — not a frozen "connecting"
- [ ] Provision a TURN server (coturn / a hosted provider) and start it with
      `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`
- [ ] The app must be reachable over a public HTTPS URL (reverse proxy or tunnel)
- [ ] Re-run the pairing flow over mobile data
- [ ] Confirm relay candidates are actually used and video connects
- [ ] Measure end-to-end latency on mobile data and compare with LAN
- [ ] Confirm **no token or TURN credential appears in the browser console,
      network log URLs, or server logs**

**Record:** TURN provider, relay used y/n, connect time, latency delta vs LAN.

---

## 5. Performance expectations to validate

The audit measured ~8–9.7 s per inference for NanoDet-m at 416×416 **on a
SwiftShader software renderer with no GPU at all**. A machine with a real GPU
should be substantially faster, but that has not been measured here.

- [ ] Note whether the runtime line shows `tfjs:webgl` or `tfjs:cpu`
- [ ] If it shows `cpu`, record the reason — the warm-up probe rejected WebGL
- [ ] Record avg and p95 latency and compare against the software-renderer figure
- [ ] If p95 > 1000 ms, detection is not real-time; state that plainly in any demo

## 6. Things that must NOT be claimed from these tests

- That a phone connected over USB will appear as a camera — only if the OS
  exposes it (Android USB webcam mode / iPhone Continuity Camera)
- That every USB-C device is a supported UVC camera
- That internet pairing works without a configured TURN server
- Any FPS number copied from the automated runs — measure on the real machine
