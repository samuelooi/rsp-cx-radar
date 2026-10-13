/**
 * split-mapping.mjs
 *
 * One-off migration: splits the generated ruleset (data/ifcsg-rules.json,
 * built from the CORENET X workbook) into four plain tables that say each
 * fact once, plus a list of the inconsistencies found on the way.
 *
 *   node tools/split-mapping.mjs
 *
 * Writes data/mapping/{element-types,properties,value-lists,requirements}.csv
 * and data/mapping/REVIEW.md. The CSVs are UTF-8 with a byte-order mark and
 * CRLF line endings so Excel opens them correctly.
 *
 * Before writing anything it rebuilds every rule from the tables and compares
 * it with the original, so a split that would lose information fails loudly.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = JSON.parse(readFileSync(join(root, 'data/ifcsg-rules.json'), 'utf8'));
const outDir = join(root, 'data/mapping');

const review = []; // [section, lines[]]
const note = (section, line) => {
  let s = review.find((x) => x[0] === section);
  if (!s) review.push((s = [section, []]));
  s[1].push(line);
};

const mostCommon = (values) => {
  const n = new Map();
  for (const v of values) n.set(v, (n.get(v) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const byText = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

// ------------------------------------------------------------- element types
// An id the workbook's own users read at a glance: entity, then the subtype
// with the workbook's `*` marking a USERDEFINED name carried on ObjectType.
// No subtype, or "all subtypes in COP", is the bare entity.
const typeId = (entity, s) => (!s || s.anySubtype ? entity : `${entity}.${s.userDefined ? '*' : ''}${s.value}`);
const typesOf = (r) => (r.subtypes.length ? r.subtypes.map((s) => typeId(r.entity, s)) : [r.entity]);

const types = new Map();
for (const r of src.rules) {
  for (const s of r.subtypes.length ? r.subtypes : [null]) {
    const id = typeId(r.entity, s);
    if (types.has(id)) continue;
    types.set(id, {
      type_id: id,
      entity: r.entity,
      subtype: s && !s.anySubtype ? s.value : '',
      name_in_ifc: !s || s.anySubtype ? 'any subtype'
        : s.userDefined ? 'ObjectType (PredefinedType = USERDEFINED)' : 'PredefinedType',
      notes: s && s.anySubtype ? 'Workbook says "all subtypes in COP"; checked as any subtype.' : '',
    });
  }
}
const anyCop = src.rules.filter((r) => r.subtypes.some((s) => s.anySubtype)).map((r) => r.sn);
if (anyCop.length) {
  note('Read this first', `${anyCop.length} rows (S/N ${anyCop.join(', ')}) say "all subtypes in COP". The checker has always treated that the same as no subtype, so they point at the bare entity (e.g. IfcWindow).`);
}

// ---------------------------------------------------------------- properties
const reqRows = src.rules.filter((r) => r.kind === 'requirement');

// Property-set names differ only in case in places (SGPSet_ vs SGPset_). The
// checker matches them case-insensitively, so they are one property set: keep
// the spelling used most.
const psetSpelling = new Map();
{
  const groups = new Map();
  for (const r of reqRows) {
    const k = r.pset.toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.pset);
  }
  for (const [k, names] of groups) {
    const keep = mostCommon(names);
    psetSpelling.set(k, keep);
    const others = [...new Set(names)].filter((n) => n !== keep);
    if (others.length) {
      const sns = reqRows.filter((r) => others.includes(r.pset)).map((r) => r.sn);
      note('Spelling', `Property set spelled ${[keep, ...others].map((n) => `\`${n}\``).join(' and ')}. Kept \`${keep}\`; S/N ${sns.join(', ')} used the other spelling. The checker ignores case, so nothing changes.`);
    }
  }
}
const propId = (r) => `${psetSpelling.get(r.pset.toLowerCase())}.${r.prop}`;

// ---------------------------------------------------------------- value lists
// Every distinct accepted-value list becomes a named list. Space Values lists
// keep their workbook names. Enumerations are named after their property; a
// different list for the same property gets the RSP category (or the
// component) appended, so the name says where it is used.
const lists = new Map(); // name -> { values: [{value, scope}], source }
const listByKey = new Map(); // values joined -> name
for (const [name, values] of Object.entries(src.spaceValues)) {
  lists.set(name, { values: values.map((v) => ({ value: v.value, scope: v.scope || '' })), source: 'Space Values sheet' });
  const seen = new Map();
  for (const v of values) {
    const k = `${v.value}|${v.scope || ''}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) note('Value lists', `\`${name}\` lists "${k.split('|')[0]}"${k.split('|')[1] ? ` (scope ${k.split('|')[1]})` : ''} ${n} times.`);
}
const squash = (s) => String(s).replace(/[^A-Za-z0-9]/g, '');

const enumListName = (r) => {
  const key = r.accepted.values.join('\u0001');
  if (listByKey.has(key)) return listByKey.get(key);
  const component = squash(r.component.replace(/\(.*?\)/g, ''));
  const candidates = [r.prop, `${r.prop}_${squash(r.rspCategory || component)}`, `${r.prop}_${component}`];
  let name = candidates.find((c) => !lists.has(c));
  for (let i = 2; !name; i++) if (!lists.has(`${candidates[1]}_${i}`)) name = `${candidates[1]}_${i}`;
  lists.set(name, { values: r.accepted.values.map((value) => ({ value, scope: '' })), source: 'Accepted Values column' });
  listByKey.set(key, name);
  return name;
};

/** The list a requirement row accepts, by name; '' for none. */
const listOf = (r) => {
  switch (r.accepted.kind) {
    case 'enum': return enumListName(r);
    case 'spaceValues': return r.prop;
    case 'positiveNumber': return 'POSITIVE_NUMBER';
    default: return ''; // 'any', and 'boolean', which follows from the Boolean data type
  }
};

