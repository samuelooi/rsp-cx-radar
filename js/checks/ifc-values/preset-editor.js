/**
 * The value-preset list, shown under the IFC values check in the check menu.
 *
 * It is a custom check input (see types.js): the shell mounts it into a host
 * element and asks it for its value when the check runs. Presets are written
 * by hand in data/value-presets.json; here they can only be ticked for the
 * session and shown in 3D, which colours what a preset picks out.
 */

import {
  RESULT, RESULT_LABEL, RESULT_COLOUR, describePreset, selectPresetElements, runPreset,
} from './presets.js';
import {
  loadPresets, currentPresets, invalidPresets, enabledPresets, setPresetEnabled, presetEntities,
} from './preset-store.js';
import { esc } from '../../util/dom.js';

/**
 * @typedef {object} EditorApi  What the shell lends the list.
 * @property {() => object|null} index              Merged model index, or null.
 * @property {(canon: string) => boolean} isIndexed  Whether the indexer collects an entity.
 * @property {(canon: string) => void} requireEntity Asks the indexer to collect it from the next load.
 * @property {(groups: object[], title: string, subtitle?: string) => void} showInModel
 * @property {(message: string) => void} toast
 */

/** Entities the presets need, so they are indexed before any model loads. */
export async function requiredEntities() {
  await loadPresets();
  return presetEntities();
}

/** What the IFC values check receives as its `presets` input. */
export function value() {
  return enabledPresets();
}

/**
 * Renders into `host`. Called again on every menu redraw.
 * @param {HTMLElement} host
 * @param {EditorApi} api
 */
export async function mount(host, api) {
  host.innerHTML = '<div class="cm-help">Loading presets…</div>';
  await loadPresets();
  if (!host.isConnected) return;
  render(host, api);
}

function render(host, api) {
  const presets = currentPresets();
  const invalid = invalidPresets();
  const index = api.index();

  host.innerHTML = `
    <div class="vp">
      ${presets.length ? `<div class="vp-list">${presets.map((p) => {
        const n = index ? selectPresetElements(index, p).length : null;
        return `
        <div class="vp-row" data-id="${esc(p.id)}">
          <input type="checkbox" data-act="toggle" title="Run with the IFC values check"
            ${p.enabled ? 'checked' : ''} />
          <span class="vp-text">
            <span class="vp-name">${esc(p.name)}${n === null ? '' : ` <span class="cm-chip">${n}</span>`}</span>
            <small>${esc(describePreset(p))}</small>
          </span>
          <button class="btn sm" data-act="show" title="Show what this preset selects"
            ${index ? '' : 'disabled'}>3D</button>
        </div>`;
      }).join('')}</div>` : '<div class="cm-help">No value presets in <code>data/value-presets.json</code>.</div>'}
      ${invalid.length ? `<div class="cm-help vp-warn">Skipped from the file: ${invalid.map((x) =>
        `${esc(x.name)} (${esc(x.problem)})`).join('; ')}</div>` : ''}
    </div>`;

  host.querySelectorAll('.vp-row').forEach((row) => {
    const preset = currentPresets().find((p) => p.id === row.dataset.id);
    if (!preset) return;
    row.querySelector('[data-act="toggle"]').addEventListener('change', (e) => {
      setPresetEnabled(preset.id, e.target.checked);
    });
    row.querySelector('[data-act="show"]').addEventListener('click', (e) => {
      e.preventDefault();
      showPassFail(api, preset);
    });
  });
}

function showPassFail(api, preset) {
  const index = api.index();
  if (!index) {
    api.toast('Load an IFC model first.');
    return;
  }
  const r = runPreset(index, preset);
  if (!r.elements.length) {
    api.toast(`No ${preset.entity}${preset.subtype ? ' [' + preset.subtype + ']' : ''} elements in the loaded model.`);
    return;
  }
  api.showInModel(
    [RESULT.PASS, RESULT.FAIL, RESULT.MISSING].map((code) => ({
      label: RESULT_LABEL[code],
      colour: RESULT_COLOUR[code],
      elements: r.byResult[code],
    })),
    preset.name,
    `${describePreset(preset)} · ${r.elements.length} element${r.elements.length === 1 ? '' : 's'}`,
  );
}
