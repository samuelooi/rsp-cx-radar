/**
 * Converts a large IFC for the Fragments engine, in a Web Worker: the
 * property index (the same buildIndex the IFC path runs) and the .frag
 * geometry, in one job. The page stays responsive, and everything the
 * converter allocated goes back to the system when the page terminates the
 * worker afterwards.
 *
 *   in:  { job: 'index'|'geometry', file, ruleset: { entities, entityDisplay }, wasmPath }
 *   out: { type: 'progress', stage, pct, detail? }   detail: index message, or
 *        { process: 'geometries'|'attributes'|'relations'|…, class? } while converting
 *        { type: 'done', index, ms }                  for 'index'
 *        { type: 'done', frag: Uint8Array, ms }       for 'geometry' (frag transferred)
 *        { type: 'error', message }
 *
 * The IFC is never read into memory whole: web-ifc pulls it through a callback
 * in chunks, which FileReaderSync serves straight from the file on disk.
 *
 * Import maps do not reach workers, and the modules used here import "three",
 * "web-ifc" and each other by name. So each module is fetched as text, its
 * imports are pointed at pinned URLs (or at modules rewritten the same way),
 * and it is imported from a blob URL.
 */

const WEB_IFC = 'https://unpkg.com/web-ifc@0.0.77/web-ifc-api.js';
const FRAGMENTS = 'https://unpkg.com/@thatopen/fragments@3.4.7/dist/index.mjs';
const BARE = {
  'three': 'https://cdn.jsdelivr.net/npm/three@0.182.0/+esm',
  'web-ifc': WEB_IFC,
};
// three's examples, rewritten by jsDelivr to import the same three as above.
const threeExample = (spec) => `https://cdn.jsdelivr.net/npm/three@0.182.0/${spec.slice('three/'.length)}/+esm`;

// A Map instead of a linear indexOf per contained element while the importer
// builds the spatial tree (see poc/fragments/patch-fragments.mjs on branch
// claude/fragments-poc): 21.6 -> 9.6 min on a 779 MB test file, same output.
const PATCH_BEFORE = 'const entityIndex = this.expressIDs.indexOf(relatedID);';
const PATCH_AFTER = 'if (this.__idxLen !== this.expressIDs.length) { this.__idx = new Map(); this.expressIDs.forEach((id, i) => { if (!this.__idx.has(id)) this.__idx.set(id, i); }); this.__idxLen = this.expressIDs.length; } const entityIndex = this.__idx.has(relatedID) ? this.__idx.get(relatedID) : -1; /* rsp-patched */';

const rewritten = new Map(); // module URL -> blob URL

/** Imports a module with its bare and relative imports resolved as described above. */
async function importRewritten(url, patch = (s) => s) {
  return import(await rewrite(url, patch));
}

async function rewrite(url, patch = (s) => s) {
  if (rewritten.has(url)) return rewritten.get(url);
  let src = patch(await (await fetch(url)).text());
  const specs = new Set([...src.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const targets = new Map();
  for (const spec of specs) {
    if (BARE[spec]) targets.set(spec, BARE[spec]);
    else if (spec.startsWith('three/examples/')) targets.set(spec, threeExample(spec));
    else if (spec.startsWith('./') || spec.startsWith('../')) targets.set(spec, await rewrite(new URL(spec, url).href));
  }
  src = src.replace(/((?:from|import)\s*)(["'])([^"']+)\2/g, (m, kw, q, spec) =>
    targets.has(spec) ? `${kw}${q}${targets.get(spec)}${q}` : m);
  const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  rewritten.set(url, blobUrl);
  return blobUrl;
}

const post = (stage, pct, detail) => self.postMessage({ type: 'progress', stage, pct, detail });

self.onmessage = async ({ data: { job, file, ruleset, wasmPath } }) => {
  try {
    const t0 = performance.now();
    const reader = new FileReaderSync();
    const readCallback = (offset, size) =>
      new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + size)));

    // ---- properties: the app's own index, so checks see exactly what they
    // would have seen had the IFC been opened directly. Its own job (its own
    // worker): web-ifc never hands its heap back, and the converter below
    // starts a second one, so doing both here held two at once (4.9 GB on a
    // 590 MB model).
    if (job === 'index') {
      post('index', 0);
      const [WebIFC, { buildIndex }] = await Promise.all([
        import(WEB_IFC),
        importRewritten(new URL('../ifc-index.js', import.meta.url).href),
      ]);
      const api = new WebIFC.IfcAPI();
      api.SetWasmPath(wasmPath, true);
      await api.Init();
      const modelID = api.OpenModelFromCallback(readCallback, { COORDINATE_TO_ORIGIN: false });
      const index = buildIndex(api, modelID, ruleset, (msg, pct) => post('index', pct, msg));
      api.CloseModel(modelID);
      self.postMessage({ type: 'done', index, ms: performance.now() - t0 });
      return;
    }

    // ---- geometry
    post('geometry', 0);
    const FRAGS = await importRewritten(FRAGMENTS, (s) =>
      (s.split(PATCH_BEFORE).length === 2 ? s.replace(PATCH_BEFORE, PATCH_AFTER) : s));
    const importer = new FRAGS.IfcImporter();
    importer.wasm = { path: wasmPath, absolute: true };
    const frag = await importer.process({
      readFromCallback: true,
      readCallback,
      // Reported once per IFC class, after it is done: one large class (say
      // 80,000 curtain-wall plates) is a long step with no report.
      progressCallback: (p, d) => post('geometry', p * 100, d ? { process: d.process, class: d.class } : null),
    });

    self.postMessage({ type: 'done', frag, ms: performance.now() - t0 }, [frag.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