// One row per property. Its default list is the one most of its requirement
// rows use; a row that accepts something else names that list as an override.
const props = new Map();
const rowsByProp = new Map();
for (const r of reqRows) {
  const id = propId(r);
  if (!rowsByProp.has(id)) rowsByProp.set(id, []);
  rowsByProp.get(id).push(r);
}
for (const [id, rows] of rowsByProp) {
  const r0 = rows[0];
  const lst = rows.map(listOf);
  const samples = rows.map((r) => r.sample).filter(Boolean);
  const mats = rows.map((r) => r.materialSet).filter(Boolean);
  props.set(id, {
    prop_id: id,
    pset: psetSpelling.get(r0.pset.toLowerCase()),
    property: r0.prop,
    data_type: r0.dataType || '',
    unit: r0.unit || '',
    // On a tie, the authority's Space Values list wins over a row's own list.
    value_list: (lst.includes(r0.prop) && lists.get(r0.prop)?.source === 'Space Values sheet' &&
      lst.filter((l) => l === r0.prop).length >= lst.filter((l) => l === mostCommon(lst)).length
      ? r0.prop : mostCommon(lst)) || '',
    material_set: mostCommon(mats) || '',
    sample: mostCommon(samples) || '',
    notes: '',
  });
  const types_ = new Set(rows.map((r) => `${r.dataType || ''}|${r.unit || ''}`));
  if (types_.size > 1) note('Data types and units', `\`${id}\` has more than one data type or unit: ${[...types_].join('; ')}.`);
  const distinct = [...new Set(lst)];
  if (distinct.length > 1) {
    const p = props.get(id);
    const parts = distinct.map((l) => `${l || '(no list)'} on S/N ${rows.filter((r) => listOf(r) === l).map((r) => r.sn).join(', ')}`);
    note('Accepted values that disagree', `\`${id}\`: ${parts.join('; ')}. Default set to \`${p.value_list || '(no list)'}\`; the other rows name their list as an override. Decide whether they should really differ.`);
  }
  if (new Set(mats).size > 1 || (mats.length && mats.length < rows.length)) {
    note('Material set', `\`${id}\`: the IFC4 Material Set column is "${mostCommon(mats)}" on ${mats.length} of ${rows.length} rows and blank on the rest. Set to "${mostCommon(mats)}" for the property.`);
  }
}

// -------------------------------------------------------------- requirements
const GATE = { design: 'DG', construction: 'CG' };
const requirements = src.rules.map((r) => {
  const isReq = r.kind === 'requirement';
  const id = isReq ? propId(r) : '';
  const lst = isReq ? listOf(r) : '';
  const p = isReq ? props.get(id) : null;
  const extra = [];
  if (!isReq && (r.pset || r.prop)) {
    extra.push(`Workbook also gives ${[r.pset && `property set ${r.pset}`, r.prop && `name ${r.prop}`].filter(Boolean).join(' and ')}; not checked.`);
  }
  return {
    sn: r.sn,
    agency: r.agency,
    gateway: GATE[r.gateway] || r.gateway,
    rsp_priority: r.rspPriority || '',
    rsp_category: r.rspCategory || '',
    rsp_typology: r.rspTypology || '',
    component: r.component,
    parameter: r.parameter || '',
    discipline: r.discipline || '',
    element_types: typesOf(r).join('; '),
    property: id,
    value_list_override: p && lst !== p.value_list ? lst || 'NONE' : '',
    sample: p && r.sample && r.sample !== p.sample ? r.sample : '',
    notes: extra.join(' '),
    _src: r,
  };
});

