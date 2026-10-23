/**
 * Getting a .frag for a model: from the cache if this revision was converted
 * before, otherwise by converting the IFC in a Web Worker and caching the
 * result.
 *
 * The cache lives in the browser's private file system (OPFS), so a .frag is
 * read from disk on demand rather than held in memory. It keeps one entry per
 * model name (a new revision replaces the old), evicts the least recently
 * opened entries past CACHE_LIMIT, and can be cleared. The key here is the
 * file's name, size and modified time; the app will key on js/model-id.js.
 */

const CACHE_DIR = 'frag-cache';
const CACHE_LIMIT = 2 * 1024 ** 3;
const WORKER_URL = new URL('./convert-worker.mjs', import.meta.url);
const WASM_PATH = new URL('./vendor/web-ifc/', import.meta.url).href;

const safe = (s) => s.replace(/[^\w.-]+/g, '_');
const keyOf = (file) => `${safe(file.name)}__${file.size}__${file.lastModified || 0}.frag`;
const modelOf = (key) => key.split('__')[0];

// When each entry was last opened, so eviction goes by use rather than by when
// it was converted. Kept in localStorage: losing it only makes eviction fall
// back to conversion time.
const OPENED_KEY = 'frag-cache-opened';
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
  // Without this the browser may clear the cache whenever it likes (the
  // Claude app's browser pane emptied it overnight). It can still say no.
  if (!persistAsked && navigator.storage.persist) {
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Every cached .frag: [{ key, size, opened }], most recently opened first. */
export async function cacheEntries() {
  const dir = await cacheDir();
  if (!dir) return [];
  const opened = openedTimes();
  const out = [];
  for await (const [key, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !key.endsWith('.frag')) continue;
    const f = await handle.getFile();
    out.push({ key, size: f.size, opened: opened[key] || f.lastModified });
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

async function readCached(file) {
  const dir = await cacheDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(keyOf(file));
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    markOpened(keyOf(file));
    return bytes;
  } catch {
    return null;
  }
}

async function writeCached(file, bytes) {
  const dir = await cacheDir();
  if (!dir) return;
  try {
    const key = keyOf(file);
    const writable = await (await dir.getFileHandle(key, { create: true })).createWritable();
    await writable.write(bytes);
    await writable.close();
    markOpened(key);
    // One revision per model, then the least recently opened out past the limit.
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
  } catch (err) {
    console.warn('Could not cache the .frag', err);
  }
}

/**
 * Converts an IFC in a Web Worker. The worker is terminated afterwards, which
 * hands back the converter's wasm heap in one go. Abort through `signal`.
 * @returns {Promise<{ bytes: Uint8Array, ms: number }>}
 */
export function convertIfc(file, { onProgress = () => {}, signal } = {}) {
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
      if (data.type === 'progress') onProgress(data.progress, data.process, data.class);
      else if (data.type === 'done') finish(resolve, { bytes: data.bytes, ms: data.ms });
      else if (data.type === 'error') finish(reject, new Error(data.message));
    };
    worker.onerror = (e) => finish(reject, new Error(e.message || 'The conversion worker failed to start'));
    worker.postMessage({ file, wasmPath: WASM_PATH });
  });
}

/**
 * The .frag for a file: read directly if it is one, from the cache if this
 * revision was converted before, otherwise converted and cached.
 * @returns {Promise<{ bytes: Uint8Array, source: 'frag'|'cache'|'converted', convertMs?: number }>}
 */
export async function fragFor(file, opts = {}) {
  if (/\.frag$/i.test(file.name)) return { bytes: new Uint8Array(await file.arrayBuffer()), source: 'frag' };
  const cached = await readCached(file);
  if (cached) return { bytes: cached, source: 'cache' };
  const { bytes, ms } = await convertIfc(file, opts);
  await writeCached(file, bytes);
  return { bytes, source: 'converted', convertMs: ms };
}
