# Handover: moving the viewer to Fragments

Start here in a new session about the Fragments viewer. Dated 22 October 2026.
Read the repository's main `HANDOVER.md` and `README.md` for the app as a
whole; this page covers only the move to Fragments.

**Branch:** `claude/fragments-poc` (this folder). `main` holds the app with the
Warnings tab, measure tool and GPU picking (PR #12, merged).

## Why we are doing this

- RSP's IFC files are mostly under 250 MB, but growing towards CORENET X's
  800 MB cap. IFC-SG requirements and project complexity keep growing.
- Many architects have low-RAM laptops, so the solution has to run for them.
- Today's loader (web-ifc-three) parses the whole IFC in the browser tab. On a
  192 MB synthetic file the tab reached about 2.5 GB, and a ~200 MB real RSP
  model crashed the Claude app. web-ifc-three is no longer maintained.
- Commercial viewers handle size but are not tuned to IFC-SG or RSP's
  workflow, which is this tool's main value.

## Decisions already made with the user

- **Fragments (That Open, MIT) becomes the single 3D engine for all sizes.**
  Opening an IFC means converting it to Fragments; that conversion replaces
  today's parse rather than adding a step. Not two engines.
- **The model and its properties arrive together.** No "properties first, 3D
  later" split.
- **Each revision is converted once and cached**, keyed by the model identity
  the app already computes (`js/model-id.js`). Keep only the latest revision
  per model, cap the cache (about 2 GB), evict least recently opened, show
  usage with a Clear button. The IFC stays the master copy.
- **Processing runs on the user's own PC first** (pilot stage, needs
  management and IT buy-in). Large files are converted offline in Node and
  saved next to the IFC, so the browser opens a ready `.frag`.
- **Later:** a processing service (one 32 GB PC, then on-premises or Azure
  Singapore with SharePoint) and revision comparison by GlobalId with
  change-only re-checks. A portable desktop app (Electron) is optional, not
  the plan, because it would make every laptop do the heavy work.

## What exists in this folder

| File | What it is |
|---|---|
| `convert.mjs` | IFC → `.frag` in Node. Reads the IFC in 1 MB chunks (`OpenModelFromCallback`); prints stage times and peak memory. `node convert.mjs model.ifc [out.frag]` |
| `index.html` | Standalone test page: open a `.frag`, or an IFC to convert in the browser; orbit, click to read element data; shows load time, memory, frame rate. Load sample button. |
| `patch-fragments.mjs` | Postinstall patch: replaces a quadratic `expressIDs.indexOf` in the importer's spatial-tree step with a Map. 779 MB test: 21.6 → 9.6 min. Same output. |
| `RESULTS.md` | All measurements so far. |
| `vendor/fragments-worker.mjs` | The Fragments worker, copied from `node_modules/@thatopen/fragments/dist/Worker/worker.min.mjs`. |
| `vendor/web-ifc/web-ifc.wasm` | web-ifc 0.0.77 wasm, for in-browser conversion. |
| `sample-40k.frag.b64.txt` | A 40,000-wall `.frag` as base64 (artifacts only serve known file types). |

Run: `cd poc/fragments && npm install` (applies the patch), then serve the repo
and open `/poc/fragments/index.html`.

Published test page (Claude artifact, private to the user):
https://claude.ai/artifact/EMkEG9tYKQHSpG5U8FTb3Z

## Key measurements (synthetic models, cloud machine with no GPU)

| | Today's app | Fragments |
|---|---|---|
| 133 MB, first open | 73 s, page frozen | 45 s conversion (Node) + 6 s open |
| 133 MB, reopen | 73 s | 6 s |
| JS heap once open | 1.2 GB | ~30 MB |
| 779 MB | not possible in a browser | 9.6 min conversion, 4.7 GB peak in Node, 98 MB `.frag` |

- Where today's 73 s goes: ~41 s geometry (28 s web-ifc tessellation, ~10 s
  web-ifc-three mesh building), 18 s property indexing, all on the main thread.
- In-browser conversion of 133 MB: 45 s, page frozen, 870 MB heap left behind.
- `.frag` ≈ ⅛ of the IFC size on these models.
- Picking returned class, Name, GlobalId, PredefinedType; each pick took 1–3 s
  here (software rendering), unverified on a real GPU.
- Not yet measured: real Revit models, a real GPU, conversion inside a Web
  Worker, opening the 779 MB model's `.frag` in a browser.

## Versions and constraints

- Fragments `3.4.7` needs `three >= 0.182` and `web-ifc >= 0.0.77`. The app is
  on three `0.158`, web-ifc `0.0.36`, web-ifc-three `0.0.126`: moving means
  upgrading all three together.
- No build step: ES modules from unpkg via an import map, pinned exact versions.
- **Claude artifact hosting:** workers and wasm must be the page's own files
  (never `FragmentsModels.getWorker()`, which fetches from unpkg); fetch only
  same-origin; no downloads; `confirm()` returns false; only known file types
  are served (hence the base64 sample).
