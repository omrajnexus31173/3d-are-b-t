# MediaPipe object detector backend

Status: **implemented and unit-tested; real-camera validation NOT performed.**

This backend is not the completion of the camera task. It is a working,
type-checked, test-covered implementation whose real-model behaviour on a live
camera is unverified, because the model asset could not be fetched in the
environment where it was written. Read the verification table before trusting it.

---

## Verification status

| # | Requirement | Status | Basis |
|---|---|---|---|
| 1 | `@mediapipe/tasks-vision` package used | **DONE** | `^1.2.3`, in `dependencies` |
| 2 | EfficientDet-Lite0 + compatible asset | **DONE (code)** | model def + installer; **asset not downloadable here** |
| 3 | Reuse webcam + mobile WebRTC streams | **DONE** | both sources already expose `video: HTMLVideoElement`; MediaPipe consumes it directly |
| 4 | Keep existing preview + box UI | **DONE** | `DetectionOverlay` untouched; same `DetectionFrame` contract |
| 5 | Convert results to BHARAT-AV format | **DONE** | `toMediaPipeRawDetections`, 21 unit tests |
| 6 | Simulation / planner / telemetry / pairing unchanged | **DONE** | zero files touched under `src/simulation/` |
| 7 | No Python / Docker / inference server / extra deps | **DONE** | one npm dependency; no server |
| 8 | Graceful camera / model / device errors | **DONE** | typed errors + YOLO fallback, tested |
| 9 | No overlapping frames | **DONE** | single in-flight tick; branch returns before worker path |
| 10 | YOLO11n + D-FINE remain available | **DONE** | both still selectable; YOLO11n still default |
| — | **Webcam detection on a real camera** | **NOT DONE** | no `.tflite` asset, no browser binary |
| — | **Mobile WebRTC detection** | **NOT DONE** | as above, and no phone |
| — | **Person / multi-person / moving / empty scene** | **PARTIAL** | conversion + tracking verified synthetically; not on real imagery |
| — | **Bounding-box accuracy** | **NOT VERIFIED** | needs real inference |
| — | **Inference speed** | **NOT MEASURED** | needs real inference |
| — | **Console errors in a real browser** | **NOT OBSERVED** | no browser |

**Nothing below claims a real-camera result.** Where a number appears, its source
is labelled.

### Why real inference could not be run here

1. **The `.tflite` asset is unreachable.** `storage.googleapis.com` returns `000`
   from this sandbox. `npm run setup:models -- --only=mediapipe` copies the WASM
   runtime successfully (28.6 MB, 4 files) and then reports
   `EfficientDet-Lite0 download failed (fetch failed)`.
2. **No browser binary.** No `chrome`/`chromium`/`firefox`; playwright download
   fails. Confirmed by trying.
3. **MediaPipe requires a real DOM.** `ObjectDetector.createFromOptions` in Node
   fails with `document is not defined` — it is not usable in the `node` vitest
   environment, so no test here can run the actual model.

The WASM runtime *is* locally available and resolvable
(`FilesetResolver.forVisionTasks('./public/vendor/mediapipe')` returns valid
`wasmLoaderPath`/`wasmBinaryPath`), so the only missing piece on a working machine
is the model file.

---

## Design

MediaPipe was chosen because it removes the failure mode that took two rounds to
find in the D-FINE path: **it does its own preprocessing**. It takes the
`HTMLVideoElement` directly, resizes and normalises internally, and returns boxes
in the source frame's pixel space. There is no letterbox to build, none to invert,
and no query decode to get wrong.

```
webcam / WebRTC  ->  FrameSource.video  ->  MediaPipe detectForVideo
   -> toMediaPipeRawDetections (already frame pixels)
   -> DetectionEngine.buildFrame  (tracker, class map, risk, distance)
   -> DetectionOverlay
```

`buildFrame` is shared with the worker path, so tracking, class mapping, risk
assessment, the stage diagnostic and the overlay are identical for all three
backends. That also means the stale-track fix from the previous round applies
here for free.

### Why it runs on the main thread

MediaPipe needs a DOM and its own WASM instance; it already parallelises
internally. Moving it into the existing worker would mean a second wasm runtime
and a new message contract for no measurable gain. The heavy ONNX paths stay in
the worker, untouched.

### Frame discipline (requirement 9)

