/**
 * Converts an IFC file to a That Open Fragments file (.frag), offline.
 *
 *   cd poc/fragments && npm install
 *   node convert.mjs "<model.ifc>" ["<out.frag>"]
 *
 * The IFC is read in 1 MB chunks (OpenModelFromCallback) rather than loaded
 * whole, so the file itself is never held in memory twice. Prints the time
 * each stage took and the peak memory, so large models can be sized up
 * before anyone tries them in a browser.
 */

import { openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import * as FRAGS from '@thatopen/fragments';

const [, , input, outArg] = process.argv;
if (!input) {
  console.error('Usage: node convert.mjs <model.ifc> [out.frag]');
  process.exit(1);
}
const output = outArg || input.replace(/\.ifc$/i, '') + '.frag';

const require = createRequire(import.meta.url);
const wasmDir = dirname(require.resolve('web-ifc/web-ifc-node.wasm')) + '/';

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

const importer = new FRAGS.IfcImporter();
importer.wasm = { path: wasmDir, absolute: true };

const size = statSync(input).size;
const fd = openSync(input, 'r');
const CHUNK = 1 << 20;
const buffer = new Uint8Array(CHUNK);
const readCallback = (offset) => {
  const n = readSync(fd, buffer, 0, CHUNK, offset);
  return buffer.slice(0, n);
};

const t0 = Date.now();
const stages = {};
let last = null;
const out = await importer.process({
  readFromCallback: true,
  readCallback,
  progressCallback: (progress, data) => {
    const key = data && data.process;
    if (!key) return;
    if (data.state === 'start') stages[key] = { start: Date.now() };
    if (data.state === 'finish' && stages[key]) stages[key].ms = Date.now() - stages[key].start;
    const pct = Math.round(progress * 100);
    if (pct !== last && pct % 10 === 0) {
      last = pct;
      process.stdout.write(`\r${pct}% ${key}…        `);
    }
  },
});
closeSync(fd);
const total = Date.now() - t0;
writeFileSync(output, out);
// The OS's high-water mark: a timer cannot sample while the converter is busy.
const peakRss = process.resourceUsage().maxRSS * 1024;

console.log(`\n${basename(input)} (${mb(size)}) -> ${basename(output)} (${mb(out.byteLength)})`);
for (const [k, v] of Object.entries(stages)) if (v.ms != null) console.log(`  ${k.padEnd(11)} ${(v.ms / 1000).toFixed(1)} s`);
console.log(`  total       ${(total / 1000).toFixed(1)} s, peak memory ${mb(peakRss)}`);
