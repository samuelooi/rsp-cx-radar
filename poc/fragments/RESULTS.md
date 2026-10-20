# Results

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
