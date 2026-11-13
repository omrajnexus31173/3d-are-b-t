# Browser-side discrepancy: root cause and evidence

Companion to `tools/dfine-audit/README.md` (which covers the artifact). This
document covers everything the browser does *after* the graph returns.

## The finding in one line

The model was never the problem. **The tracker retained stale boxes and the
overlay drew all of them**, so one object the detector reported once appeared as
a trail of up to 11 boxes.

The offline numbers are what make this provable: 11 / 13 / 12 detections at
threshold 0.50 means the graph is behaving. If the browser were drawing those
same boxes you would see about a dozen, once. "Excessive/overlapping" is a
different shape of wrong - too many boxes, and boxes that are slightly stale
copies of each other.

---

## Verification status: what is proven and what is not

Read this first. The distinction matters more than the fix.

| # | Requirement | Status | Basis |
|---|---|---|---|
| 1 | Run the real ONNX in a **browser** on the three PNGs | **NOT DONE** | See "Why the browser run is impossible here" |
| 2 | Capture the six stage counts from the live app | **INSTRUMENTED, NOT CAPTURED** | The line is built and unit/ORT-tested; no run produced numbers |
| 3 | Compare browser counts to 11 / 13 / 12 | **NOT DONE** | Depends on 1 and 2 |
| 4 | Explain any stage mismatch | **NOT APPLICABLE** | No browser counts to compare |
| 5 | Moving live-camera subject, stale boxes gone, ids stable | **SIMULATED ONLY** | Tracker-level, deterministic; no live camera here |
| 6 | YOLO11n unchanged | **PROVEN at code level** | Diff + 5 contract tests; no live YOLO run |
| 7 | Updated with actual browser evidence | **THIS DOCUMENT** | Explicitly reports 1-3 as unverified |

**Nothing in this document is a browser measurement.** Where a number appears, its
source is named.

### Why the browser run is impossible here

Three independent blockers, each checked:

1. **No model bytes.** `npm run setup:models -- --only=dfine` →
   `download failed (fetch failed)`. `release-assets.githubusercontent.com`,
   `objects.githubusercontent.com` and `raw.githubusercontent.com` all return
   `000` from this sandbox. The only `.onnx` present is the 8.7 kB contract
   fixture. Without the artifact there is no real inference to observe.
2. **No browser binary.** `npx playwright install chromium` fails on download;
   no `google-chrome`, `chromium` or `firefox` on PATH. So even with the model,
   the app cannot be driven here.
3. **No still-image source in the app at all.** `CameraSourceKind` is
   `'webcam' | 'usb_uvc' | 'mobile_webrtc'` (`src/vision/types.ts:12`) - there is
   no image/file source. "Run the three PNGs through the browser pipeline" is not
   something the current product can do even on a working machine; it needs a
   test harness that feeds a `HTMLImageElement` into `grabLetterboxedFrame`
   instead of a `HTMLVideoElement`. See "How to close items 1-3".

The ORT runtime itself *was* installed successfully (34.3 MB into
`public/vendor/ort/`), so that part of the deployment is not the blocker.

---

## Requirement-by-requirement

### 1. Which detector actually loads

`DetectionEngine.loadModel()` (`src/vision/detectionEngine.ts:228`) only tries
D-FINE when `preferredDetector === 'dfine-n'`; otherwise straight to YOLO11n. The
preference defaults to `'yolo11n'` (line 100) and **is not persisted**
(`src/camera/useCameraSystem.ts:173` - plain `useState`, no `localStorage`), so a
reload silently reverts.

"How do I know which one is loaded?" is answerable without guessing:
`modelStatus.name` and `executionProvider` are shown in the model panel, and the
stage line now prints `model=` and `provider=` explicitly.

### 2. Raw detections immediately after inference

Enable with either:

```js
localStorage.bharatDetectionDebug = '1'   // then reload
```

or `VITE_DETECTION_DEBUG=1`.

Two lines now appear. The worker's (per frame, from inside the worker):

```
[bharat-av][dfine] raw=300 kept=11 dropped(thr<=0.5:289 ... inPadding:2)
  score=0.00..0.97 keptScore=0.52..0.97 frame=640x480
  shapes=labels[1,300] boxes[1,300,4] scores[1,300] top=person@0.91(...) ...
```

