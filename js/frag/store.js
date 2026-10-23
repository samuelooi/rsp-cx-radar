/**
 * Large models: converting an IFC for the Fragments engine, caching the result,
 * and the .rspfrag file a converted model is saved as.
 *
 * A .rspfrag carries everything the app needs to open the model again without
 * its IFC: the Fragments geometry, the property index the checks run on, and
 * the IFC header that identifies the file. Layout:
 *
 *   "RSPFRAG1" | uint32 LE length of the metadata | gzipped JSON metadata | .frag bytes
 *
 * The cache lives in the browser's private file system (OPFS), so a model is
 * read from disk on demand rather than held in memory. One revision per model
 * name (a new revision replaces the old), least recently opened out past
 * CACHE_LIMIT, and `clearCache` empties it. The IFC stays the master copy.
 */

import { serialiseIndex } from '../ifc-index.js';

export const BUNDLE_EXT = '.rspfrag';
const MAGIC = 'RSPFRAG1';
const FORMAT = 1;
const CONVERTER = { fragments: '3.4.7', webIfc: '0.0.77' };

const CACHE_DIR = 'rspfrag-cache';
const CACHE_LIMIT = 2 * 1024 ** 3;
const WORKER_URL = new URL('./convert-worker.js', import.meta.url);
const WASM_PATH = new URL('../../vendor/web-ifc-0.0.77/', import.meta.url).href;

/**
 * Bumped whenever what buildIndex records changes, so cached conversions are
 * indexed again rather than reused with the old shape.
 */
const INDEX_VERSION = 2;

/**
 * The index depends on which entities the ruleset asks for, so a model indexed
 * under different rules is indexed again (from the IFC) rather than reused.
 */
export function rulesetSignature(ruleset) {
  const s = `v${INDEX_VERSION}:` + [...ruleset.entities].sort().join(',');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ------------------------------------------------------------------ bundle

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** @returns {Promise<Blob>} */
export async function encodeBundle(meta, frag) {
  const json = await gzip(JSON.stringify({ format: FORMAT, converter: CONVERTER, ...meta }));
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode(MAGIC));
  new DataView(head.buffer).setUint32(8, json.byteLength, true);
  return new Blob([head, json, frag], { type: 'application/octet-stream' });
}

/** @returns {Promise<{ meta: object, frag: Uint8Array }>} */
export async function decodeBundle(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, 8)) !== MAGIC) {
    throw new Error(`${blob.name || 'This file'} is not a converted model (${BUNDLE_EXT}).`);
  }
  const len = new DataView(head.buffer).getUint32(8, true);
  const meta = JSON.parse(await gunzip(new Uint8Array(await blob.slice(12, 12 + len).arrayBuffer())));
  if (meta.format > FORMAT) throw new Error(`${blob.name || 'This file'} was saved by a newer version of the app.`);
  const frag = new Uint8Array(await blob.slice(12 + len).arrayBuffer());
  return { meta, frag };
}

// ------------------------------------------------------------------ cache

const safe = (s) => s.replace(/[^\w.-]+/g, '_');
const keyOf = (file) => `${safe(file.name)}__${file.size}__${file.lastModified || 0}${BUNDLE_EXT}`;
const modelOf = (key) => key.split('__')[0];

// When each entry was last opened, so eviction goes by use rather than by when
// it was converted. Losing it only makes eviction fall back to conversion time.
const OPENED_KEY = 'rspfrag-cache-opened';
function openedTimes() {
  try { return JSON.parse(localStorage.getItem(OPENED_KEY)) || {}; } catch { return {}; }
}
function markOpened(key, on = true) {
  const t = openedTimes();
  if (on) t[key] = Date.now(); else delete t[key];
  try { localStorage.setItem(OPENED_KEY, JSON.stringify(t)); } catch { /* private window */ }
}

