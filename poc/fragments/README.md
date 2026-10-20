# Fragments proof of concept

Can That Open's Fragments format open the large IFC files RSP submits (up to
800 MB) in the browser? This folder answers that without touching the app.

- `convert.mjs` converts an IFC to a `.frag` file offline, in Node.
- `index.html` is a standalone test page: open a `.frag`, or an `.ifc` to
  convert it in the browser first, then orbit and click elements. It shows
  how long each step took, the memory used and the frame rate.

## Running it

    cd poc/fragments
    npm install
    node convert.mjs "<model.ifc>"          # writes <model>.frag beside it

Serve the repository (`tools/serve.ps1`, or `python -m http.server`) and open
`/poc/fragments/index.html`. **Load sample** opens a synthetic model of 40,000
walls (`sample-40k.frag.b64.txt`, a `.frag` stored as base64 because the hosted
page only serves known file types).

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

## Results

See [RESULTS.md](RESULTS.md).