// Rows that look like a copy slip: the label names one property, the row maps
// another that the label also names elsewhere.
for (const q of requirements) {
  const r = q._src;
  if (!r.parameter || !r.prop) continue;
  const label = squash(r.parameter).toLowerCase();
  const prop = squash(r.prop).toLowerCase();
  if (label === prop) continue;
  const twin = requirements.find((o) => o !== q && o._src.component === r.component && o._src.prop &&
    squash(o._src.prop).toLowerCase() === label && squash(o._src.parameter || '').toLowerCase() === prop &&
    o.element_types === q.element_types);
  if (twin && Number(q.sn) < Number(twin.sn)) {
    note('Labels that look swapped', `S/N ${q.sn} is labelled "${r.parameter}" but maps \`${r.prop}\`, and S/N ${twin.sn} is labelled "${twin._src.parameter}" but maps \`${twin._src.prop}\` (${r.component}, ${q.element_types}). Both properties are still checked; only the labels are crossed.`);
  }
}

const snCount = new Map();
for (const q of requirements) snCount.set(q.sn, (snCount.get(q.sn) || 0) + 1);
for (const [sn, n] of snCount) {
  if (n > 1) note('Duplicate S/N', `S/N ${sn} is used by ${n} rows: ${requirements.filter((q) => q.sn === sn).map((q) => `"${q.parameter}" (${q.property})`).join(', ')}.`);
}

// Values the authority's own lists disagree on.
for (const q of requirements) {
  const r = q._src;
  if (r.kind !== 'requirement' || r.accepted.kind !== 'enum' || !src.spaceValues[r.prop]) continue;
  const sv = new Set(src.spaceValues[r.prop].map((v) => v.value.toLowerCase()));
  const missing = r.accepted.values.filter((v) => !sv.has(v.toLowerCase()));
  if (missing.length) {
    note('Values not in the Space Values list', `S/N ${q.sn} (${r.component}) accepts ${missing.map((v) => `"${v}"`).join(', ')} for \`${r.prop}\`, which the Space Values list for ${r.prop} does not contain.`);
  }
}
for (const p of props.values()) {
  if (p.data_type === 'Integer' && /\d\.\d/.test(p.sample)) {
    note('Samples that contradict the data type', `\`${p.prop_id}\` is Integer but its sample is "${p.sample}".`);
  }
  if (/^0\.\d{6,}$/.test(p.sample)) {
    note('Samples that contradict the data type', `\`${p.prop_id}\` sample "${p.sample}" looks like an Excel time value that leaked into the text.`);
  }
}

// ------------------------------------------------------------- round trip
// Rebuild each rule from the tables alone and compare with the original.
{
  const pIndex = new Map([...props.values()].map((p) => [p.prop_id, p]));
  const tIndex = new Map([...types.values()].map((t) => [t.type_id, t]));
  const accepted = (name, prop) => {
    if (!name || name === 'NONE') return { kind: prop.data_type === 'Boolean' ? 'boolean' : 'any', values: [] };
    if (name === 'POSITIVE_NUMBER') return { kind: 'positiveNumber', values: [] };
    const l = lists.get(name);
    if (l.source === 'Space Values sheet') return { kind: 'spaceValues', values: [] };
    return { kind: 'enum', values: l.values.map((v) => v.value) };
  };
  const canon = (r) => JSON.stringify({
    sn: r.sn, agency: r.agency, gateway: r.gateway, p: r.rspPriority || '', c: r.rspCategory || '', t: r.rspTypology || '',
    component: r.component, parameter: r.parameter || '', discipline: r.discipline || '',
    types: typesOf(r).sort(), kind: r.kind,
    pset: r.kind === 'requirement' ? r.pset.toLowerCase() : '', prop: r.kind === 'requirement' ? r.prop : '',
    dataType: r.kind === 'requirement' ? r.dataType || '' : '', unit: r.kind === 'requirement' ? r.unit || '' : '',
    acc: r.kind === 'requirement' ? { kind: r.accepted.kind, values: r.accepted.kind === 'enum' ? r.accepted.values : [] } : null,
  });
  const rebuilt = requirements.map((q) => {
    for (const t of q.element_types.split('; ')) if (!tIndex.has(t)) throw new Error(`Unknown element type ${t}`);
    const p = q.property ? pIndex.get(q.property) : null;
    const types_ = q.element_types.split('; ').sort();
    return JSON.stringify({
      sn: q.sn, agency: q.agency, gateway: q.gateway === 'DG' ? 'design' : 'construction', p: q.rsp_priority, c: q.rsp_category,
      t: q.rsp_typology, component: q.component, parameter: q.parameter, discipline: q.discipline, types: types_,
      kind: p ? 'requirement' : 'subtype', pset: p ? p.pset.toLowerCase() : '', prop: p ? p.property : '',
      dataType: p ? p.data_type : '', unit: p ? p.unit : '',
      acc: p ? accepted(q.value_list_override || p.value_list, p) : null,
    });
  });
  const bad = src.rules.filter((r, i) => canon(r) !== rebuilt[i]);
  if (bad.length) {
    console.error(`Round trip failed for ${bad.length} rows, e.g. S/N ${bad[0].sn}:`);
    console.error(canon(bad[0]));
    console.error(rebuilt[src.rules.indexOf(bad[0])]);
    process.exit(1);
  }
  console.log(`Round trip OK: all ${src.rules.length} rows rebuild from the tables.`);
}

