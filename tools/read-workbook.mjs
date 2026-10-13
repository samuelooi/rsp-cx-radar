/**
 * read-workbook.mjs
 *
 * Reads the CORENET X industry mapping workbook into the same rule objects
 * tools/build-ifcsg-rules.ps1 writes to data/ifcsg-rules.json. It is a port of
 * that script's parsing, so the two must agree; tools/split-mapping.mjs checks
 * this against ifcsg-rules.json whenever both are given.
 *
 * No dependencies: the zip is opened with the app's own reader (js/bcf/zip.js,
 * which needs Node 18+ for Blob and DecompressionStream) and the sheet XML is
 * read with regular expressions, which is enough for the plain cells Excel writes.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readZip } from '../js/bcf/zip.js';

const NA = new Set(['n.a', 'n.a.', 'na', 'n/a', '-', '']);

/** Collapses whitespace; null for blank and for the workbook's "N.A" markers. */
export function norm(s) {
  if (s === null || s === undefined) return null;
  const v = String(s).replace(/\s+/g, ' ').trim();
  return NA.has(v.toLowerCase()) ? null : v;
}

const placeholder = (s) => !!s && /please refer to (property sets|properties) below/i.test(s);

const xmlText = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/** "*FOO, BAR" -> two subtypes; a leading * marks a USERDEFINED name carried on ObjectType. */
export function parseSubtypes(s) {
  const v = norm(s);
  if (!v) return [];
  if (/^all subtypes listed in cop$/i.test(v)) return [{ value: null, userDefined: false, anySubtype: true }];
  const out = [];
  for (const part of v.split(',')) {
    let p = part.trim();
    if (!p || NA.has(p.toLowerCase())) continue;
    const ud = p.startsWith('*');
    if (ud) p = p.slice(1).trim();
    out.push({ value: p, userDefined: ud, anySubtype: false });
  }
  return out;
}

function parseGateway(s) {
  const v = norm(s);
  if (!v) return null;
  if (/^(DG|DESIGN( GATEWAY)?)$/i.test(v)) return 'design';
  if (/^(CG|CONSTRUCTION( GATEWAY)?)$/i.test(v)) return 'construction';
  throw new Error(`Unrecognised Gateway value '${s}'. Expected DG or CG.`);
}

/** Enumeration, a pointer to the Space Values sheet, or a free-text constraint. */
export function parseAccepted(s) {
  const v = norm(s);
  if (!v) return { kind: 'any', values: [], note: null };
  if (/refer to space values sheet/i.test(v)) return { kind: 'spaceValues', values: [], note: v };
  if (/^true\s*\/\s*false$/i.test(v)) return { kind: 'boolean', values: ['TRUE', 'FALSE'], note: null };
  if (/^any positive number$/i.test(v)) return { kind: 'positiveNumber', values: [], note: v };
  return { kind: 'enum', values: v.split(',').map((x) => x.trim()).filter(Boolean), note: null };
}

/** Each row as a string[] indexed by real column position, so blank cells do not shift later ones. */
function readSheet(xml, shared) {
  const rows = [];
  for (const [, body] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const m of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1];
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)[1];
      let idx = 0;
      for (const ch of ref) idx = idx * 26 + (ch.charCodeAt(0) - 64);
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const inner = m[2] || '';
      let v = '';
      if (type === 'inlineStr') {
        v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join('');
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vm) v = xmlText(vm[1]);
        if (type === 's' && v !== '') v = shared[Number(v)];
      }
      cells[idx - 1] = v;
    }
    rows.push(Array.from(cells, (c) => c ?? ''));
  }
  return rows;
}

/**
 * @param {string} path      the .xlsx
 * @param {{disciplines?: string[]}} [opts]  rows to keep by Suggested Discipline; empty keeps all
 * @returns {Promise<{meta: object, rules: object[], spaceValues: Object<string, Array<{value, scope}>>, skipped: Object<string, number>}>}
 */