let persistAsked = false;
async function cacheDir() {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  // Without this the browser may clear the cache when it likes (the Claude
  // app's browser pane emptied it overnight). It can still say no.
  if (!persistAsked && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Every cached model: [{ key, name, size, opened }], most recently opened first. */
export async function cacheEntries() {
  const dir = await cacheDir();
  if (!dir) return [];
  const opened = openedTimes();
  const out = [];
  for await (const [key, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !key.endsWith(BUNDLE_EXT)) continue;
    const f = await handle.getFile();
    out.push({ key, name: modelOf(key), size: f.size, opened: opened[key] || f.lastModified });
  }
  return out.sort((a, b) => b.opened - a.opened);
}

export async function clearCache() {
  const dir = await cacheDir();
  if (!dir) return;
  for (const { key } of await cacheEntries()) {
    await dir.removeEntry(key);
    markOpened(key, false);
  }
}

/** The cached bundle for this IFC revision, as a disk-backed File, or null. */
async function readCached(file) {
  const dir = await cacheDir();
  if (!dir) return null;
  try {
    const f = await (await dir.getFileHandle(keyOf(file))).getFile();
    markOpened(keyOf(file));
    return f;
  } catch {
    return null;
  }
}

/** Stores a bundle; returns the disk-backed copy, or the blob itself if there is no cache. */
async function writeCached(file, blob) {
  const dir = await cacheDir();
  if (!dir) return blob;
  try {
    const key = keyOf(file);
    const handle = await dir.getFileHandle(key, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    markOpened(key);
    let total = 0;
    for (const e of await cacheEntries()) {
      const drop = e.key !== key && (modelOf(e.key) === modelOf(key) || total + e.size > CACHE_LIMIT);
      if (drop) {
        await dir.removeEntry(e.key);
        markOpened(e.key, false);
      } else {
        total += e.size;
      }
    }
    return await handle.getFile();
  } catch (err) {
    console.warn('Could not cache the converted model', err);
    return blob;
  }
}

// ------------------------------------------------------------- conversion

/**
 * Converts an IFC: the property index, then the geometry, each in a Web
 * Worker of its own that is terminated when done. web-ifc never returns its
 * heap, so terminating is the only way to give it back, and doing the two in
 * one worker held both heaps at once.
 * @param {(stage: 'index'|'geometry', pct: number, detail?: object|string) => void} [onProgress]
 * @returns {Promise<{ frag: Uint8Array, index: object, ms: number }>}
 */
export async function convertIfc(file, ruleset, opts = {}) {
  const t0 = performance.now();
  const { index } = await runJob('index', file, ruleset, opts);
  const { frag } = await runJob('geometry', file, ruleset, opts);
  return { frag, index, ms: performance.now() - t0 };
}

function runJob(job, file, ruleset, { onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    const finish = (fn, v) => {
      worker.terminate();
      if (signal) signal.removeEventListener('abort', abort);
      fn(v);
    };
    const abort = () => finish(reject, new DOMException('Conversion cancelled', 'AbortError'));
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort);
    }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.stage, data.pct, data.detail);
      else if (data.type === 'done') finish(resolve, data);
      else if (data.type === 'error') finish(reject, new Error(data.message));
    };
    worker.onerror = (e) => finish(reject, new Error(e.message || 'The conversion worker failed to start'));
    worker.postMessage({
      job,
      file,
      ruleset: { entities: ruleset.entities, entityDisplay: ruleset.entityDisplay },
      wasmPath: WASM_PATH,
    });
  });
}

/**
 * A converted model for an IFC: from the cache if this revision was converted
 * under the same rules, otherwise converted now and cached.
 *
 * @param {File} file   the IFC as given (names the cache entry)
 * @param {() => Promise<{ source: File|Blob, header: object|null }>} prepare
 *   run only when a conversion is needed: what to convert (the IFC, or its
 *   arc-fixed copy) and readHeader(file), stored for reopening without the IFC
 * @returns {Promise<{ meta, frag, bundle: Blob, source: 'cache'|'converted', convertMs? }>}
 */
export async function largeModelFor(file, prepare, ruleset, opts = {}) {
  const sig = rulesetSignature(ruleset);
  const cached = await readCached(file);
  if (cached) {
    try {
      const { meta, frag } = await decodeBundle(cached);
      if (meta.rulesetSig === sig) return { meta, frag, bundle: cached, source: 'cache' };
    } catch (err) {
      console.warn(`Ignoring an unreadable cached copy of ${file.name}`, err);
    }
  }
  const { source, header } = await prepare();
  const { frag, index, ms } = await convertIfc(source, ruleset, opts);
  const meta = {
    sourceName: file.name,
    sourceSize: file.size,
    sourceModified: file.lastModified || 0,
    created: new Date().toISOString(),
    rulesetSig: sig,
    // What the index covers, so a check needing more knows it is missing.
    entities: [...ruleset.entities],
    header,
    index: serialiseIndex(index),
  };
  const bundle = await writeCached(file, await encodeBundle(meta, frag));
  return { meta, frag, bundle, source: 'converted', convertMs: ms };
}

/** Opens a saved .rspfrag. `stale` is true when it was indexed under other rules. */
export async function openBundle(file, ruleset) {
  const { meta, frag } = await decodeBundle(file);
  return { meta, frag, bundle: file, stale: meta.rulesetSig !== rulesetSignature(ruleset) };
}

