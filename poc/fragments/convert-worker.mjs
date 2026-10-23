/**
 * Converts an IFC to a Fragments (.frag) file inside a Web Worker, so the page
 * stays responsive and every byte the converter allocated is returned to the
 * system when the page terminates the worker afterwards.
 *
 *   in:  { file: File | Blob, wasmPath: string }
 *   out: { type: 'progress', process, state, progress }
 *        { type: 'done', bytes: Uint8Array, ms, peakHeap }   (bytes transferred)
 *        { type: 'error', message }
 *
 * The IFC is never read into memory whole: web-ifc pulls it through a callback
 * in chunks, which FileReaderSync serves straight from the file on disk. On a
 * 600 MB model that is 600 MB the tab does not have to find.
 *
 * Import maps do not reach workers, and the Fragments bundle imports "three"
 * and "web-ifc" by bare name. So the bundle is fetched as text, its imports are
 * pointed at pinned CDN URLs, the importer patch is applied (see
 * patch-fragments.mjs), and the result is imported from a blob URL.
 */

const FRAGMENTS = 'https://unpkg.com/@thatopen/fragments@3.4.7/dist/index.mjs';
const IMPORTS = {
  'three': 'https://cdn.jsdelivr.net/npm/three@0.182.0/+esm',
  'web-ifc': 'https://unpkg.com/web-ifc@0.0.77/web-ifc-api.js',
};
// three's examples, rewritten by jsDelivr to import the same three as above.
const threeExample = (path) => `https://cdn.jsdelivr.net/npm/three@0.182.0/${path}/+esm`;

// The same patch as patch-fragments.mjs: a Map instead of a linear indexOf
// per contained element while the spatial tree is built.
const PATCH_BEFORE = 'const entityIndex = this.expressIDs.indexOf(relatedID);';
const PATCH_AFTER = 'if (this.__idxLen !== this.expressIDs.length) { this.__idx = new Map(); this.expressIDs.forEach((id, i) => { if (!this.__idx.has(id)) this.__idx.set(id, i); }); this.__idxLen = this.expressIDs.length; } const entityIndex = this.__idx.has(relatedID) ? this.__idx.get(relatedID) : -1; /* rsp-patched */';

async function loadFragments() {
  let src = await (await fetch(FRAGMENTS)).text();
  src = src.replace(/from\s*"([^"]+)"/g, (m, spec) => {
    if (IMPORTS[spec]) return `from "${IMPORTS[spec]}"`;
    if (spec.startsWith('three/examples/')) return `from "${threeExample(spec.slice('three/'.length))}"`;
    return m;
  });
  if (src.split(PATCH_BEFORE).length === 2) src = src.replace(PATCH_BEFORE, PATCH_AFTER);
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

self.onmessage = async ({ data: { file, wasmPath } }) => {
  try {
    const FRAGS = await loadFragments();
    const importer = new FRAGS.IfcImporter();
    importer.wasm = { path: wasmPath, absolute: true };

    const reader = new FileReaderSync();
    const readCallback = (offset, size) =>
      new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + size)));

    let peakHeap = 0;
    const t0 = performance.now();
    const bytes = await importer.process({
      readFromCallback: true,
      readCallback,
      progressCallback: (progress, d) => {
        if (performance.memory) peakHeap = Math.max(peakHeap, performance.memory.usedJSHeapSize);
        self.postMessage({ type: 'progress', progress, process: d && d.process, state: d && d.state, class: d && d.class });
      },
    });
    const ms = performance.now() - t0;
    self.postMessage({ type: 'done', bytes, ms, peakHeap }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
