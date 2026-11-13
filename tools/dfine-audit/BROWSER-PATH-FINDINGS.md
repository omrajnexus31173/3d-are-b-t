# Browser-side discrepancy: root cause and evidence

Companion to `tools/dfine-audit/README.md`. That document covers the artifact;
this one covers everything the browser does *after* the graph returns.

## The finding in one line

The model was never the problem. **The tracker retained stale boxes and the
overlay drew all of them**, so one object the detector reported once appeared as
a trail of up to 11 boxes.

The offline numbers you measured are consistent with this and are the reason it
is provable: 11 / 13 / 12 detections at threshold 0.50 means the graph is
behaving. If the browser were drawing those same boxes you would see about a
dozen, once. You saw "excessive/overlapping", which is a different shape of
wrong - too many boxes *and* boxes that are slightly stale versions of each
other.

---

## Requirement-by-requirement

### 1. Which detector actually loads

`DetectionEngine.loadModel()` (`src/vision/detectionEngine.ts:228`) only tries
D-FINE when `preferredDetector === 'dfine-n'`; otherwise it goes straight to
YOLO11n. The preference is `'yolo11n'` by default (line 100) and **is not
persisted** (`src/camera/useCameraSystem.ts:173` - plain `useState`, no
`localStorage`). A reload silently reverts to YOLO11n.

So "am I looking at D-FINE?" has a reliable answer: the model-status panel shows
`modelStatus.name` and `executionProvider`, and `buildFrame` attaches
`modelId: null` unless the model state is `ready` (line 754). **If the panel says
YOLO11n, you are looking at YOLO11n.** Not persisting a deliberate choice is a
usability wart, not the cause of this defect, so I left it alone.

### 2. Raw detections immediately after inference

Already instrumented, needs no code change. The worker reports a compact line
via `reportDiagnostic()`; enable it with either:

```js
localStorage.bharatDetectionDebug = '1'   // then reload
```

or `VITE_DETECTION_DEBUG=1`. The line carries `raw`, `kept`, `belowThreshold`,
`degenerate`, `badClass` and now `inPadding`. **`kept` is the number the overlay
should receive for that frame.** If the overlay shows more than `kept`, the fault
is downstream of the worker - which is exactly what this was.

### 3. Coordinate trace

Verified end to end, with a test that runs it (`realOnnx.test.ts`,
"pipeline: decoder -> worker filters -> tracker -> overlay input"):

```
graph: absolute canvas px (confirmed by your audit: ~0-640)
  -> decodeDFineWithStats       keeps absolute xyxy
  -> filterToContentRegion      drops letterbox-filler boxes
  -> unletterboxBox             (x - padX) / scale, clamped to the frame
  -> tracker.update             boxes pass through unchanged
  -> DetectionOverlay           left/top/width/height as % of frameWidth/frameHeight
```

Geometry is exact: a canvas box `(100,120) 120x180` on a 640x480 frame with
`padY 80`, `scale 1` lands at `(100,40) 120x180` in frame space. The overlay then
scales by percentage, so CSS size and `object-fit: contain` are handled without
distortion. No mirroring (`scaleX`) anywhere, so boxes and picture share a
coordinate direction.

### 4. Stale tracks - **the defect**

`IouTracker.update()` (`src/vision/tracker.ts`) ages unmatched tracks and only
deletes them after `maxMissed` frames. It then returned **every live track**,
including ones missed in the frame just processed. `DetectionOverlay` draws
whatever it is given, with no freshness check of its own.

The engine configures `maxTracks: 40` and leaves `maxMissed` at its default of
**10** (`detectionEngine.ts:79`).

At the 0.8 FPS you measured, 10 retained frames is **12.5 seconds**. A walking
person crosses a 640 px frame faster than that, so IoU association fails between
consecutive frames 1.25 s apart, each frame spawns a fresh track, and the
previous ten are still being drawn.

Measured with the production tracker configuration:

| Scenario | Before | After |
|---|---|---|
| One person, rendered boxes per frame | `1,2,3,4,5,6,7,8,9,10,11,11` (peak **11**) | `1,1,1,1,1,1,1,1,1,1,1,1` (peak **1**) |
| 12-object scene, peak rendered | 12 | 12 |

The second row is the control: when association works, the fix changes nothing.
It only removes boxes that were never in the frame.

### 5. Drawn twice?

