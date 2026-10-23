# Fragments proof of concept

Can That Open's Fragments format open the large IFC files RSP submits (up to
800 MB) in the browser? This folder answers that without touching the app.

- `fragments-viewer.js` is `FragmentsViewer`, a viewer on Fragments with the
  same interface as the app's `js/viewer.js` (see the file's header for what
  is covered and how it differs).
- `frag-store.js` gets a `.frag` for a file: converts an IFC in a Web Worker
  (`convert-worker.mjs`), caches the result in the browser's private file
  system (OPFS), and reads it from there next time.
- `index.html` is a test page for both: open IFCs or `.frag`s (several at
  once), orbit, click elements, hide, colour by class with the ghost / hidden
  / normal context. It shows how long each step took, the memory used and the
  frame rate.
- `convert.mjs` converts an IFC to a `.frag` offline, in Node.

## Running it

Serve the repository (`tools/serve.ps1`, or `python -m http.server`) and open
`/poc/fragments/index.html`. No install is needed for the page. **Load
sample** opens a synthetic model of 40,000 walls (`sample-40k.frag.b64.txt`, a
`.frag` stored as base64 because the hosted page only serves known file types).

For repeatable tests, put IFCs (or hard links to them) in `models/`, which git
ignores, and open `index.html?src=models/a.ifc,models/b.ifc`.

Offline conversion needs Node:

    cd poc/fragments
    npm install
    node convert.mjs "<model.ifc>"          # writes <model>.frag beside it

## What it uses

| Package | Version | Why |
|---|---|---|
| `@thatopen/fragments` | 3.4.7 | the format, the converter and the viewer |
| `three` | 0.182.0 | required by Fragments (the app is on 0.158) |
| `web-ifc` | 0.0.77 | used by the converter (the app is on 0.0.36) |

The page loads these from unpkg. Two files are served beside it, because
the hosted artifact page may only start workers and fetch wasm from its own
files: `vendor/fragments-worker.mjs` (the Fragments worker, copied from
`node_modules/@thatopen/fragments/dist/Worker/worker.min.mjs`) and
`vendor/web-ifc/web-ifc.wasm`.

Import maps do not reach workers, so `convert-worker.mjs` fetches the
Fragments bundle as text, points its `three` and `web-ifc` imports at pinned
CDN URLs (three's from jsDelivr, which rewrites three's examples to import the
same three), applies the `patch-fragments.mjs` fix, and imports it from a
blob URL. A hosted page with a strict policy may refuse blob-URL scripts; that
has not been tried on the artifact yet.

## Results

See [RESULTS.md](RESULTS.md).
