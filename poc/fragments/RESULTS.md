# Results

## In the app (23 October 2026)

Same laptop (64 GB, Intel Arc). The page was in a hidden pane for most runs,
which slows anything waiting for a frame, so treat open times as upper bounds.

| IFC | Triangles | Index (worker) | Geometry (worker) | Total to ready | Peak, tab process | Page heap once open |
|---|---|---|---|---|---|---|
| 6 MB (UWC BLK8, forced) | 85,000 | | | about 8 s | | |
| 226 MB (UWC BLK6) | 11.7 M | | | 69 s; 15–21 s from the cache | | 174 MB |
| 590 MB (FAB1) | 86.1 M | 31 s | about 80 s | 151 s | 3.9 GB* | 134 MB |

\* Includes the 618 MB IFC held in the page by the test harness, which loads
files by URL; the file picker reads from disk instead. Building the index and
the geometry in one worker peaked at 4.9 GB, because web-ifc never returns its
heap and the two steps each start one: they now run in two workers, one after
the other.

- Same 6 MB file opened both ways: compliance results identical (after reading
  two web-ifc 0.0.77 value shapes); the model's ground extent differs by 1 m²
  in 13,185 m². Element boxes agree within 8 mm (median 0.2 mm).
- Fragments calls per change on the 226 MB model, before the redraw:
  selection 1–18 ms, hide or show 1 ms, a new query with everything ghosted
  about 280 ms.
- The first design kept a copy of every triangle in the page for picking:
  577 MB on the 226 MB model. Replaced by per-element boxes and hulls (11 MB)
  plus Fragments' raycast.

## Real RSP models in the browser (22 October 2026)

`FragmentsViewer` with in-browser conversion in a Web Worker
(`convert-worker.mjs`). Machine: Windows 11 laptop, 64 GB RAM, Intel Arc Pro
140T GPU (real WebGL, not software). The page was in the Claude app's browser
pane while the pane was hidden, which pauses animation frames and slows
timers, so **open times are probably pessimistic and frame rate could not be
measured**. Conversion runs in a worker and should not be affected.

| IFC | Items with geometry | Conversion (worker) | .frag | Open .frag | Reopen from cache | Peak memory, tab process |
|---|---|---|---|---|---|---|
| 95 MB (UWC BLK4) | 42,196 | 69 s | 12.5 MB | 7 s | not measured | not measured |
| 226 MB (UWC BLK6) | 97,200 | 86 s | 27.9 MB | 10 s | 18 s total | about 2.4 GB |
| 590 MB (FAB1, DG resubmission) | 124,482 | 8.8 min | 77.8 MB | 23 s | 26 s total | about 2.7 GB |

- The page's JS heap stays at about 30 MB once a model is open, even for 590 MB.
  After conversion the worker is terminated and the tab process fell back to
  about 770 MB.
- Peak memory includes the IFC held as a fetched blob (these tests opened the
  file by URL, `?src=`). Opening through the file picker reads it from disk in
  chunks, so the peak there should be lower; not yet measured.
- `.frag` is about ⅛ of the IFC, as on the synthetic models.
- **Picking on a real GPU: 12–45 ms per click** (1–3 s on software rendering
  before). The 590 MB model draws 1.2 M triangles in about 1,000 draw calls.
- Clicking a slab returned Name, ObjectType, PredefinedType, Tag and GlobalId.
- Colour by class (8 groups, 97,000 elements, others ghosted): about 3 s,
  including looking up every element's class. Each hide, show or selection
  took 0.4–0.6 s, nearly all of it in `fragments.update(true)` waiting for a
  redraw, which the hidden pane slows; the edits themselves took about 1 ms.
  Re-measure with the page in view.
- The 590 MB conversion is slower per MB than the others (8.8 min vs about
  1.5 min for 226 MB). Progress sat at "geometries 8%" for most of it, so
  the time is in geometry for this model, unlike the synthetic 779 MB one.
  Not profiled yet. It uses one core.

Measured in a cloud container: 4 cores, no GPU (software WebGL in headless
Chromium). Browser timings there ran about 4x slower than the same web-ifc
work in Node, so expect a normal PC to be faster. The proportions should
hold.

The test models are synthetic: rows of extruded walls, each with a
four-property set. Real Revit geometry is heavier, so these are best read as
relative numbers. Re-measure with a real 150–250 MB model before deciding.

## Today's app vs Fragments, 133 MB IFC (160,000 walls)

| | Current app (web-ifc-three) | Fragments |
|---|---|---|
| First open | 73 s, page frozen ~72 s of it | 45 s offline conversion (Node), then 6 s to open |
| Converting in the browser instead | n/a | 45 s conversion + 6 s open; page frozen while converting; 870 MB heap afterwards |
| Reopening the same model | 73 s again | 6 s (the .frag is reused) |
| JS heap once open | 1.2 GB | about 30 MB |
| File opened | 133 MB IFC | 17 MB .frag |

Where the current app's 73 s goes: about 41 s generating and building geometry
(28 s of it web-ifc tessellation), 18 s indexing properties, 2 s arc check,
1.4 s opening the file.

## Offline conversion (`convert.mjs`)

| IFC | .frag | Time | Peak memory |
|---|---|---|---|
| 13 MB (40,000 walls) | 1.4 MB | 8 s | 364 MB |
| 133 MB (160,000 walls) | 17 MB | 45 s (62 s before the patch) | 974 MB |
| 779 MB (921,600 walls) | 98 MB | 9.6 min (21.6 min before the patch) | 4.7 GB |

The patch (`patch-fragments.mjs`, run on `npm install`) replaces a linear
search in the importer's spatial-tree step with a Map. On the 133 MB model the
output opens with the same 960,006 items and the same picks as without it.
After the patch, the 779 MB conversion still spends about 7 minutes after its
geometry, attributes and relations stages; the 133 MB profile shows no single
hotspot left, so the large-file case has not been profiled further.

## Viewing and picking

- Clicking returns the element's class, Name, GlobalId and PredefinedType.
- Each click took 1–3 s here; this needs measuring on a PC with a GPU.
- The 779 MB model's .frag was not opened in the browser (test stopped,
  since files that size are rare for RSP).

## Hosted (Claude artifact) page

The page loads three, web-ifc and Fragments from unpkg. The Fragments worker
and web-ifc.wasm are served as the page's own files, because the artifact
only starts workers and fetches wasm from its own files. The page is published;
opening a real model there is the next test.