export async function readWorkbook(path, { disciplines = [] } = {}) {
  const entries = new Map((await readZip(readFileSync(path))).map((e) => [e.name, new TextDecoder().decode(e.data)]));

  const shared = [];
  for (const [, si] of (entries.get('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push([...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(''));
  }

  // Find sheets by name, not by position.
  const rels = new Map([...entries.get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/>/g)]
    .map(([, a]) => [/Id="([^"]+)"/.exec(a)[1], /Target="([^"]+)"/.exec(a)[1]]));
  const sheetFile = (name) => {
    for (const [, a] of entries.get('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/>/g)) {
      if (xmlText(/name="([^"]+)"/.exec(a)[1]) !== name) continue;
      const target = rels.get(/r:id="([^"]+)"/.exec(a)[1]).replace(/^\/?xl\//, '');
      return entries.get('xl/' + target);
    }
    throw new Error(`Sheet '${name}' not found in ${basename(path)}.`);
  };

  const rows = readSheet(sheetFile('CX Pilot Mapping'), shared);
  const header = rows[0].map((h) => String(h).replace(/\s+/g, ' ').trim().toLowerCase());
  const wanted = {
    sn: ['S/N'], agency: ['Agency'], gateway: ['RSP_Gateway', 'Gateway'],
    rspPriority: ['RSP_Priority'], rspCategory: ['RSP_Category'], rspTypology: ['RSP_Typology'],
    component: ['Identified Component'], parameter: ['Identified parameters'],
    revit: ['Suggested Revit'], discipline: ['Suggested Discipline'],
    entity: ['IFC4 Entities'], subtypes: ['IFC Sub Types'],
    pset: ['Property Set'], prop: ['Property Name'], dataType: ['Property Type'],
    unit: ['Property Unit'], materialSet: ['IFC4 Material Set'],
    accepted: ['Accepted Values'], sample: ['Sample Value'],
  };
  const optional = new Set(['rspPriority', 'rspCategory', 'rspTypology', 'revit', 'gateway']);
  const col = {};
  for (const [key, labels] of Object.entries(wanted)) {
    for (const label of labels) {
      const i = header.findIndex((h) => h.startsWith(label.toLowerCase()));
      if (i >= 0) { col[key] = i; break; }
    }
    if (col[key] === undefined && !optional.has(key)) throw new Error(`Column '${labels[0]}' not found on the CX Pilot Mapping sheet.`);
  }
  const cell = (r, key) => (col[key] === undefined ? '' : r[col[key]] ?? '');

  const rules = [];
  const skipped = {};
  for (const r of rows.slice(1)) {
    const entity = norm(cell(r, 'entity'));
    if (!entity) continue;
    const disc = norm(cell(r, 'discipline'));
    if (disciplines.length && !disciplines.includes(disc)) {
      skipped[disc || '(none)'] = (skipped[disc || '(none)'] || 0) + 1;
      continue;
    }
    const declaresOnly = placeholder(cell(r, 'pset')) || placeholder(cell(r, 'prop'));
    const pset = declaresOnly ? null : norm(cell(r, 'pset'));
    const prop = declaresOnly ? null : norm(cell(r, 'prop'));
    const agency = norm(cell(r, 'agency'));
    rules.push({
      sn: norm(cell(r, 'sn')),
      agency: agency ? agency.toUpperCase() : agency,
      gateway: parseGateway(cell(r, 'gateway')),
      rspPriority: norm(cell(r, 'rspPriority')),
      rspCategory: norm(cell(r, 'rspCategory')),
      rspTypology: norm(cell(r, 'rspTypology')),
      component: norm(cell(r, 'component')),
      parameter: norm(cell(r, 'parameter')),
      discipline: disc,
      entity,
      subtypes: parseSubtypes(cell(r, 'subtypes')),
      kind: pset && prop ? 'requirement' : 'subtype',
      pset,
      prop,
      dataType: norm(cell(r, 'dataType')),
      unit: norm(cell(r, 'unit')),
      materialSet: norm(cell(r, 'materialSet')),
      accepted: parseAccepted(cell(r, 'accepted')),
      sample: norm(cell(r, 'sample')),
      revit: norm(cell(r, 'revit')),
    });
  }

  const spaceValues = {};
  for (const r of readSheet(sheetFile('Space Values'), shared).slice(1)) {
    const p = norm(r[0]); const v = norm(r[1]); const scope = norm(r[2]);
    if (!p || !v) continue;
    (spaceValues[p] ||= []).push({ value: v, scope });
  }
  const sortedSpaceValues = Object.fromEntries(Object.keys(spaceValues).sort().map((k) => [k, spaceValues[k]]));

  return {
    meta: { source: basename(path), sheet: 'CX Pilot Mapping', disciplines: disciplines.length ? disciplines : ['all'] },
    rules,
    spaceValues: sortedSpaceValues,
    skipped,
  };
}
