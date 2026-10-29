/**
 * Value presets — the user's own property queries, run alongside the mapping.
 *
 * The CORENET X mapping says which properties must exist and which values it
 * accepts. A preset says something the mapping does not: "every fire door on
 * this job has FireRating 60", "no wall is left with a blank Mark". Each one is
 * a selector (which elements) plus a condition (what one property must satisfy).
 *
 * Everything here is pure: index and preset in, results out. Presets are
 * written by hand in data/value-presets.json and read by preset-store.js; the
 * check menu's list of them is preset-editor.js.
 */

import {
  canonicalEntity, getValue, findPset, formatValue, isEmptyValue,
} from '../../ifcsg.js';

/**
 * @typedef {object} ValuePreset
 * @property {string} id        Stable; a project file records ticks by it. Defaults to a slug of the name.
 * @property {string} name
 * @property {string} entity    IFC entity, e.g. "IfcDoor". Standard-case variants fold onto it.
 * @property {string} subtype   Comma-separated PredefinedType / ObjectType values; '' for any.
 * @property {string} pset
 * @property {string} prop
 * @property {string} op        One of OPS.
 * @property {string} value     Operand; a comma-separated list for 'one-of'.
 * @property {boolean} enabled  Whether the IFC values check runs it.
 */

/** Conditions a property can be tested against, in menu order. */
export const OPS = [
  { id: 'exists', label: 'exists', needsValue: false },
  { id: 'not-empty', label: 'has a value', needsValue: false },
  { id: 'equals', label: 'equals', needsValue: true },
  { id: 'not-equals', label: 'does not equal', needsValue: true },
  { id: 'one-of', label: 'is one of', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'matches', label: 'matches pattern', needsValue: true },
  { id: 'gt', label: '>', needsValue: true, numeric: true },
  { id: 'gte', label: '≥', needsValue: true, numeric: true },
  { id: 'lt', label: '<', needsValue: true, numeric: true },
  { id: 'lte', label: '≤', needsValue: true, numeric: true },
];

const OP_BY_ID = new Map(OPS.map((o) => [o.id, o]));

/** Outcomes of testing one element. Everything but PASS is a failure. */
export const RESULT = {
  PASS: 'pass',
  MISSING: 'missing',     // the property set or the property is not on the element
  FAIL: 'fail',           // present, but the condition does not hold
};

export const RESULT_LABEL = {
  [RESULT.PASS]: 'Meets preset',
  [RESULT.MISSING]: 'Property missing',
  [RESULT.FAIL]: 'Does not meet preset',
};

export const RESULT_COLOUR = {
  [RESULT.PASS]: 0x5aa65a,
  [RESULT.MISSING]: 0xc4563c,
  [RESULT.FAIL]: 0xd4a13c,
};

const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const splitList = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** Fills defaults and drops unknown fields, so stored data has one shape. */
export function normalisePreset(p) {
  return {
    id: String(p.id || slug(p.name)),
    name: String(p.name || '').trim(),
    entity: String(p.entity || '').trim(),
    subtype: String(p.subtype || '').trim(),
    pset: String(p.pset || '').trim(),
    prop: String(p.prop || '').trim(),
    // An op the file misspells is kept as written so validatePreset reports it.
    op: p.op ? String(p.op).trim() : 'exists',
    value: String(p.value == null ? '' : p.value).trim(),
    enabled: p.enabled !== false,
  };
}

