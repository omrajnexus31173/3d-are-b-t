# D-FINE-N real-model audit — findings and evidence

Status: **partially complete.** The artifact itself could not be downloaded in the
auditing environment, so the single most important check (run the released model
on real photos and look at its numbers) is still open. Everything that *could* be
verified against authoritative sources was verified, and three real defects were
found and fixed. This document states exactly which is which.

Do not read the "fixed" items below as an explanation of the production symptom
until the open item is closed.

---

## Blocked: the artifact

Every route to the released bytes fails in this environment:

| Route | Result |
| --- | --- |
| `curl` release download URL | `302` then `SSL_ERROR_SYSCALL` at `release-assets.githubusercontent.com:443` |
| `gh release download dfine-n-v1` | `EOF` on the same host |
| `api.github.com/.../releases/assets/742876599` + `Accept: application/octet-stream` | `302` to the same blocked host, 0 bytes |
| Hugging Face mirror | `000` (not reachable) |
| Official `.pth` → local export | `.pth` is on the same blocked host |

Reachable hosts are `github.com`, `api.github.com`, `codeload.github.com` and
pypi, so the model's bytes are not obtainable here by any route. Torch *is*
installable, so a local export is possible **once someone supplies the `.pth`**.

What could still be obtained — GitHub's own digest of the uploaded asset:

```
asset id    : 742876599
name        : dfine_n_coco.onnx
size        : 15,491,160 bytes
digest      : sha256:1dbf71cbccc0fd6baaa36cc91521062fa8356eab7e44af6f39a98b157695f7ab
uploaded    : 2026-11-13T08:25:32Z
downloads   : 8
```

Two things follow. First, the published reference hash exists and is now recorded
in `tools/dfine-audit/audit.mjs`, so any download can be checked against
`1dbf71cb…`. Second, **there is no published export report in the repository or
the release notes** — the release body is two lines of prose. The "verify against
the published export report" step therefore had nothing to compare against; the
GitHub asset digest is the only authoritative hash that exists.

### What the audit harness does with it

```bash
node tools/dfine-audit/audit.mjs \
  --model public/models/dfine_n_coco.onnx \
  --image tools/dfine-audit/images/street_0.png \
  --image tools/dfine-audit/images/street_1.png \
  --image tools/dfine-audit/images/street_2.png
```

It prints, per image:

- SHA-256 and whether it matches `1dbf71cb…`, plus whether the copy in
  `public/models/` matches (i.e. whether production is shipping the right file)
- `ir_version`, producer, input names, output names, and whether the graph has
  D-FINE's 2-in/3-out signature
- the raw output dtypes and dimensions (the `BigInt64Array` question)
- the score distribution (`max`, `p10`, median, min over all 300 rows)
- the box value range — **max must be near 640**; a max near 1 means the graph
  emits normalised `cxcywh` and the absolute-`xyxy` assumption is wrong
- the label range — **anything above 79** means the index is a flat
  `query × class` index, not a class id
- per-threshold kept counts with class histograms and sample boxes in both canvas
  and frame space
- how many kept classes the application would render as "Unclassified"

The three committed PNGs (612×408, 500×333, 427×640) are real street scenes with
people and vehicles, deliberately at three aspect ratios so letterbox padding is
exercised in both axes.

---

## Verified: the contract is implemented correctly

Checked against the authors' own source, not assumed.

**Post-processing** (`src/zoo/dfine/postprocessor.py`, deploy branch):

```python
bbox_pred = box_convert(boxes, in_fmt="cxcywh", out_fmt="xyxy")
bbox_pred *= orig_target_sizes.repeat(1, 2).unsqueeze(1)
scores, index = topk(sigmoid(logits).flatten(1), self.num_top_queries)
labels = mod(index, self.num_classes)
```

| Check | Result |
| --- | --- |
| Box format handled as absolute `xyxy` | Correct; a test asserts it is **not** read as `cxcywh` |
| `orig_target_sizes` = letterboxed canvas, not frame | Correct (feeding the frame would double-scale) |
| Labels are `index % 80` → 0..79 | Correct |
| Output tensor order `labels, boxes, scores` | Correct — `export_onnx.py` returns postprocessor output directly, **no permute** |
| Preprocessing RGB, `/255`, CHW | Correct — matches `T.ToTensor()` |
| Letterbox | Matches reference to sub-pixel; reference floors the pad (`// 2`), app keeps float, difference < 1 px |
| COCO label table | **Exactly** matches official `mscoco_category2label` order (verified element-wise) |
| Requirement for NMS | Reference does none; the app correctly does none by default |