`tickMediaPipe` is synchronous, and the frame loop returns immediately after it,
before the worker `postMessage` block. So exactly one inference is ever in flight,
and a slow frame delays the next tick through `scheduleNext()` rather than
stacking. A zero-size video (`videoWidth === 0` between `getUserMedia` resolving
and the first frame decoding) is guarded, because `detectForVideo` throws on it.

### Timestamps

`detectForVideo` throws if the timestamp does not strictly advance. `Date.now()`
can repeat within a millisecond at 8 Hz and can jump backwards on a clock
correction, so `MediaPipeFrameRunner` enforces monotonicity. Tested for the stall
case, the backwards case and the normal case.

### Error handling (requirement 8)

| Failure | Behaviour |
|---|---|
| Package import fails | `MediaPipeUnavailableError`, falls back to YOLO11n |
| WASM runtime missing | error names `npm run setup:models -- --only=mediapipe` |
| Model missing/invalid | tries GPU, then CPU, then falls back with the reason |
| No WebGL2 / headless | GPU attempt fails, CPU retried automatically |
| A frame throws | reported **once**, loop continues, camera stays live |
| Device without camera | handled by the existing `FrameSource` layer, unchanged |

`getMediaPipeError()` exposes the last failure so the panel can explain the
fallback instead of silently reverting.

---

## What is actually tested

`src/vision/__tests__/mediapipe.test.ts` (21 tests):
box passthrough with no letterbox maths; strongest-first ordering; highest
category wins; drops for missing box, degenerate/NaN box, out-of-range class;
empty and missing-`detections` results; custom label table; timestamp monotonicity
(stall, backwards, normal); idempotent `close()`; a `close()` that throws;
`MediaPipeUnavailableError` on a missing runtime with an actionable message;
`MEDIAPIPE_MODEL` registered but not default, COCO-80 table shared with the other
detectors.

`src/vision/__tests__/mediapipeEngine.test.ts` (18 tests):
YOLO11n still the default; `mediapipe` selectable; confidence floor applied;
`isMediaPipeActive()` false before load; loading without an asset resolves rather
than throwing and records the reason; fallback leaves a coherent status;
switching away releases MediaPipe; `dispose()` safe; MediaPipe output becomes a
`DetectionFrame` with the box **unchanged** and `person -> pedestrian`; a throwing
detector reports once and does not kill the loop; a repeated detection keeps one
`trackId` across three frames; an empty frame yields zero detections rather than
stale ones; the MediaPipe branch returns before the worker path; the 0×0 guard.

## Verification

```
typecheck    clean
vitest       217 passed, 1 failed (218)
vite build   success  (bundle 1,144 kB -> 1,308 kB, +164 kB for MediaPipe)
```

The single failure is `src/simulation/__tests__/endlessDrive.test.ts > drives a
long haul without a teleport or a gap in the window`. **It fails identically on
the base commit with these changes stashed** — pre-existing, unrelated; the PR
touches zero files under `src/simulation/`.

## How to complete the real-camera tests

```bash
npm install
npm run setup:models -- --only=mediapipe   # needs storage.googleapis.com
npm run dev
```

Then in the panel: pick **MediaPipe EfficientDet-Lite0**, press **Start**, and:

1. **One person** — one box, tight to the body, label `pedestrian`.
2. **Multiple people** — N boxes for N people, no duplicates.
3. **Moving person** — box follows; one `trackId` sustained; no ghost trail.
4. **Empty scene** — zero boxes within a second (no stale residue).
5. **Mobile WebRTC** — pair a phone, confirm boxes on the remote stream.
6. **Speed** — note the `inferenceFps` figure; enable
   `localStorage.bharatDetectionDebug = '1'` for the `[bharat-av][stages]` line.
7. **Console** — expect no errors; a GPU-less device logs one CPU-fallback line
   from MediaPipe, which is informational.

If boxes are offset or scaled wrongly, that is a real finding: MediaPipe reports
frame pixels, so an offset would mean `videoWidth`/`videoHeight` differs from the
size MediaPipe saw, which is worth reporting with both numbers.

## Assets

Not committed (`.gitignore`: `public/models/`, `public/vendor/`).

| Asset | Source | Install |
|---|---|---|
| `efficientdet_lite0.tflite` (~4.5 MB) | Google MediaPipe model CDN | `npm run setup:models -- --only=mediapipe` |
| `vision_wasm_*.{js,wasm}` (28.6 MB) | `@mediapipe/tasks-vision` npm package | same command |

Both are official Google distributions; no third-party mirrors.
