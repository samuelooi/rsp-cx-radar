/**
 * Patches a quadratic lookup in @thatopen/fragments 3.4.7's IFC importer.
 *
 * While building the spatial tree, the importer finds each contained
 * element's position with `this.expressIDs.indexOf(id)`: a linear search of
 * every item in the model, once per element. On a 779 MB test file that
 * step alone took about 19 of the 22 minutes. This swaps it for a Map built
 * once (rebuilt only if the list has grown), keeping indexOf's
 * first-match result. Run after `npm install` (it is the postinstall step);
 * it is a no-op once applied or if the library changes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('@thatopen/fragments'));
const BEFORE = 'const entityIndex = this.expressIDs.indexOf(relatedID);';
const AFTER = 'if (this.__idxLen !== this.expressIDs.length) { this.__idx = new Map(); this.expressIDs.forEach((id, i) => { if (!this.__idx.has(id)) this.__idx.set(id, i); }); this.__idxLen = this.expressIDs.length; } const entityIndex = this.__idx.has(relatedID) ? this.__idx.get(relatedID) : -1; /* rsp-patched */';

for (const name of ['index.mjs', 'index.cjs']) {
  const file = join(dist, name);
  const src = readFileSync(file, 'utf8');
  if (src.includes('/* rsp-patched */')) { console.log(`${name}: already patched`); continue; }
  const n = src.split(BEFORE).length - 1;
  if (n !== 1) { console.log(`${name}: expected 1 match, found ${n}; left unchanged`); continue; }
  writeFileSync(file, src.replace(BEFORE, AFTER));
  console.log(`${name}: patched`);
}