function slug(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Why a preset cannot run, or null when it can. */
export function validatePreset(p) {
  if (!p.name) return 'no name';
  if (!p.id) return 'no id';
  if (!p.entity) return 'no entity';
  if (!/^ifc[a-z0-9]+$/i.test(p.entity)) return `"${p.entity}" is not an IFC entity name`;
  if (!p.pset) return 'no pset';
  if (!p.prop) return 'no prop';
  const op = OP_BY_ID.get(p.op);
  if (!op) return `unknown op "${p.op}"`;
  if (op.needsValue && p.value === '') return `op "${op.id}" needs a value`;
  if (op.numeric && !Number.isFinite(Number(p.value))) return `op "${op.id}" needs a number`;
  if (p.op === 'matches') {
    try {
      new RegExp(p.value, 'i');
    } catch (err) {
      return `the pattern is not valid: ${err.message}`;
    }
  }
  return null;
}

/** Upper-case canonical entity the preset selects, e.g. 'IFCDOOR'. */
export function presetEntity(p) {
  return canonicalEntity(p.entity);
}

/** Does the preset's selector pick out this element? */
export function matchesPreset(el, p) {
  if (el.canonicalEntity !== presetEntity(p)) return false;
  const subtypes = splitList(p.subtype).map(norm);
  return !subtypes.length ||
    subtypes.includes(norm(el.predefinedType)) || subtypes.includes(norm(el.objectType));
}

/** Elements the preset's selector picks out, before any condition is tested. */
export function selectPresetElements(index, p) {
  const bucket = (index && index.byEntity.get(presetEntity(p))) || [];
  return bucket.filter((el) => matchesPreset(el, p));
}

/**
 * Tests one element against a preset's condition.
 * @returns {{result: string, value: *, detail: string}}
 */
export function testElement(el, p) {
  const op = OP_BY_ID.get(p.op) || OP_BY_ID.get('exists');
  if (!findPset(el, p.pset)) {
    return { result: RESULT.MISSING, value: undefined, detail: `no ${p.pset}` };
  }
  const value = getValue(el, p.pset, p.prop);
  if (value === undefined) {
    return { result: RESULT.MISSING, value, detail: `no ${p.prop}` };
  }
  if (op.id === 'exists') return { result: RESULT.PASS, value, detail: '' };

  const empty = isEmptyValue(value);
  const text = formatValue(value).trim();
  const expected = p.value;
  let ok;

  switch (op.id) {
    case 'not-empty': ok = !empty; break;
    case 'equals': ok = !empty && norm(text) === norm(expected); break;
    case 'not-equals': ok = norm(text) !== norm(expected); break;
    case 'one-of': ok = !empty && splitList(expected).map(norm).includes(norm(text)); break;
    case 'contains': ok = !empty && norm(text).includes(norm(expected)); break;
    case 'matches': {
      try {
        ok = !empty && new RegExp(expected, 'i').test(text);
      } catch {
        ok = false;
      }
      break;
    }
    default: {
      const n = Number(text);
      const m = Number(expected);
      if (empty || !Number.isFinite(n)) {
        return { result: RESULT.FAIL, value, detail: 'not a number' };
      }
      ok = op.id === 'gt' ? n > m : op.id === 'gte' ? n >= m : op.id === 'lt' ? n < m : n <= m;
    }
  }

  return ok
    ? { result: RESULT.PASS, value, detail: '' }
    : { result: RESULT.FAIL, value, detail: empty ? 'empty' : `is ${text}` };
}

/**
 * Runs one preset over the index.
 * @returns {{preset: ValuePreset, elements: object[], rows: Array, byResult: Object<string, object[]>}}
 */
export function runPreset(index, p) {
  const elements = selectPresetElements(index, p);
  const rows = [];
  const byResult = { [RESULT.PASS]: [], [RESULT.MISSING]: [], [RESULT.FAIL]: [] };
  for (const el of elements) {
    const r = testElement(el, p);
    rows.push({ element: el, ...r });
    byResult[r.result].push(el);
  }
  return { preset: p, elements, rows, byResult };
}

/** One-line reading of a preset, e.g. `IfcDoor [FIREDOOR] · Pset_DoorCommon.FireRating = 60`. */
export function describePreset(p) {
  const op = OP_BY_ID.get(p.op);
  const sel = p.entity + (p.subtype ? ` [${p.subtype}]` : '');
  const cond = op
    ? `${op.label}${op.needsValue ? ' ' + p.value : ''}`
    : p.op;
  return `${sel} · ${p.pset}.${p.prop} ${cond}`;
}