So: **the decode path is not where the production symptom comes from.** A
mis-shaped graph would still be caught — that is what the harness is for — but
the code that reads a well-formed graph is right.

---

## Defects found and fixed

These are real, reproducible from the code, and independent of the artifact.

### 1. Boxes that live entirely in the letterbox filler were drawn as objects

`unletterboxBox` clamps to the frame, so a box positioned in the black padding
band does not vanish — it collapses into a sliver pinned to the picture edge.
Several per frame is exactly a row of edge boxes belonging to nothing.

Demonstrated with the harness: for a 612×408 frame the padding is 106.7 px top
and bottom, and a background box at canvas `y 22..92` maps to frame `y −81..−14`.

Fixed with `filterToContentRegion` in `src/vision/dfine.ts`, applied in the
worker **before** frame mapping. Partial overlap is kept, because an object at the
edge legitimately extends into the band. The drop count is reported as
`inPadding` in the diagnostics line.

### 2. 63 of 80 COCO classes render as "Unclassified"

`mapLabelToVisionClass` maps 17 of the 80 COCO names. The other 63 — `train`,
`airplane`, `backpack`, `tie`, `bench`, `handbag`, `bottle`, `chair`, `couch`,
`bed`, and so on — fall through to `unknown`, displayed as "Unclassified".

This is not a decoding bug and was **not** hidden by renaming. It is an
architecture limitation: the product taxonomy has 10 traffic classes, D-FINE
speaks 80 COCO classes. Any of those 63 appearing is a *correct* COCO detection
that the UI cannot name. The audit harness now reports how many kept detections
fall in that bucket per image, so the size of the gap is measurable rather than
guessed.

### 3. The D-FINE option is not gated on the asset existing

`dfineAssetAvailable()` was added in an earlier round and called from **nowhere**.
The detector dropdown always offers D-FINE, including in a deployment where the
build did not install the weights. Selecting it then falls back to YOLO11n with a
message — the correct fallback, but it means the UI can advertise a detector that
is not present and the operator has no way to know before selecting it.

---

## Hypotheses tested and rejected

| Hypothesis | Evidence |
| --- | --- |
| Boxes are normalised `cxcywh` and get mis-scaled | Our code path is right per the reference, and the worker's box-shape guard would reject a `[1,4,300]` tensor; the stub and real-ORT tests confirm absolute `xyxy` handling |
| Label table is in the wrong order | Verified element-wise identical to the official 80-class order |
| Wrong channel order (BGR) or wrong normalisation | `T.ToTensor()` + `PIL.convert("RGB")` in the reference equals our RGB + `/255` |
| `orig_target_sizes` fed the frame size | Not in the current code; the effect (a 4:3 box 200..300 → `x 150, w 75`) was quantified but the code does not do this |
| Wrong output order (permuted) | `export_onnx.py` exposes postprocessor output directly |

---

## Open — requires the artifact

These acceptance criteria **cannot be signed off** from this environment, and I am
not claiming them:

- [ ] Released model passes real-image inference
- [ ] A person is detected with a correctly positioned box and correct class
- [ ] Background produces no flood of detections on real photos
- [ ] Real-model accuracy reported separately from synthetic tests
- [ ] Verdict on whether the artifact itself is defective

Run the harness on a machine that can reach the asset host. If it reports
`sha match: YES`, `D-FINE signature: YES`, box max ≈ 640 and label range 0..79,
the artifact is sound and the remaining symptom is in the UI layer. If instead it
reports one input named `images`, or a box max near 1, or labels above 79, the
artifact is wrong and must be re-exported — at which point the harness output is
the evidence needed for a reviewed release-asset change.

Until that runs, the honest statement is: **the contract is correct, three real
defects are fixed, and the production flood has not been reproduced or explained
against the actual model.**

---

## How to complete it

```bash
# 1. fetch and verify the exact production artifact
curl -L -o /tmp/dfine.onnx \
  https://github.com/omrajnexus31173/3d-are-b-t/releases/download/dfine-n-v1/dfine_n_coco.onnx
shasum -a 256 /tmp/dfine.onnx   # must equal 1dbf71cb…f7ab

# 2. audit it against real images
npm i --no-save onnxruntime-web
node tools/dfine-audit/audit.mjs --model /tmp/dfine.onnx \
  --image tools/dfine-audit/images/street_0.png \
  --image tools/dfine-audit/images/street_1.png \
  --image tools/dfine-audit/images/street_2.png

# 3. in the browser, compare the worker's numbers to the harness'
localStorage.bharatDetectionDebug = '1'   // then reload and watch the console
```

The browser diagnostic line and the harness line are deliberately the same
fields, so a disagreement between them isolates the fault to the browser
pipeline rather than the model.