// ------------------------------------------------------------------ write
const csv = (rows, cols) => '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => {
  const v = String(r[c] ?? '');
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}).join(','))].join('\r\n') + '\r\n';

mkdirSync(outDir, { recursive: true });
const sortedTypes = [...types.values()].sort((a, b) => byText(a.entity, b.entity) || byText(a.subtype, b.subtype));
writeFileSync(join(outDir, 'element-types.csv'), csv(sortedTypes, ['type_id', 'entity', 'subtype', 'name_in_ifc', 'notes']));

const sortedProps = [...props.values()].sort((a, b) => byText(a.pset, b.pset) || byText(a.property, b.property));
writeFileSync(join(outDir, 'properties.csv'), csv(sortedProps,
  ['prop_id', 'pset', 'property', 'data_type', 'unit', 'value_list', 'material_set', 'sample', 'notes']));

const listRows = [];
const used = new Set([...props.values()].map((p) => p.value_list).concat(requirements.map((q) => q.value_list_override)));
for (const [name, l] of [...lists.entries()].sort((a, b) => byText(a[0], b[0]))) {
  if (!used.has(name)) note('Value lists', `\`${name}\` (from the ${l.source}) is not used by any property row in the ARC/External Works scope. Kept for completeness.`);
  for (const v of l.values) listRows.push({ list: name, value: v.value, scope: v.scope, source: l.source });
}
writeFileSync(join(outDir, 'value-lists.csv'), csv(listRows, ['list', 'value', 'scope', 'source']));

const sortedReqs = requirements.slice().sort((a, b) =>
  byText(a.rsp_category || '~', b.rsp_category || '~') || byText(a.component, b.component) ||
  byText(a.element_types, b.element_types) || byText(a.agency, b.agency) || byText(a.property, b.property) || byText(a.sn, b.sn));
writeFileSync(join(outDir, 'requirements.csv'), csv(sortedReqs, ['sn', 'agency', 'gateway', 'rsp_priority', 'rsp_category',
  'rsp_typology', 'component', 'parameter', 'discipline', 'element_types', 'property', 'value_list_override', 'sample', 'notes']));

const counts = `${types.size} element types, ${props.size} properties, ${new Set(listRows.map((r) => r.list)).size} value lists, ${requirements.length} requirements`;
const order = ['Read this first', 'Accepted values that disagree', 'Values not in the Space Values list', 'Labels that look swapped',
  'Duplicate S/N', 'Spelling', 'Material set', 'Samples that contradict the data type', 'Data types and units', 'Value lists'];
review.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
writeFileSync(join(outDir, 'REVIEW.md'), [
  '# Mapping review',
  '',
  `Things found while splitting \`data/ifcsg-rules.json\` (from \`${src.meta.source}\`, generated ${src.meta.generated}) into the four tables: ${counts}.`,
  '',
  `Only the ${src.meta.disciplines.join(' and ')} rows are here: the build script leaves the other disciplines out of the ruleset.`,
  '',
  'Nothing below changes what the checker does today. Each item is a decision for you: fix the table, or leave it and delete the item.',
  '',
  ...review.flatMap(([title, lines]) => [`## ${title}`, '', ...lines.map((l) => `- ${l}`), '']),
].join('\n'));

console.log(`Wrote ${counts} to data/mapping/.`);
