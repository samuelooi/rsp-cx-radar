/**
 * The model hierarchy tree and element search on the Model tab.
 *
 * Both work from the property index (see ifc-index.js), so they behave the same
 * for a model parsed in the tab and one opened through Fragments, and they list
 * exactly the elements the rest of the app can colour, hide and inspect. An
 * element the mapping does not cover is never indexed, so it is not here either.
 *
 * The tree reads the way a submission is organised: file, then storey (lowest
 * first), then IFC class, then the elements. A geometry-less aggregate (a stair)
 * holds the parts that draw it, rather than each part appearing on its own.
 */

import { formatValue } from './ifcsg.js';

const NO_STOREY = '(no storey)';

/** What an element is called in a list: its name, plus a room's long name. */
export function elementLabel(el) {
  const name = el.name || el.tag || `#${el.expressID}`;
  return el.longName && el.longName !== name ? `${name} · ${el.longName}` : name;
}

const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });

/**
 * @typedef {object} TreeNode
 * @property {string} id        stable across rebuilds, so expanded nodes stay open
 * @property {string} label
 * @property {string} [sub]     secondary text, e.g. a storey's elevation
 * @property {object} [element] the indexed element, on a leaf or an aggregate
 * @property {object[]} elements every element at or below this node
 * @property {TreeNode[]} children
 */

/**
 * @param {Map<number, object>} indexes  modelID -> that model's own index
 * @param {Map<number, string>} names    modelID -> file name
 * @returns {TreeNode[]} one root per model
 */
export function buildModelTree(indexes, names) {
  const roots = [];
  for (const [modelID, idx] of indexes) {
    const keyOf = (el) => el.key;

    // Parts of an aggregate are listed under it, not beside it.
    const partsOf = new Map();
    for (const el of idx.all) {
      if (el.hostKey && idx.byId.has(el.hostKey)) {
        if (!partsOf.has(el.hostKey)) partsOf.set(el.hostKey, []);
        partsOf.get(el.hostKey).push(el);
      }
    }
    const leaf = (el, parentId) => {
      const id = `${parentId}/${keyOf(el)}`;
      const parts = (partsOf.get(el.key) || []).map((p) => leaf(p, id)).sort(byLabel);
      return {
        id,
        label: elementLabel(el),
        sub: parts.length ? `${el.entity} · ${parts.length} part${parts.length > 1 ? 's' : ''}` : '',
        element: el,
        elements: [el, ...parts.flatMap((p) => p.elements)],
        children: parts,
      };
    };

    // Storeys in elevation order. A name used twice keeps the lower one's place.
    const elevation = new Map();
    for (const s of idx.storeys || []) {
      if (s.name != null && !elevation.has(s.name)) elevation.set(s.name, s.elevation);
    }
    const byStorey = new Map();
    for (const s of [...elevation.keys()]) byStorey.set(s, new Map());
    for (const el of idx.all) {
      if (el.hostKey && idx.byId.has(el.hostKey)) continue;
      const s = el.storey || NO_STOREY;
      if (!byStorey.has(s)) byStorey.set(s, new Map());
      const classes = byStorey.get(s);
      if (!classes.has(el.entity)) classes.set(el.entity, []);
      classes.get(el.entity).push(el);
    }

    const rootId = `m${modelID}`;
    const storeyNodes = [...byStorey.entries()]
      .map(([storey, classes]) => {
        const sid = `${rootId}/s:${storey}`;
        const classNodes = [...classes.entries()].map(([entity, els]) => {
          const cid = `${sid}/c:${entity}`;
          const children = els.map((el) => leaf(el, cid)).sort(byLabel);
          return {
            id: cid, label: entity, children,
            elements: children.flatMap((c) => c.elements),
          };
        }).sort(byLabel);
        const elev = elevation.get(storey);
        return {
          id: sid,
          label: storey,
          sub: Number.isFinite(elev) ? `${formatElevation(elev)}` : '',
          elevation: Number.isFinite(elev) ? elev : Infinity,
          children: classNodes,
          elements: classNodes.flatMap((c) => c.elements),
        };
      })
      .filter((n) => n.elements.length)
      .sort((a, b) => a.elevation - b.elevation || byLabel(a, b));

    roots.push({
      id: rootId,
      label: names.get(modelID) || `Model ${modelID}`,
      sub: '',
      children: storeyNodes,
      elements: storeyNodes.flatMap((n) => n.elements),
    });
  }
  return roots;
}

/** Millimetres, as the index stores them, shown in metres the way levels are named. */
function formatElevation(mm) {
  const m = mm / 1000;
  return `${m >= 0 ? '+' : ''}${m.toFixed(2)} m`;
}

// --------------------------------------------------------------------- search

/** The attributes searched every time, with the label a match on them reports. */
const FIELDS = [
  ['name', 'Name'],
  ['longName', 'LongName'],
  ['globalId', 'GlobalId'],
  ['tag', 'Tag'],
  ['entity', 'Class'],
  ['objectType', 'ObjectType'],
  ['predefinedType', 'PredefinedType'],
  ['typeName', 'Type'],
  ['description', 'Description'],
  ['storey', 'Storey'],
];

/**
 * Elements matching every word of `query`, case-insensitively. A word can match
 * any attribute, the file name, or (with `properties`) a property set, property
 * name or value, so "L02 door fire" finds the fire-rated doors on level 2.
 *
 * @param {object[]} elements
 * @param {string} query
 * @param {{properties?: boolean, modelName?: (el: object) => string, limit?: number}} [opts]
 * @returns {{results: {element: object, matched: string[]}[], total: number}}
 */
export function searchElements(elements, query, { properties = false, modelName = () => '', limit = 300 } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], total: 0 };

  const results = [];
  let total = 0;
  for (const el of elements) {
    // Each searchable string once, with what it is, so a hit can say where it was.
    const hay = [];
    for (const [k, label] of FIELDS) {
      const v = el[k];
      if (v != null && v !== '') hay.push([String(v).toLowerCase(), label, String(v)]);
    }
    const file = modelName(el);
    if (file) hay.push([file.toLowerCase(), 'File', file]);
    if (properties) {
      for (const [pset, props] of Object.entries(el.psets || {})) {
        for (const [prop, value] of Object.entries(props || {})) {
          const shown = formatValue(value);
          hay.push([`${pset}.${prop} ${prop} ${shown}`.toLowerCase(), `${pset}.${prop}`, String(shown)]);
        }
      }
    }

    const matched = [];
    let all = true;
    for (const w of words) {
      const hit = hay.find(([text]) => text.includes(w));
      if (!hit) { all = false; break; }
      // The name is the row's own title; repeating it as a match says nothing.
      if (hit[1] !== 'Name' && !matched.some((m) => m.startsWith(hit[1]))) {
        matched.push(hit[1].includes('.') || hit[1] === 'GlobalId' || hit[1] === 'Tag'
          ? `${hit[1]} = ${hit[2]}` : hit[1]);
      }
    }
    if (!all) continue;
    total++;
    if (results.length < limit) results.push({ element: el, matched });
  }
  results.sort((a, b) => elementLabel(a.element).localeCompare(elementLabel(b.element), undefined,
    { numeric: true, sensitivity: 'base' }));
  return { results, total };
}