and the engine's, covering all five stages in pipeline order:

```
[bharat-av][stages] detector=dfine model=D-FINE-N (COCO) provider=wasm thr=0.5
  raw=300 -> afterThreshold=11 -> afterPadding=11 -> tracked=13 -> rendered=11
```

This directly answers the six numbers requested:

| Requested | Field |
|---|---|
| selected detector and loaded model | `detector=` and `model=`/`provider=` |
| raw detection count | `raw=` |
| count after confidence filtering | `afterThreshold=` |
| count after padding filtering and unletterboxing | `afterPadding=` |
| tracker matched count | `tracked=` (all retained) |
| rendered track count | `rendered=` (what the overlay maps over) |

`tracked > rendered` is normal after the fix and is exactly the stale set that is
no longer painted.

### 3. Coordinate trace

Verified with a test that runs it (`realOnnx.test.ts`, "pipeline: decoder ->
worker filters -> tracker -> overlay input"):

```
graph: absolute canvas px (confirmed by the offline audit: ~0-640)
  -> decodeDFineWithStats       keeps absolute xyxy
  -> filterToContentRegion      drops letterbox-filler boxes
  -> unletterboxBox             (x - padX) / scale, clamped to the frame
  -> tracker.update             boxes pass through unchanged
  -> DetectionOverlay           left/top/width/height as % of frameWidth/frameHeight
```

Geometry is exact: canvas `(100,120) 120x180` on a 640x480 frame with `padY 80`,
`scale 1` lands at `(100,40) 120x180` in frame space. The overlay then scales by
percentage, so CSS size and `object-fit: contain` are handled without distortion.
No mirroring (`scaleX`) anywhere.

### 4. Stale tracks - **the defect**

`IouTracker.update()` aged unmatched tracks and deleted them only after
`maxMissed` frames, then returned **every live track**, including ones missed in
the frame just processed. `DetectionOverlay` draws whatever it is given and has no
freshness check. The engine configures `maxTracks: 40` and leaves `maxMissed` at
its default **10** (`detectionEngine.ts:79`).

At 0.8 FPS, 10 retained frames is **12.5 seconds**. A walking person crosses a
640 px frame faster than that, so IoU association fails between frames 1.25 s
apart, every frame spawns a fresh track, and the previous ten are still drawn.

Measured with the production tracker configuration (`staleTracks.test.ts`,
[tracker-level, not a browser measurement]):

| Scenario | Before | After |
|---|---|---|
| One person, boxes rendered per frame | `1,2,3,4,5,6,7,8,9,10,11,11` (peak **11**) | `1,1,1,1,1,1,1,1,1,1,1,1` (peak **1**) |
| 12-object scene, peak rendered | 12 | 12 |

The second row is the control: when association works, the fix changes nothing.

**Identity preservation** (what item 5 actually asks for) is covered separately:
one subject that associates frame to frame keeps a single `trackId` for 15 frames;
a one-frame detection gap does not change the id; three objects keep three stable
ids across frames; a new object never reuses a live id.

### 5. Drawn twice?

**No.** One render site (`CameraPanel.tsx:256`). `StrictMode` is on
(`main.tsx:16`) but it only double-invokes render/reducer - it cannot duplicate
committed output - and there is no second drawing path for camera detections.
The "duplication" was the ghost trail, which looks like duplication because
consecutive boxes overlap heavily.

### 6. Browser vs offline inference on the same images

**Not done** (blockers above). What exists instead, and its limit:

- `realOnnx.test.ts` and `stageCounts.test.ts` run a **real ORT session** through
  the identical decode -> padding filter -> unletterbox -> tracker chain and
  assert stage counts at each step (300 raw -> 2 kept -> 2 after padding -> 2
  tracked -> 2 rendered; 2 on a repeat frame; 0 rendered when the frame is empty).
- The graph in those tests is the contract fixture, **not** the 15 MB artifact, so
  this validates the *pipeline and its accounting*, never D-FINE's accuracy or its
  per-image counts.

### 7. Root cause - see (4). No thresholds changed, nothing hidden.

### 8. `Unclassified` - mapping, not decoding

The offline audit proves labels are correct: 0..79, absolute boxes, plausible
person/car/bus/traffic-light classes. `COCO_LABELS` matches the official order
element for element.

`mapLabelToVisionClass()` maps **17 of 80** classes. The other **63** - `chair`,
`laptop`, `train`, `airplane`, `backpack`, `bench`, `handbag`, `bottle`, `couch`,
`bed`, ... - fall to `default: 'unknown'`, displayed as `Unclassified`.

It is **unsupported COCO class mapping**, definitively not incorrect label
decoding. Deliberately not renamed: a `chair` shown as `Unclassified` is telling
the truth. A proper fix is a product policy decision (suppress non-traffic
classes, or give them their own category), so it is left open.

Interaction with (4): because 63 classes collapse to one `unknown` id, boxes of
*different* COCO classes may associate with each other (`tracker.ts:114` skips the
class check when either side is `unknown`). Deliberate - it keeps ids stable
across classifier flicker - but two adjacent non-traffic objects can merge.

---

## The fix

`src/vision/tracker.ts`, one behavioural change plus one new option:

```ts
update(detections, timestampMs): Track[]     // now returns getRenderableTracks()
getRenderableTracks(): Track[]               // matched within maxMissedRendered
getStale(): Track[]                          // retained, not drawn
```

`maxMissedRendered` defaults to **1**. `maxMissed: 10` is unchanged, so identity
retention is untouched and ids survive brief gaps exactly as before.

*Retention* answers "is this the same object as before?" and should be generous.
*Rendering* answers "does the detector currently see something here?" and should
be strict. A box drawn where the detector sees nothing is simply in the wrong
place.

`getTracks()` still returns the full retained set, so `lastTracks` and the hybrid
adapter are unaffected.

---

## How to close items 1-3

The blocker is the input type, not the detector. A minimal addition makes the app
capable of running stills - which it cannot do today:

1. Add a `'file'` member to `CameraSourceKind` and a source that yields a
   `HTMLImageElement`/`ImageBitmap`.
2. Generalise `grabLetterboxedFrame` (`detectionEngine.ts:440`) from
   `HTMLVideoElement` to a `CanvasImageSource`, deriving `width`/`height` from
   `naturalWidth`/`naturalHeight` for images.
3. Point `sourceKind` at the new member so a still is never reported as a webcam
   frame (the type is explicitly documented as "never conflated with simulated
   sensors" - a still is a third thing, and should say so).

That is a feature addition, so it is deliberately **not** part of this fix. With it
in place, the comparison becomes:

```js
// thr 0.50, one image at a time, then read the stage line:
//   afterThreshold must equal the offline audit count (11 / 13 / 12)
//   afterPadding   may be lower - those boxes were in the letterbox filler
//   rendered       must equal afterPadding (post-fix invariant)
```

If `afterThreshold` disagrees with the audit, the stage that disagrees names the
fault: a mismatch there means preprocessing differs (resize kernel, EXIF
orientation, or colour conversion), not the decoder.

## Tests added

| File | Covers |
|---|---|
| `staleTracks.test.ts` | ghost trail before/after, rendered never exceeds detections present, retention still capped, **identity preserved across gaps**, engine consumes `update()` directly |
| `classCoverage.test.ts` | 80-class order, 17 mapped / 63 unmapped, `Unclassified` is the mapping result |
| `stageCounts.test.ts` | stage-line format verbatim, `tracked > rendered` visibility, real-ORT stage accounting end to end |
| `yoloUnchanged.test.ts` | YOLO decode contract, threshold behaviour, NMS per class, one box per object through the tracker |
| `realOnnx.test.ts` | real ORT session through decode -> filter -> unletterbox -> tracker |
| `tracker.test.ts` | association still refuses cross-class matches (via `getTracks()`), rendering asserted separately |

## Verification

```
typecheck                     clean
vitest                        178 passed, 1 failed
vite build                    success
```

The failure is `src/simulation/__tests__/endlessDrive.test.ts > drives a long haul
without a teleport or a gap in the window`. **It fails identically on the base
commit with these changes stashed** - pre-existing, unrelated to the tracker, and
left alone rather than smuggling an unrelated change into this fix.

## Not claimed

- Any browser measurement. Items 1-3 remain **unverified**.
- That the ghost trail was the only remaining visual oddity: with 63 classes mapped
  to `Unclassified`, non-traffic objects will still appear, still labelled that way.