- **GitHub Pages** (https://samuelooi.github.io/rsp-cx-takeoff/) deploys from
  `main`. Browsers can keep old module scripts after a release (it happened
  with PR #12: new `index.html`, old `app.js`). Proposed fix, not done: stamp
  a version into script URLs via a GitHub Actions Pages deploy (the user
  switches Settings → Pages → Source → GitHub Actions) and show the version in
  the app.
- The arc fix (`js/ifc-arc-fix.js`) straightens IFCARCINDEX profiles because
  web-ifc 0.0.36 and 0.0.77 both mis-tessellate them. Check whether the
  Fragments importer needs the same pre-pass.

## What the app needs from the viewer (the porting list)

`js/viewer.js` is the only place that touches meshes; everything else calls
these. Each needs a Fragments equivalent:

- **Models:** `load`, `removeModel`, `setModelVisible`, `entries`, `models`,
  `hasModels`, `coordinationMatrix` (federation datum), `releaseModelData`.
- **Colouring and visibility:** `setQuery` / `clearGroups` (legend colour
  groups), `setContextMode` (ghost / hidden / normal), `setHidden`, `showAll`,
  `setSelection` / `clearSelection`. Aggregates resolve through `parts`
  (`_geometryIds`), e.g. a Revit stair drawn by its flights.
- **Picking:** `pickElement` (GPU, `{modelID, expressID}`), `onPick`,
  `onContextMenu`, `pickSuspended`, `_pointerRay`, `raycastFace`.
- **Camera:** `fit` (robust framing; `farElements` flags stray geometry),
  `fitElements`, `cameraViewpoint` / `setViewpoint` (BCF), `snapshot`
  (BCF and PDF report), `activeCamera`.
- **Sections and plans:** `addSectionAtFace`, `previewSection`, drag, flip,
  remove; `enterPlanView` / `exitPlanView` / `setPlanClip`.
- **Geometry queries for checks:** `elementPoints`, `elementHull`,
  `modelHull`, `groundLevel`, `elementYRange`, `sampleFloorY`,
  `modelCentres`, `elementTriangles` (measure edge snapping).
- **Survey overlays:** `setSurveyOverlays`, `fitSurvey`, `clearSurveyOverlays`.
- **Hooks:** `onFrame`.

The property index (`js/ifc-index.js` `buildIndex`) reads the web-ifc model
directly. With Fragments it must come from the conversion pass instead
(Fragments attributes and relations, or our own index written alongside),
keyed so that `modelID:expressID` and GlobalIds still resolve. Checks,
Warnings, Dashboard, editing and BCF all read that index.

## Suggested first steps

1. Upgrade three / web-ifc on a branch and confirm the current app still
   works, or decide to build the Fragments viewer beside `viewer.js` behind
   the same interface.
2. Conversion in a Web Worker (in-browser), producing `.frag` plus the
   property index in one pass, with progress and Cancel; terminate the worker
   afterwards to free its memory.
3. A `FragmentsViewer` implementing load, colouring, hiding, picking and fit
   first; then sections, plans, measuring, survey overlays.
4. The per-revision cache (OPFS or IndexedDB) and its Clear control.
5. Re-run the measurements on real RSP models (150–250 MB) and on an 8 GB
   laptop; update `RESULTS.md`.

## Open questions

- Fragments' own picking speed on a real GPU (1–3 s here), or reuse our GPU
  pick.
- Whether Fragments preserves everything the checks need (psets, quantities,
  storeys, aggregation, IfcMapConversion / CRS for georeferencing).
- How editing (`js/ifc-edit/`) fits: it edits the IFC text, so a fixed IFC
  needs re-conversion, or a patch applied to the cached `.frag`.

## Environment notes for the next session

- `pkill -f "<pattern>"` inside a shell command matches its own shell and
  kills the command (exit 144). Kill by PID instead.
- Force-pushes are refused in this environment; prefer new commits or merges.
- SharePoint and Google Drive downloads are blocked by the network policy
  unless the user allows the host. A 196 MB RSP test file is in the user's
  Google Drive as `X-COP-A-FAB2-00-BLDG-51.ifc`.
- Headless Chromium uses software WebGL: frame times (~425 ms idle on large
  models) and GPU behaviour are not representative.

## Related material

- Business case page: https://claude.ai/artifact/RojtRPgZ6Z42uS3ixMJSo3
- Management deck: https://claude.ai/artifact/23Lqk9oUvtderGJamwH5jZ
- Main app artifact: https://claude.ai/artifact/Myqpwkun3MTWqNhg15v9XG

## Opening prompt for the new session

> Read `poc/fragments/HANDOVER.md` on branch `claude/fragments-poc` of
> samuelooi/rsp-cx-takeoff. We are moving the viewer to That Open Fragments.
> Start with step 1 of "Suggested first steps" and tell me your plan before
> changing the app.