**No.** `DetectionOverlay` has exactly one render site
(`CameraPanel.tsx:256`), `main.tsx` has `StrictMode` on but that only
double-invokes render/reducer, never duplicates committed output, and there is no
second drawing path for camera detections anywhere in the canvas code. The
"double" appearance is the ghost trail from (4), which looks like duplication
because consecutive boxes overlap heavily.

### 6. Browser vs offline inference on the same images

Partially addressed. The committed test runs a **real ORT session** through the
identical decode -> filter -> unletterbox -> tracker chain and asserts the
overlay receives exactly the decoder's detections (2 in, 2 rendered, 2 on a
repeat frame, 0 when nothing is detected). What it cannot do is run the 15 MB
D-FINE artifact, which is absent here - so end-to-end browser-vs-offline numeric
equality on the three photographs remains **unverified, not claimed**.

How to close it: run the in-app comparison with the diagnostic line enabled and
check `kept` against the audit's 11 / 13 / 12 at 0.50. With this fix, the number
of boxes drawn must equal `kept`.

### 7. Root cause - see (4). No thresholds changed, nothing hidden.

### 8. `Unclassified` - mapping, not decoding

Your audit proves the labels are correct: 0..79, absolute boxes, plausible
person/car/bus/traffic-light classes. `COCO_LABELS` matches the official order
element for element.

`mapLabelToVisionClass()` maps **17 of 80** classes. The other **63** - `chair`,
`laptop`, `train`, `airplane`, `backpack`, `bench`, `handbag`, `bottle`, `couch`,
`bed`, etc. - fall to `default: 'unknown'`, displayed as `Unclassified`.

So it is **unsupported COCO class mapping**, definitively not incorrect label
decoding. Deliberately not renamed: a `chair` shown as `Unclassified` is telling
the truth. Fixing it properly means deciding a product policy (suppress
non-traffic classes, or give them their own category) - a taxonomy decision, not
a bug fix, so it is out of scope here and left for your call.

Note this also interacts with (4): because 63 classes collapse to one `unknown`
class id, boxes of *different* COCO classes are allowed to associate with each
other (`tracker.ts:114` skips the class check when either side is `unknown`).
That is deliberate - it keeps ids stable across classifier flicker - but it means
two adjacent non-traffic objects can merge into one track.

---

## The fix

`src/vision/tracker.ts`, one behavioural change plus one new option:

```ts
update(detections, timestampMs): Track[]     // now returns getRenderableTracks()
getRenderableTracks(): Track[]               // matched within maxMissedRendered
getStale(): Track[]                          // retained, not drawn
```

`maxMissedRendered` defaults to **1** - draw only what the detector saw in the
latest frame. `maxMissed: 10` is unchanged, so **identity retention is
untouched**: tracks keep their ids across brief detection gaps exactly as before.

The separation matters:

- *Retention* answers "is this the same object as before?" and should be
  generous.
- *Rendering* answers "does the detector currently see something here?" and
  should be strict. A box drawn where the detector sees nothing is simply in the
  wrong place.

`getTracks()` still returns the full retained set, so any caller that wants
identity (the hybrid adapter, `lastTracks`) is unaffected.

## Tests added

| File | Covers |
|---|---|
| `src/vision/__tests__/staleTracks.test.ts` | ghost trail (before/after), rendering never exceeds detections present, retention still capped, stale reported separately, engine consumes `update()` directly |
| `src/vision/__tests__/classCoverage.test.ts` | 80-class order, 17 mapped / 63 unmapped, `Unclassified` is the mapping result not a rename |
| `src/vision/__tests__/realOnnx.test.ts` | real ORT session through the whole chain: 2 decoded -> 2 rendered -> 2 on repeat -> 0 when empty |
| `src/vision/__tests__/tracker.test.ts` | updated: association still refuses cross-class matches (asserts `getTracks()` length 2, rendered length 1) |

## Verification

```
typecheck                     clean
vitest                        162 passed, 1 failed
vite build                    success
```

The single failure is `src/simulation/__tests__/endlessDrive.test.ts >
drives a long haul without a teleport or a gap in the window`. **It fails
identically on the base commit with my changes stashed** - it is pre-existing and
unrelated to the tracker. I left it alone rather than making an unrelated change
inside this fix.

## Not claimed

- Browser-vs-offline numeric equality on the three audit photographs (needs the
  15 MB artifact in a browser).
- That the ghost trail was the *only* remaining visual oddity: with 63 classes
  mapped to `Unclassified`, non-traffic objects will still show up and still be
  labelled that way, by design.
