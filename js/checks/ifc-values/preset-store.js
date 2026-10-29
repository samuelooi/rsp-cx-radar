/**
 * Where value presets live: data/value-presets.json, written by hand and shared
 * through git. The app only reads it, so any static host serves it.
 *
 * Which presets run is session state, not part of the file: each starts ticked
 * as the file's `enabled` says, the check menu toggles it, and a project file
 * records and restores the ticks.
 */

import { normalisePreset, validatePreset, presetEntity } from './presets.js';

const URL_ = 'data/value-presets.json';

/** @type {import('./presets.js').ValuePreset[]} */
let presets = [];
/** Presets in the file that cannot run, with why, so the menu can say so. */
let invalid = [];
let loading = null;
const listeners = new Set();

/**
 * Loads the shared presets once per session. Safe to call repeatedly.
 * @returns {Promise<import('./presets.js').ValuePreset[]>}
 */
export function loadPresets() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(URL_, { cache: 'no-cache' });
      if (!res.ok) return presets;
      const doc = await res.json();
      const list = doc && Array.isArray(doc.presets) ? doc.presets : [];
      const seen = new Set();
      for (const raw of list) {
        const p = normalisePreset(raw);
        const problem = validatePreset(p) || (seen.has(p.id) ? `duplicate id "${p.id}"` : null);
        if (problem) {
          invalid.push({ name: p.name || p.id, problem });
          continue;
        }
        seen.add(p.id);
        presets.push(p);
      }
      if (invalid.length) console.warn('Value presets skipped:', invalid);
    } catch (err) {
      console.warn('data/value-presets.json could not be read:', err);
    }
    return presets;
  })();
  return loading;
}

/** The presets as loaded, with their current ticks. */
export function currentPresets() {
  return presets;
}

/** Presets in the file that were skipped, as `{name, problem}`. */
export function invalidPresets() {
  return invalid;
}

/** The ones the IFC values check should run. */
export function enabledPresets() {
  return presets.filter((p) => p.enabled);
}

/** Ticks or unticks one preset for this session. */
export function setPresetEnabled(id, enabled) {
  setEnabledPresets(new Set(presets.filter((p) => (p.id === id ? enabled : p.enabled)).map((p) => p.id)));
}

/** Ticks exactly the presets named, by id; ids the file lacks are ignored. */
export function setEnabledPresets(ids) {
  const want = ids instanceof Set ? ids : new Set(ids);
  if (presets.every((p) => p.enabled === want.has(p.id))) return;
  presets = presets.map((p) => ({ ...p, enabled: want.has(p.id) }));
  for (const fn of listeners) fn(presets);
}

/** Upper-case entities the presets select, so the model indexer keeps them. */
export function presetEntities() {
  return [...new Set(presets.map(presetEntity).filter(Boolean))];
}

/** Called with the new list whenever the ticks change. Returns an unsubscribe function. */
export function onPresetsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
