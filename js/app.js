/**
 * RSP CX Radar — application wiring.
 *
 * Presets come straight from the CORENET X industry mapping: every component the
 * agencies query for becomes a clickable target, and every property they require
 * becomes a colour-by-value query underneath it.
 *
 * Several IFC files can be open at once and are treated as one federated model;
 * elements are identified by `modelID:expressID` throughout.
 */

import { Viewer } from './viewer.js';
import { buildIndex, mergeIndexes, reviveIndex } from './ifc-index.js';
import { largeModelFor, openBundle, BUNDLE_EXT } from './frag/store.js';
import { flattenArcs } from './ifc-arc-fix.js';
import { computeWarnings } from './warnings.js';
import { MeasureTool } from './measure.js';
import { DASHBOARD_ENTITIES, computeDashboard, formatValue as fmtNum, METRICS as DASHBOARD_METRICS } from './dashboard.js';
import { measure, project as projectMemory, formatBytes, LEVEL } from './memory.js';
import {
  loadRuleset, selectElements, groupByValue, runCheck, evaluate, getValue,
  describeSubtypes, matchesTarget, formatValue, isEmptyValue,
  STATUS, STATUS_LABEL, GATEWAY, GATEWAY_ORDER, GATEWAY_LABEL, AGENCY_ALL, appliesToAgency,
} from './ifcsg.js';
import { buildTransform } from './geo/georef.js';
import { parseCadastralGeoJson } from './geo/geojson.js';
import * as registry from './checks/registry.js';
import { runChecks, totalsOf } from './checks/runner.js';
import {
  SEVERITY, SEVERITY_LABEL, SEVERITY_COLOUR, SEVERITY_ORDER, worstOf,
} from './checks/severity.js';
import { esc, hex } from './util/dom.js';
import {
  FORMAT as PROJECT_FORMAT, VERSION as PROJECT_VERSION, emptyProject, parseProject,
  looksLikeProjectFile, fingerprint, labelOf, saveToDisk, openFromDisk,
  rememberProject, lastProject, clearLastProject,
} from './project.js';
import {
  loadPresets, currentPresets, enabledPresets, savePresets, canSave,
} from './checks/ifc-values/preset-store.js';
import * as WebIFC from 'web-ifc';
import { WASM_PATH } from './viewer.js';
import { scanFile } from './ifc-text.js';
import { buildModelTree, searchElements, elementLabel } from './model-tree.js';
import { IfcEditor } from './ifc-edit/editor.js';
import {
  readBcf, writeBcf, newTopic, newComment, newViewpoint, touch as touchTopic,
} from './bcf/bcf.js';
import { buildReadinessReport } from './report/report.js';
import { renderGuide, focusGuide } from './guide/guide.js';
import { renderFeedback, installErrorLog } from './feedback/feedback.js';
import {
  readHeader, buildIdentity, bestMatch, compareRevision, describeIdentity, MATCH,
} from './model-id.js';

// ---------------------------------------------------------------------- colours

/** Categorical palette, tuned for readability against the dark canvas. */
const PALETTE = [
  0x4fa3d1, 0xe0a458, 0x77b255, 0xc06c84, 0x6c8ebf, 0xd68f5e,
  0x8fbf6c, 0xa384c4, 0x5fb3a3, 0xd4785e, 0x7f9cd1, 0xbfa76c,
];
const MISSING_COLOUR = 0xd16a4f;   // same hue as --danger: an unset value is a gap
const SINGLE_COLOUR = 0x4fa3d1;

/** Where the selected checks are remembered between sessions. */
const SELECTION_KEY = 'rsp-ifcsg.checks';

// ------------------------------------------------------------------------ state

let ruleset = null;
let viewer = null;

/** modelID -> per-model index, merged into `index` for all queries. */
const indexes = new Map();
/** modelID -> what that file *is* (see model-id.js), read from its header and spatial ids. */
const identities = new Map();
let index = null;
/**
 * modelID -> the entities the indexer was asked for when that model loaded. An
 * entity requested later (a new value preset) is missing from models already open.
 */
const indexedWith = new Map();

/** target.id -> element count in the loaded models. */
const counts = new Map();

/**
 * The active query: a component group (one agency + component, with every
 * workbook selector that names it), and optionally one property under one of
 * its entities. `entity` and `req` are null while the whole component is shown.
 */
let selection = null;      // { group, entity, req }
let legend = [];           // [{ label, colour, elements, missing }]
let soloIndex = -1;
let contextMode = 'ghost'; // 'ghost' | 'hidden' | 'normal'

/** Results of the last run, one entry per selected check. */
let checkOutcomes = [];
/** Why those results no longer describe the model (an edit, a scope change), or null. */
let resultsStale = null;
/** Check ids the user has ticked in the menu. */
let selectedChecks = new Set();
/** "<checkId>.<inputId>" -> the value the user supplied (a string, or {name, text}). */
const checkInputs = new Map();
/** "<checkId>.<inputId>" -> loaded module for a `kind: 'custom'` input. */
const customInputModules = new Map();
let checkRunning = false;
/** How the View Context tool names each mode in its hover card. */
const CONTEXT_LABEL = { ghost: 'ghosted', hidden: 'hidden', normal: 'normal' };
/** The rail button whose hover card is showing, if any. */
let railTipFor = null;
/** Whether the check menu is unfolded; it folds away once there are results to read. */
let checkMenuOpen = true;
/** Results view shows only what needs fixing: no passing rows, clean rules or clean checks. */
let issuesOnly = false;
/** Aborts an in-flight run when the model changes or a new run starts. */
let checkAbort = null;

let measurer = null;      // the measure tool (js/measure.js), created with the viewer
let sectionArmed = false;  // a click on a model face places a new section cut
let planActive = null;     // { name, y } while a plan view is showing

// Query-tree hierarchy filters, macro to micro: Gateway narrows Authority
// narrows Component. A gateway is always selected — Construction by default,
// since it is checked for everything. '' means "all" for the authority tier.
let gatewayFilter = GATEWAY.CONSTRUCTION;
let agencyFilter = '';
// RSP_Priority, below Authority: RSP's own triage, set per workbook row. '' = all.
let priorityFilter = '';

// Visibility policy. The viewer holds the resulting set; these two own the intent.
const manualHidden = new Set();   // element keys hidden via the context menu
/**
 * While an isolate is on: modelID -> the expressIDs left drawing. manualHidden
 * only reaches indexed elements, so this is what hides the geometry the mapping
 * never indexed. Only the models open at the time are isolated; one loaded
 * afterwards shows in full.
 * @type {Map<number, Set<number>>|null}
 */
let isolation = null;
let spacesVisible = false;        // IfcSpace volumes obscure everything by default

// --------------------------------------------------------------------- elements

const $ = (id) => document.getElementById(id);
const el = {
  filename: $('filename'), modelPicker: $('model-picker'),
  btnOpenEmpty: $('btn-open-empty'),
  fileInput: $('file-input'), dropzone: $('dropzone'),
  loading: $('loading'), barFill: $('bar-fill'), loadingLabel: $('loading-label'), loadingCancel: $('loading-cancel'),
  toast: $('toast'), left: $('left'), models: $('models'),
  gwBubbles: $('gw-bubbles'), agencyBubbles: $('agency-bubbles'), priorityBubbles: $('priority-bubbles'), priorityTier: $('priority-tier'),
  fSearch: $('f-search'), fPresent: $('f-present'),
  tree: $('tree'), legend: $('legend'), legendTitle: $('legend-title'), legendRows: $('legend-rows'),
  btnClearQuery: $('btn-clear-query'),
  checkMenu: $('check-menu'), checkMenuBar: $('check-menu-bar'),
  checkMenuBarText: $('check-menu-bar-text'), checkMenuBarAct: $('check-menu-bar-act'),
  btnRunCheck: $('btn-run-check'), btnColourStatus: $('btn-colour-status'),
  summary: $('summary'), issues: $('issues'),
  panel: $('panel'), panelBody: $('panel-body'), panelClose: $('panel-close'),
  toolCollapse: $('tool-collapse'), toolGhost: $('tool-ghost'), toolSpaces: $('tool-spaces'),
  toolShowAll: $('tool-showall'), toolFit: $('tool-fit'),
  toolSection: $('tool-section'), toolMeasure: $('tool-measure'), toolLevels: $('tool-levels'),
  sectionsBar: $('sections-bar'), levelsPanel: $('levels-panel'), planBadge: $('plan-badge'),
  toolSurvey: $('tool-survey'), railTip: $('rail-tip'),
  ctxmenu: $('ctxmenu'),
  btnDash: $('btn-dash'), dash: $('dash'), dashBody: $('dash-body'),
  dashSub: $('dash-sub'), dashSeg: $('dash-seg'), dashClose: $('dash-close'),
  mem: $('mem'), memFill: $('mem-fill'), memVal: $('mem-val'),
  projectPicker: $('project-picker'), projectChip: $('project-chip'), projectPanel: $('project-panel'),
  startProjects: $('start-projects'),
  btnSetValue: $('btn-set-value'), legendEdit: $('legend-edit'),
  mtSearch: $('mt-search'), mtProps: $('mt-props'), mtBody: $('mt-body'),
  editsBar: $('edits-bar'), editsText: $('edits-text'),
  btnDiscardEdits: $('btn-discard-edits'), btnExportIfc: $('btn-export-ifc'),
  btnToBcf: $('btn-to-bcf'), btnReport: $('btn-report'), btnBcfImport: $('btn-bcf-import'), btnBcfNew: $('btn-bcf-new'),
  btnBcfExport: $('btn-bcf-export'), bcfInput: $('bcf-input'), bcfAuthor: $('bcf-author'),
  bcfList: $('bcf-list'), bcfDetail: $('bcf-detail'),
  warnCount: $('warn-count'), warnSummary: $('warn-summary'), warnList: $('warn-list'),
};

/** Which breakdown the dashboard cards show: 'level' | 'file' | 'none'. */
let dashBreakdown = 'level';

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('visible'), 5200);
}

function setProgress(pct, label) {
  el.barFill.style.width = Math.min(pct, 100) + '%';
  if (label) el.loadingLabel.textContent = label;
}

// ---------------------------------------------------------------------- memory

/** Set once the meter enters the danger band, so the warning fires once per crossing. */
let memoryWarned = false;

/** Refreshes the top-bar memory meter from the current estimate. */
function renderMemory() {
  if (!viewer) return;
  const m = measure(viewer);
  const pct = Math.min(100, Math.round(m.ratio * 100));

  el.memFill.style.width = pct + '%';
  el.memVal.textContent = `${formatBytes(m.total)} / ${formatBytes(m.budget)}`;
  el.mem.classList.toggle('warn', m.level === LEVEL.WARN);
  el.mem.classList.toggle('danger', m.level === LEVEL.DANGER);
  el.mem.title = [
    `Estimated tab memory: ${formatBytes(m.total)} of a ${formatBytes(m.budget)} budget (${pct}%)`,
    `Geometry buffers: ${formatBytes(m.geometry)}`,
    `web-ifc wasm heap: ${formatBytes(m.wasm)}`,
    m.jsHeap === null
      ? 'JavaScript heap: not reported by this browser'
      : `JavaScript heap: ${formatBytes(m.jsHeap)}`,
    '',
    'Geometry and wasm figures are exact. The ceiling is a budget rather than a',
    'hard limit; override it with ?membudget=<GiB> in the URL.',
  ].join('\n');

  if (m.level === LEVEL.DANGER) {
    if (!memoryWarned) {
      memoryWarned = true;
      toast(`Memory is at ${pct}% of the ${formatBytes(m.budget)} budget. ` +
        'Close a model before adding more, or the browser tab may run out of memory.');
    }
  } else {
    memoryWarned = false;
  }
}

// ------------------------------------------------------------------------- boot

async function init() {
  installErrorLog();
  viewer = new Viewer($('viewer-container'));
  measurer = new MeasureTool(viewer);
  viewer.onPick(onPick);
  viewer.onContextMenu(openContextMenu);

  wireUI();
  renderMemory();
  // The JS heap moves on its own, so keep the meter live rather than event-driven.
  setInterval(renderMemory, 2000);

  selectedChecks = loadSelection();
  renderCheckMenu();

  try {
    ruleset = await loadRuleset();

    // The model is walked once and the parsed IFC is released straight after, so
    // every entity any feature might want has to be declared before indexing.
    // The dashboard reports on entities the architectural ruleset does not cover
    // (refuse capacity lives on IfcTank, which is MEP), and a check that has not
    // been loaded yet still declares its entities in the registry manifest.
    for (const e of DASHBOARD_ENTITIES) ruleset.entities.add(e);
    for (const e of registry.requiredEntities()) ruleset.entities.add(e);
    // Custom inputs can ask for entities too (a value preset on IfcTank), and
    // those are only known once their saved data has loaded.
    await loadCustomInputs();

    // The element inspector reads live pass/fail from this module, so it is
    // fetched at boot rather than on first run. It is small, and not awaiting it
    // keeps it off the critical path. Every other check stays lazy.
    registry.load('ifc-values').then(renderCheckMenu).catch((err) => {
      console.error('The IFC values check could not be loaded:', err);
    });

    refreshFilters();
    await restoreLastProject();
  } catch (err) {
    console.error(err);
    el.tree.innerHTML =
      `<div class="empty-note">Could not load <code>data/ifcsg-rules.json</code>.<br><br>
       This page must be served over http:// (not opened as a file). Run a static
       server from the project folder, then reload.</div>`;
    toast('IFC-SG ruleset could not be loaded — queries are unavailable.');
  }
}

/** Loads every custom check input and indexes the entities they declare. */
async function loadCustomInputs() {
  await Promise.all(registry.customInputs().map(async ({ key, input }) => {
    try {
      const mod = await input.load();
      customInputModules.set(key, mod);
      if (typeof mod.requiredEntities === 'function') {
        for (const e of await mod.requiredEntities()) ruleset.entities.add(String(e).toUpperCase());
      }
    } catch (err) {
      // One broken input must not stop the ruleset from loading.
      console.error(`The "${input.label}" input could not be loaded:`, err);
    }
  }));
  renderCheckMenu();
}

/** What a custom check input may use. */
const customInputApi = {
  index: () => index,
  isIndexed: (canon) => indexedWith.size > 0 &&
    [...indexedWith.values()].every((set) => set.has(canon)),
  requireEntity: (canon) => {
    if (ruleset) ruleset.entities.add(canon);
  },
  showInModel: (...args) => shellActions.showInModel(...args),
  toast,
};

// -------------------------------------------------------------------- UI wiring

/**
 * Where each opened file came from, where the browser will say. A page is never
 * told a file's folder, but a handle to the file lets the save dialog for its
 * converted copy open in that same folder (see saveConverted).
 * @type {WeakMap<File, FileSystemFileHandle>}
 */
const sourceHandles = new WeakMap();

/**
 * Opens IFCs through the native picker where it exists, so their handles are
 * kept; anything else falls back to the plain file input.
 */
async function chooseModelFiles() {
  if (typeof window.showOpenFilePicker !== 'function') {
    el.fileInput.click();
    return;
  }
  let handles;
  try {
    handles = await window.showOpenFilePicker({
      multiple: true,
      types: [{ description: 'IFC model', accept: { 'application/octet-stream': ['.ifc', BUNDLE_EXT] } }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error(err);
    el.fileInput.click();
    return;
  }
  const files = await Promise.all(handles.map(async (h) => {
    const f = await h.getFile();
    sourceHandles.set(f, h);
    return f;
  }));
  if (files.length) loadFiles(files);
}

/**
 * The handles behind a drop. They have to be asked for while the drop event is
 * still running, so this starts them at once and pairs them up afterwards.
 */
function dropHandles(dataTransfer) {
  const pending = [...(dataTransfer.items || [])]
    .filter((i) => i.kind === 'file' && typeof i.getAsFileSystemHandle === 'function')
    .map((i) => i.getAsFileSystemHandle().catch(() => null));
  return Promise.all(pending).then((hs) => hs.filter((h) => h && h.kind === 'file'));
}

function wireUI() {
  el.btnOpenEmpty.addEventListener('click', () => chooseModelFiles());
  el.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) loadFiles([...e.target.files]);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('visible', 'dragover');
    });
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (e.target !== el.dropzone) return;
    el.dropzone.classList.remove('dragover');
    if (viewer.hasModels) el.dropzone.classList.remove('visible');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('dragover');
    if (viewer.hasModels) el.dropzone.classList.remove('visible');
    // A project file can ride along with the IFCs, or arrive on its own. It is
    // applied first so the gateway and check selection are in place before the
    // models index.
    const files = [...e.dataTransfer.files];
    const handles = dropHandles(e.dataTransfer);
    const isBcf = (f) => /\.(bcf|bcfzip)$/i.test(f.name);
    const projects = files.filter((f) => looksLikeProjectFile(f.name));
    const bcfs = files.filter(isBcf);
    const models = files.filter((f) => !looksLikeProjectFile(f.name) && !isBcf(f));
    if (projects.length) openProjectFile(projects[0]);
    for (const f of bcfs) importBcfFile(f);
    if (models.length) {
      // A drop holds one file per name, so the name pairs a handle with its file.
      handles.then((hs) => {
        for (const f of models) {
          const h = hs.find((x) => x.name === f.name);
          if (h) sourceHandles.set(f, h);
        }
      }).finally(() => loadFiles(models));
    }
  });

  wireProjectUI();

  el.panelClose.addEventListener('click', closeElementPanel);
  wirePanelResize();
  el.toolFit.addEventListener('click', () => viewer.fit());

  el.toolCollapse.addEventListener('click', () => el.left.classList.toggle('collapsed'));
  wireRailTips();

  el.toolGhost.addEventListener('click', () => {
    contextMode = contextMode === 'ghost' ? 'hidden' : contextMode === 'hidden' ? 'normal' : 'ghost';
    setRailState(el.toolGhost, `Now: ${CONTEXT_LABEL[contextMode]}`);
    el.toolGhost.classList.toggle('active', contextMode !== 'normal');
    viewer.setContextMode(contextMode);
  });
  el.toolGhost.classList.add('active');
  setRailState(el.toolGhost, `Now: ${CONTEXT_LABEL[contextMode]}`);

  el.toolSpaces.addEventListener('click', () => setSpacesVisible(!spacesVisible));
  el.toolShowAll.addEventListener('click', showAll);

  wireSectionTool();
  wireMeasureTool();
  wireLevelsTool();

  // A toggle: clears outlines that are drawn, otherwise draws the project's
  // cadastral lot (plus the site boundary, once a check has found it). With no
  // lot set, it opens project setup where the lot is added.
  el.toolSurvey.addEventListener('click', (e) => {
    if (viewer.hasSurveyOverlays) {
      viewer.clearSurveyOverlays();
      el.toolSurvey.classList.remove('active');
      refreshSurveyRail();
      return;
    }
    if (!viewer.hasModels) {
      toast('Load a model first — the lot is drawn against its georeferencing.');
      return;
    }
    const overlays = surveyOutlines();
    if (overlays.length) {
      shellActions.showSurvey(overlays);
      return;
    }
    // Keep this click from reaching the document listener that closes the panel.
    e.stopPropagation();
    openProjectPanel();
    toast('Add the cadastral lot GeoJSON in project setup to draw it.');
  });

  el.fPresent.addEventListener('change', refreshFilters);

  // The model name drops down the loaded-models list; with nothing loaded it
  // goes straight to the file picker instead.
  el.filename.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!viewer.hasModels) {
      chooseModelFiles();
      return;
    }
    if (el.modelPicker.classList.contains('open')) {
      el.modelPicker.classList.remove('open');
    } else {
      closeTopPanels('models');
      el.modelPicker.classList.add('open');
    }
  });
  el.models.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => el.modelPicker.classList.remove('open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.modelPicker.classList.remove('open');
  });
  let searchTimer;
  el.fSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshFilters, 140);
  });

  el.btnClearQuery.addEventListener('click', clearQuery);

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      el.left.classList.remove('collapsed');
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      showTab(b.dataset.tab);
    });
  });
  const help = $('tab-help');
  help.dataset.guide = 'queries';
  help.addEventListener('click', () => {
    focusGuide(help.dataset.guide);
    showTab('guide');
  });

  wireModelTab();

  el.btnRunCheck.addEventListener('click', doRunCheck);
  el.checkMenuBar.addEventListener('click', () => {
    checkMenuOpen = !checkMenuOpen;
    applyCheckMenuFold();
  });
  el.btnColourStatus.addEventListener('click', colourByStatus);
  el.btnToBcf.addEventListener('click', findingsToBcf);
  el.btnReport.addEventListener('click', makeReport);
  wireEditingUI();
  wireBcfUI();

  // The Dashboard button toggles, like the two pickers beside it.
  el.btnDash.addEventListener('click', () => {
    if (el.dash.classList.contains('visible')) closeDashboard();
    else openDashboard();
  });
  el.dashClose.addEventListener('click', closeDashboard);
  el.dashSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      el.dashSeg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      dashBreakdown = b.dataset.brk;
      renderDashboard();
    });
  });

  // Any left-click or Escape dismisses the context menu.
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeContextMenu();
    closeLevelsPanel();
    if (sectionArmed) setSectionArmed(false);
    // Escape drops a half-placed measurement first, then leaves the tool.
    if (measurer.active && !measurer.cancel()) setMeasureActive(false);
  });
}

// ------------------------------------------------------------ rail tooltips

/**
 * Hover cards for the tool rail: the tool's name and what it does, from the
 * button's data-tip / data-desc, plus its current state from data-state. These
 * replace the native title tooltip, which is slow to appear and one line long.
 */
function wireRailTips() {
  document.querySelectorAll('#rail .rail-btn[data-tip]').forEach((btn) => {
    btn.addEventListener('mouseenter', () => showRailTip(btn));
    btn.addEventListener('mouseleave', hideRailTip);
    // The levels list opens where the card sits; let it have the space.
    if (btn === el.toolLevels) btn.addEventListener('click', hideRailTip);
  });
}

function showRailTip(btn) {
  railTipFor = btn;
  const { tip, desc, state } = btn.dataset;
  el.railTip.innerHTML = `<b>${esc(tip)}</b>`
    + (desc ? `<span class="rt-desc">${esc(desc)}</span>` : '')
    + (state ? `<span class="rt-state">${esc(state)}</span>` : '');
  const r = btn.getBoundingClientRect();
  el.railTip.style.left = `${r.right + 8}px`;
  el.railTip.style.top = `${r.top + r.height / 2}px`;
  el.railTip.classList.add('visible');
}

function hideRailTip() {
  railTipFor = null;
  el.railTip.classList.remove('visible');
}

/** Updates a rail tool's state line, live if its card is showing. */
function setRailState(btn, text) {
  if (text) btn.dataset.state = text;
  else delete btn.dataset.state;
  if (railTipFor === btn) showRailTip(btn);
}

// ------------------------------------------------------------- section cuts

function setSectionArmed(on) {
  if (on && measurer.active) setMeasureActive(false);
  sectionArmed = on;
  el.toolSection.classList.toggle('active', on);
  setRailState(el.toolSection, on ? 'Placing cuts — click the tool again to stop' : '');
  if (!on) viewer.endSectionPreview();
  viewer.renderer.domElement.style.cursor = on ? 'crosshair' : '';
}

/**
 * Forma's section tool: a click on a face places a cut through it, snapped to
 * the nearest world axis; dragging an existing cut's handle slides it along
 * that axis. Anything else while armed still orbits and pans as usual, so the
 * camera can be moved between cuts without leaving the tool.
 */
function wireSectionTool() {
  el.toolSection.addEventListener('click', () => setSectionArmed(!sectionArmed));

  const canvas = viewer.renderer.domElement;
  let press = null; // where the left button went down, to tell a click from a drag
  // Capture phase, so this runs before OrbitControls' own pointerdown: a grab
  // on a handle is swallowed here and the camera never starts a gesture.
  canvas.addEventListener('pointerdown', (e) => {
    if (!sectionArmed || e.button !== 0) return;
    press = { x: e.clientX, y: e.clientY };
    if (viewer.grabSection(e) != null) e.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener('pointermove', (e) => {
    if (viewer.sectionDragging) viewer.dragSection(e);
  });

  // While armed, a faint plane follows the pointer to show where a click would
  // cut. One raycast per frame at most; none while a button is held (that is an
  // orbit or a drag), and none over a placed cut, where a click grabs instead.
  let previewEvent = null;
  canvas.addEventListener('pointermove', (e) => {
    if (!sectionArmed) return;
    if (!previewEvent) {
      requestAnimationFrame(() => {
        const ev = previewEvent;
        previewEvent = null;
        if (!sectionArmed) return;
        if (ev.buttons || viewer.sectionDragging || viewer.overSection(ev)) viewer.hideSectionPreview();
        else viewer.previewSection(viewer.raycastFace(ev), viewer.activeCamera.position);
      });
    }
    previewEvent = e;
  });
  canvas.addEventListener('pointerleave', () => viewer.hideSectionPreview());
  window.addEventListener('pointerup', (e) => {
    if (!press) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5;
    press = null;
    if (viewer.sectionDragging) {
      viewer.endSectionDrag();
      return;
    }
    if (moved || !sectionArmed) return; // an orbit, not a placement
    const face = viewer.raycastFace(e);
    if (!face) {
      toast('Click a face of the model to place a section cut.');
      return;
    }
    const id = viewer.addSectionAtFace(face, viewer.activeCamera.position);
    if (id != null) renderSectionsBar();
  });
}

// ------------------------------------------------------------------ measuring

function setMeasureActive(on) {
  if (on && sectionArmed) setSectionArmed(false);
  measurer.setActive(on);
  viewer.pickSuspended = on;
  el.toolMeasure.classList.toggle('active', on);
  setRailState(el.toolMeasure, on ? 'Measuring — click the tool again or press Esc to stop; measurements stay until cleared' : '');
}

/** The rail button and the M shortcut toggle Forma-style measuring (js/measure.js). */
function wireMeasureTool() {
  el.toolMeasure.addEventListener('click', () => setMeasureActive(!measurer.active));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!viewer.hasModels && !measurer.active) return;
    setMeasureActive(!measurer.active);
  });
}

function renderSectionsBar() {
  const list = viewer.sectionPlanes;
  if (!list.length) {
    el.sectionsBar.classList.remove('visible');
    el.sectionsBar.innerHTML = '';
    return;
  }
  el.sectionsBar.classList.add('visible');
  el.sectionsBar.innerHTML = `
    <div class="sb-head"><span>SECTION CUTS</span><span class="spacer"></span>
      <button data-act="clear">Clear all</button></div>
    ${list.map((s, i) => `
      <div class="sb-row" data-id="${s.id}">
        <span class="lbl">Section ${i + 1} <small>${s.axis.toUpperCase()} axis</small></span>
        <button data-act="flip" title="Flip cut side">&#8644;</button>
        <button data-act="remove" title="Remove">&times;</button>
      </div>`).join('')}`;

  el.sectionsBar.querySelector('[data-act="clear"]').addEventListener('click', () => {
    viewer.clearSectionPlanes();
    renderSectionsBar();
  });
  el.sectionsBar.querySelectorAll('.sb-row').forEach((row) => {
    const id = +row.dataset.id;
    row.querySelector('[data-act="flip"]').addEventListener('click', () => viewer.flipSectionPlane(id));
    row.querySelector('[data-act="remove"]').addEventListener('click', () => {
      viewer.removeSectionPlane(id);
      renderSectionsBar();
    });
  });
}

// -------------------------------------------------------------- plan / levels

/** Elements grouped by their storey name, from the currently merged index. */
function storeyGroups() {
  if (!index) return [];
  const map = new Map();
  for (const e of index.all) {
    if (!e.storey) continue;
    if (!map.has(e.storey)) map.set(e.storey, []);
    map.get(e.storey).push(e);
  }
  return [...map.entries()].map(([name, elements]) => ({ name, elements }));
}

/** Storeys with a sampled floor height, ordered top of the building first. */
function computeLevels() {
  return storeyGroups()
    .map((g) => ({ name: g.name, elements: g.elements, y: viewer.sampleFloorY(g.elements) }))
    .filter((g) => g.y !== null)
    .sort((a, b) => b.y - a.y);
}

function wireLevelsTool() {
  el.toolLevels.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.levelsPanel.classList.contains('visible')) closeLevelsPanel();
    else openLevelsPanel();
  });
  document.addEventListener('click', closeLevelsPanel);
}

function openLevelsPanel() {
  if (!index) {
    toast('Load an IFC model first.');
    return;
  }
  const levels = computeLevels();
  if (!levels.length) {
    toast('No building storeys with locatable elements were found.');
    return;
  }

  el.levelsPanel.innerHTML = `
    <div class="lvl-head">PLAN VIEW BY LEVEL</div>
    ${planActive ? `<button data-act="exit"><span class="lname">Exit plan view<small>Return to 3D</small></span></button><div class="sep"></div>` : ''}
    ${levels.map((l) => `
      <button data-name="${esc(l.name)}" class="${planActive && planActive.name === l.name ? 'active' : ''}">
        <span class="lname">${esc(l.name)}<small>${l.elements.length} element${l.elements.length === 1 ? '' : 's'} · cut at level +1.2 m</small></span>
      </button>`).join('')}`;

  const r = el.toolLevels.getBoundingClientRect();
  el.levelsPanel.style.left = Math.min(r.right + 6, window.innerWidth - 226) + 'px';
  el.levelsPanel.style.top = Math.max(Math.min(r.top, window.innerHeight - 340), 8) + 'px';
  el.levelsPanel.classList.add('visible');

  el.levelsPanel.querySelectorAll('button[data-name]').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const l = levels.find((x) => x.name === b.dataset.name);
      enterPlan(l);
      closeLevelsPanel();
    });
  });
  const exitBtn = el.levelsPanel.querySelector('[data-act="exit"]');
  if (exitBtn) {
    exitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      exitPlan();
      closeLevelsPanel();
    });
  }
}

function closeLevelsPanel() {
  el.levelsPanel.classList.remove('visible');
}

function enterPlan(level) {
  if (!level || !viewer.enterPlanView()) {
    toast('Nothing visible to frame in plan view.');
    return;
  }
  const y = level.y + 1.2;
  viewer.setPlanClip(y);
  planActive = { name: level.name, y };
  el.toolLevels.classList.add('active');
  renderPlanBadge();
}

function exitPlan() {
  if (!planActive) return;
  viewer.exitPlanView();
  viewer.clearPlanClip();
  planActive = null;
  el.toolLevels.classList.remove('active');
  renderPlanBadge();
}

function renderPlanBadge() {
  if (!planActive) {
    el.planBadge.style.display = 'none';
    el.planBadge.innerHTML = '';
    return;
  }
  el.planBadge.style.display = 'flex';
  el.planBadge.innerHTML = `Plan · ${esc(planActive.name)}<button title="Exit plan view">&times;</button>`;
  el.planBadge.querySelector('button').addEventListener('click', exitPlan);
}

// ------------------------------------------------------------------ model load

/**
 * IFCs at least this big open with the large-model engine (js/frag/): converted
 * once in a background worker to Fragments plus the property index, cached,
 * and offered as a .rspfrag file that reopens without conversion. Smaller files
 * keep the direct path, which is quicker for them.
 */
const LARGE_MODEL_BYTES = (() => {
  // localStorage 'rsp.largeModelMB' overrides it: 0 sends every IFC through
  // the large-model engine, a huge number none.
  try {
    const mb = Number(localStorage.getItem('rsp.largeModelMB'));
    if (localStorage.getItem('rsp.largeModelMB') !== null && Number.isFinite(mb)) return mb * 1024 * 1024;
  } catch { /* storage blocked */ }
  return 30 * 1024 * 1024;
})();

const isBundle = (f) => f.name.toLowerCase().endsWith(BUNDLE_EXT);
const isLarge = (f) => isBundle(f) || (f.size || 0) >= LARGE_MODEL_BYTES;

/**
 * Straightens the arcs web-ifc cannot draw (see js/ifc-arc-fix.js). Returns
 * the file to hand to web-ifc: a patched copy, or the file itself.
 */
async function arcFixed(file, onProgress) {
  try {
    const fixed = await flattenArcs(file, onProgress);
    if (fixed.file) {
      console.info(`${file.name}: straightened ${fixed.arcsFixed} curved boundary ` +
        `segment${fixed.arcsFixed === 1 ? '' : 's'} in ${fixed.curvesFixed} profile` +
        `${fixed.curvesFixed === 1 ? '' : 's'} so web-ifc can draw them.`);
      return fixed.file;
    }
  } catch (err) {
    console.warn(`Could not check ${file.name} for curved boundaries; loading as-is.`, err);
  }
  return file;
}

/**
 * Opens a large IFC or a saved .rspfrag with the Fragments engine, and sets up
 * its index and identity exactly as the direct path does.
 */
async function loadLarge(file, { base, span, label }) {
  let opened;
  if (isBundle(file)) {
    setProgress(base + span * 0.05, `Reading ${file.name}…`);
    opened = await openBundle(file, ruleset);
  } else {
    // The converter reports geometry once per IFC class, and one big class can
    // run for minutes, so the label carries a clock to show it is still going.
    const t0 = performance.now();
    let text = `Opening ${file.name}${label}`;
    let pctNow = base + span * 0.02;
    const show = () => setProgress(pctNow, `${text} · ${Math.floor((performance.now() - t0) / 1000)} s`);
    const tick = setInterval(show, 1000);
    // A conversion runs in a worker, so unlike a direct parse it can be stopped.
    const abort = new AbortController();
    el.loadingCancel.hidden = false;
    el.loadingCancel.onclick = () => abort.abort();

    // Only needed when there is no cached conversion of this revision.
    const prepare = async () => {
      text = `Checking curved boundaries${label}`;
      const source = await arcFixed(file, (pct) => {
        pctNow = base + span * (0.02 + 0.06 * (pct / 100));
        show();
      });
      let header = null;
      try { header = await readHeader(file); } catch (err) { console.warn(`Could not read the header of ${file.name}:`, err); }
      text = `Starting the converter${label}`;
      show();
      return { source, header };
    };
    try {
      opened = await largeModelFor(file, prepare, ruleset, {
        signal: abort.signal,
        onProgress: (stage, pct, detail) => {
          if (stage === 'index') {
            pctNow = base + span * (0.08 + 0.12 * (pct / 100));
            text = `Indexing properties${label} (large model)`;
          } else {
            pctNow = base + span * (0.2 + 0.55 * (pct / 100));
            const step = detail && detail.process;
            text = step === 'attributes' ? `Reading attributes${label}`
              : step === 'relations' ? `Reading relations${label}`
              : `Converting geometry${label}: ${Math.round(pct)}%` +
                (detail && detail.class ? `, finished ${detail.class}; large classes can take minutes` : '');
          }
          show();
        },
      });
    } finally {
      clearInterval(tick);
      el.loadingCancel.hidden = true;
      el.loadingCancel.onclick = null;
    }
  }

  const { meta, frag, bundle } = opened;
  const entry = await viewer.loadFragments(frag, {
    name: meta.sourceName || file.name,
    // Editing works from the IFC, which a .rspfrag does not carry.
    file: isBundle(file) ? null : file,
    bytes: meta.sourceSize,
  }, (pct) => setProgress(base + span * (0.75 + 0.24 * (pct / 100)), `Opening${label}…`));
  entry.bundle = bundle;
  entry.sourceHandle = sourceHandles.get(file) || null;
  if (opened.source === 'converted') {
    toast(`${entry.name} was converted in ${Math.round(opened.convertMs / 1000)} s. It reopens from this ` +
      `browser's cache next time; to keep a copy, use the save button beside it under Models.`);
  }

  const idx = reviveIndex(meta.index, entry.modelID);
  indexes.set(entry.modelID, idx);
  indexedWith.set(entry.modelID, new Set(meta.entities || []));
  if (meta.header) {
    identities.set(entry.modelID, buildIdentity(meta.header, idx, { name: entry.name, bytes: entry.bytes }));
  }
  if (opened.stale) {
    toast(`${file.name} was converted under different mapping rules. Some checks may miss elements; ` +
      'open the IFC again to convert it under the current rules.');
  }
  return entry;
}

async function loadFiles(files) {
  const ifcFiles = files.filter((f) => f.name.toLowerCase().endsWith('.ifc') || isBundle(f));
  const skipped = files.length - ifcFiles.length;
  if (!ifcFiles.length) {
    toast(`No .ifc or ${BUNDLE_EXT} files in that selection.`);
    return;
  }

  // Warn before parsing: a parse cannot be interrupted, and a file that does
  // not fit takes the whole tab down with it. The user can still go ahead.
  // Large models are converted in a worker instead, so they are not counted.
  const now = measure(viewer);
  const forecast = projectMemory(now, ifcFiles.filter((f) => !isLarge(f)));
  if (forecast.level === LEVEL.DANGER) {
    toast(`${formatBytes(forecast.fileBytes)} of IFC is expected to need about ` +
      `${formatBytes(forecast.peak)} of memory against a ${formatBytes(now.budget)} budget. ` +
      'The browser tab may run out of memory while loading.');
  }

  el.dropzone.classList.remove('visible');
  el.loading.classList.add('visible');

  clearQuery();
  clearCheckResults();

  let loaded = 0;
  for (const [i, file] of ifcFiles.entries()) {
    const base = (i / ifcFiles.length) * 100;
    const span = 100 / ifcFiles.length;
    const label = ifcFiles.length > 1 ? ` (${i + 1}/${ifcFiles.length})` : '';
    setProgress(base + span * 0.05, `Reading ${file.name}…`);

    if (isLarge(file)) {
      if (!ruleset) {
        toast(`${file.name} needs the mapping rules to open as a large model, and they did not load.`);
        continue;
      }
      try {
        await loadLarge(file, { base, span, label });
        renderMemory();
        loaded++;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          toast(`Stopped converting ${file.name}.`);
        } else {
          console.error(err);
          toast(`Could not open ${file.name}: ${err && err.message ? err.message : err}`);
        }
      }
      continue;
    }

    try {
      // A rounded corner in a floor or geographic-element boundary is stored as
      // an arc that web-ifc cannot tessellate (see js/ifc-arc-fix.js) — most of
      // the solid's footprint would silently go missing. Straighten any such
      // arcs into a dense polyline before web-ifc ever parses the file. Only
      // this in-memory copy is affected: entry.file below is put back to the
      // real upload once parsing is done, so editing, export and identity
      // still see the bytes the user actually gave us.
      const loadFile = await arcFixed(file, (pct) =>
        setProgress(base + span * 0.02 + span * 0.08 * (pct / 100), `Checking curved boundaries${label}…`));

      const entry = await viewer.load(loadFile, (pct) =>
        setProgress(base + span * 0.1 + span * (pct / 100) * 0.5, `Parsing geometry${label}…`));
      // Restore the real upload: everything past this point (editing, export,
      // GUID/identity reads) must see the original bytes, not our patched copy.
      entry.file = file;
      entry.bytes = file.size || 0;

      if (ruleset) {
        setProgress(base + span * 0.65, `Indexing properties${label}…`);
        // Yield so the progress bar paints before the synchronous index walk.
        await new Promise((r) => setTimeout(r, 20));
        indexedWith.set(entry.modelID, new Set(ruleset.entities));
        indexes.set(entry.modelID, buildIndex(viewer.api, entry.modelID, ruleset,
          (msg, pct) => setProgress(base + span * (0.65 + (pct / 100) * 0.34), msg + label)));
      }
      // What this file *is*, independent of what it is called: the header plus
      // the spatial GlobalIds. Read now, while the index for this one model is
      // to hand and before it is merged with the others.
      try {
        const header = await readHeader(file);
        identities.set(entry.modelID, buildIdentity(header, indexes.get(entry.modelID), {
          name: entry.name, bytes: entry.bytes,
        }));
      } catch (err) {
        console.warn(`Could not read the header of ${file.name}:`, err);
      }

      // Everything the mapping needs is now in the index, and nothing after this
      // reads the wasm model — so hand that memory back before the next file.
      viewer.releaseModelData(entry.modelID);
      renderMemory();
      loaded++;
    } catch (err) {
      console.error(err);
      toast(`Could not load ${file.name}. It may be an unsupported IFC schema or corrupted.`);
    }
  }

  if (!loaded) {
    el.loading.classList.remove('visible');
    if (!viewer.hasModels) el.dropzone.classList.add('visible');
    return;
  }

  // Extract what each model reports and write it into the project before
  // anything else: these are the figures the dashboard totals, and they have
  // to outlive the file being unloaded. Recorded check results are left
  // alone (see buildModelRecord).
  try {
    captureModelRecords();
  } catch (err) {
    console.error('The models could not be recorded in the project:', err);
  }
  rebuildIndex();
  viewer.fit();
  farSnapshot = (viewer.farElements || []).slice();
  reportFarElements();
  refreshWarnings();
  refreshSurveyRail();
  setProgress(100, 'Done');
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped — not .ifc.`);
  setTimeout(() => el.loading.classList.remove('visible'), 250);
}

/**
 * Says which elements the view left out because they sit far from the rest of
 * the model. Geometry kilometres from the building is nearly always an export
 * problem (a stray object, or elements left at Revit's internal origin while
 * the rest uses shared coordinates), so it is named rather than silently framed.
 */
function reportFarElements() {
  const far = viewer.farElements || [];
  if (!far.length) return;
  const label = (f) => {
    const e = index && index.byId.get(`${f.modelID}:${f.expressID}`);
    return e ? `${e.name || e.entity} (${e.entity})` : `element #${f.expressID}`;
  };
  const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const shown = far.slice(0, 3).map(label).join(', ');
  console.warn('Elements left out of the view because they are far from the rest of the model:',
    far.map((f) => ({ name: label(f), modelID: f.modelID, expressID: f.expressID, distance: dist(f.distance) })));
  toast(`${far.length} element${far.length === 1 ? '' : 's'} ${far.length === 1 ? 'sits' : 'sit'} up to ` +
    `${dist(far[0].distance)} from the rest of the model: ${shown}${far.length > 3 ? ', …' : ''}. ` +
    'The view frames the model without them. See the Warnings tab.');
}

// ---------------------------------------------------------------------- warnings

/**
 * Elements the viewer left out of the framing when the models were loaded.
 * Kept apart from viewer.farElements, which follows whichever models are
 * visible at the last fit, so hiding a model does not clear its warning.
 */
let farSnapshot = [];
/** Warning ids the user has unfolded, kept across recomputes. */
const openWarnings = new Set();
let warnings = [];

/** Recomputes the export warnings for the loaded models and redraws the tab. */
function refreshWarnings() {
  const names = new Map(viewer.entries.map((e) => [e.modelID, e.name]));
  farSnapshot = farSnapshot.filter((f) => names.has(f.modelID));
  try {
    warnings = viewer.entries.length ? computeWarnings({
      indexes, identities, names, far: farSnapshot, centres: viewer.modelCentres(),
    }) : [];
  } catch (err) {
    console.error('Model warnings could not be computed:', err);
    warnings = [];
  }
  renderWarnings();
}

function renderWarnings() {
  const fails = warnings.filter((w) => w.severity === 'fail');
  const reviews = warnings.filter((w) => w.severity === 'warn');
  el.warnCount.hidden = !warnings.length;
  el.warnCount.textContent = String(fails.length || reviews.length);
  el.warnCount.classList.toggle('review', !fails.length);
  el.warnCount.title = `${fails.length} will fail, ${reviews.length} to review`;

  if (!viewer.entries.length) {
    el.warnSummary.innerHTML = '';
    el.warnList.innerHTML = '<div class="empty-note">Load an IFC file to check it for export problems: ' +
      'spatial structure, georeferencing, stray geometry, GlobalIds and subtypes.</div>';
    return;
  }
  if (!indexes.size) {
    el.warnSummary.innerHTML = '';
    el.warnList.innerHTML = '<div class="empty-note">The IFC-SG ruleset did not load, so the models were not indexed and cannot be checked.</div>';
    return;
  }
  el.warnSummary.innerHTML = warnings.length
    ? `${fails.length ? `<span class="pill fail">${fails.length} will fail</span>` : ''}
       ${reviews.length ? `<span class="pill warn">${reviews.length} to review</span>` : ''}`
    : `<span class="pill ok">No export problems found</span>`;

  const files = new Set(viewer.entries.map((e) => e.name));
  const related = (w) => {
    const id = relatedCheck(w.id);
    const meta = id && registry.byId(id);
    return meta ? `<div class="warn-rel">Related check:
      <button class="link-btn" data-rel="${esc(id)}">${esc(meta.title)} on the Compliance tab</button></div>` : '';
  };
  const item = (w) => {
    const n = w.elements.length;
    const sub = [files.size > 1 || !w.file ? w.file : null, n ? `${n} element${n === 1 ? '' : 's'}` : null]
      .filter(Boolean).join(' · ');
    const shown = w.elements.slice(0, 50);
    const els = n ? `
      <div class="acts">
        <button class="btn sm" data-show>Show in model</button>
        <button class="btn sm" data-zoom>Zoom to</button>
      </div>
      <div class="warn-els">${shown.map((e, i) => `
        <button data-el="${i}" title="${esc(e.globalId || '')}">
          <span>${esc(e.name || e.entity)}</span>
          <small>${esc(e.distance != null ? fmtDistance(e.distance) : e.entity)}${e.storey ? ' · ' + esc(e.storey) : ''}</small>
        </button>`).join('')}
        ${n > shown.length ? `<div class="more">and ${n - shown.length} more — use Show in model to see them all</div>` : ''}
      </div>` : '';
    return `
      <div class="warn-item ${w.severity}${openWarnings.has(w.id) ? ' open' : ''}" data-w="${esc(w.id)}">
        <button class="warn-head"><span class="dot"></span>
          <span class="wt">${esc(w.title)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
          <span class="chev">&#9654;</span></button>
        <div class="warn-body">${esc(w.detail)}${related(w)}${els}</div>
      </div>`;
  };
  el.warnList.innerHTML =
    (fails.length ? `<div class="warn-group">WILL FAIL</div>${fails.map(item).join('')}` : '') +
    (reviews.length ? `<div class="warn-group">REVIEW</div>${reviews.map(item).join('')}` : '') +
    (warnings.length ? '' : '<div class="empty-note">Nothing found that would stop these files from being ' +
      'accepted: one site and building per file, storeys present, georeferenced to SVY21, no stray ' +
      'geometry, and every GlobalId and subtype in place. IFC-SG properties are checked on the Compliance tab.</div>');

  el.warnList.querySelectorAll('.warn-item').forEach((node) => {
    const w = warnings.find((x) => x.id === node.dataset.w);
    node.querySelector('.warn-head').addEventListener('click', () => {
      node.classList.toggle('open');
      if (node.classList.contains('open')) openWarnings.add(w.id);
      else openWarnings.delete(w.id);
    });
    const show = node.querySelector('[data-show]');
    if (show) {
      show.addEventListener('click', () => shellActions.showInModel(
        [{ label: w.title, colour: w.severity === 'fail' ? 0xe0624f : 0xe0b84f, elements: w.elements }],
        'Warning', w.file || ''));
    }
    const zoom = node.querySelector('[data-zoom]');
    if (zoom) {
      zoom.addEventListener('click', () => {
        if (!viewer.fitElements(w.elements)) toast('These elements have no geometry to zoom to.');
      });
    }
    const rel = node.querySelector('[data-rel]');
    if (rel) rel.addEventListener('click', () => openCheck(rel.dataset.rel));
    node.querySelectorAll('[data-el]').forEach((b) => b.addEventListener('click', () => {
      const e = w.elements[+b.dataset.el];
      if (e.bare) viewer.setSelection(e);
      else showElement(e);
      viewer.fitElements([e]);
    }));
  });
}

/** The compliance check that looks at the same problem as a warning, if any. */
function relatedCheck(warningId) {
  const kind = warningId.split(':')[0];
  if (/^(geo-|crs-|origin-far$|far$|datum$)/.test(kind)) return 'geo-referencing';
  if (kind === 'space-geom') return 'space-geometry';
  return null;
}

/** Shows one check on the Compliance tab: its row in the menu, ticked and in view. */
function openCheck(id) {
  showTab('check');
  el.left.classList.remove('collapsed');
  if (!selectedChecks.has(id)) {
    selectedChecks.add(id);
    saveSelection();
  }
  checkMenuOpen = true;
  renderCheckMenu();
  const row = el.checkMenu.querySelector(`.cm-row[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1400);
  }
}

function fmtDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km away` : `${Math.round(m)} m away`;
}

/**
 * Enables the Dashboard button whenever there is something to show in it —
 * a loaded model or a project with recorded ones — and keeps an open
 * dashboard in step with the model set. Unloading a file does not change the
 * totals; it only changes which of them can be highlighted in the 3D view.
 */
function refreshDashboardAvailability() {
  const hasRecords = !!(project && project.models && project.models.length);
  const loaded = !!(viewer && viewer.hasModels);
  el.btnDash.disabled = !loaded && !hasRecords;
  if (!el.dash.classList.contains('visible')) return;
  if (loaded || hasRecords) openDashboard();
  else closeDashboard();
}

/** Recomputes the merged index, target counts and all dependent UI. */
function rebuildIndex() {
  // The set of storeys and their geometry can change entirely with the model
  // set, so a stale plan cut would show the wrong thing rather than nothing.
  if (planActive) exitPlan();

  index = indexes.size ? mergeIndexes([...indexes.values()]) : null;

  counts.clear();
  if (index && ruleset) {
    for (const t of ruleset.targets) counts.set(t.id, selectElements(index, t).length);
  }

  const names = viewer.entries.map((e) => e.name);
  el.filename.querySelector('.fname').textContent = names.length === 0 ? 'Add IFC file'
    : names.length === 1 ? names[0]
      : `${names.length} models`;
  el.filename.classList.toggle('has-file', names.length > 0);
  el.filename.title = names.length ? names.join('\n') : 'Add an IFC file';
  if (!names.length) el.modelPicker.classList.remove('open');
  // Check inputs such as the preset editor read from the index, so redraw them.
  renderCheckMenu();
  // The dashboard reports the project, not the session: what a file measured
  // stays in the record when it is unloaded.
  refreshDashboardAvailability();

  renderModels();
  renderTree();
  mtRoots = null;
  applyVisibility();
  renderMemory();
  refreshWarnings();

  if (index && ![...counts.values()].some((n) => n > 0)) {
    toast('No IFC-SG mapped components found. The model may not use SGPset property sets.');
  }
}

function renderModels() {
  const entries = viewer.entries;
  if (!entries.length) {
    el.models.innerHTML = '';
    return;
  }
  el.models.innerHTML = entries.map((e) => {
    const n = indexes.get(e.modelID)?.count ?? 0;
    return `
      <div class="mrow${e.visible ? '' : ' off'}" data-m="${e.modelID}">
        <button class="icon-btn ${e.visible ? 'on' : ''}" data-act="vis" title="Show / hide this model">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>
          </svg>
        </button>
        <span class="mname" title="${esc(e.name)}">${esc(e.name)}<small>${n} mapped elements${e.kind === 'frag' ? ' · large model' : ''}</small></span>
        ${e.kind === 'frag' && e.bundle ? `<button class="icon-btn" data-act="save" title="Save the converted model (${BUNDLE_EXT}) so it opens without converting again">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5"/><path d="M4.5 16.5v3h15v-3"/>
          </svg>
        </button>` : ''}
        <button class="icon-btn" data-act="del" title="Close this model">&times;</button>
      </div>`;
  }).join('') + '<button class="m-add" data-act="add">+ Add IFC file</button>';

  el.models.querySelector('[data-act="add"]').addEventListener('click', () => {
    el.modelPicker.classList.remove('open');
    chooseModelFiles();
  });

  el.models.querySelectorAll('.mrow').forEach((row) => {
    const modelID = +row.dataset.m;
    row.querySelector('[data-act="vis"]').addEventListener('click', () => {
      const entry = viewer.models.get(modelID);
      viewer.setModelVisible(modelID, !entry.visible);
      renderModels();
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => removeModel(modelID));
    const save = row.querySelector('[data-act="save"]');
    if (save) save.addEventListener('click', () => saveConverted(modelID));
  });
}

/** Saves a large model's converted copy, to open next time without converting. */
async function saveConverted(modelID) {
  const entry = viewer.models.get(modelID);
  if (!entry || !entry.bundle) return;
  try {
    // The dialog opens in the IFC's own folder when the browser handed over
    // its handle, so the copy lands beside the model with one click.
    await saveBlob(entry.bundle, entry.name.replace(/\.ifc$/i, '') + BUNDLE_EXT,
      [{ description: 'Converted model', accept: { 'application/octet-stream': [BUNDLE_EXT] } }],
      entry.sourceHandle);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error(err);
    toast(`Could not save ${entry.name}: ${err && err.message ? err.message : err}`);
  }
}

function removeModel(modelID) {
  // Drop anything that referenced this model before the elements disappear.
  for (const key of [...manualHidden]) {
    if (key.startsWith(modelID + ':')) manualHidden.delete(key);
  }
  indexes.delete(modelID);
  indexedWith.delete(modelID);
  identities.delete(modelID);
  // Handles are reused, so a model opened later must not inherit this one's isolate.
  if (isolation) isolation.delete(modelID);
  if (editors.has(modelID) && editors.get(modelID).hasEdits) {
    toast(`Unsaved edits to ${viewer.models.get(modelID)?.name || 'the model'} were dropped with it.`);
  }
  editors.delete(modelID);
  textScans.delete(modelID);
  renderEditsBar();
  viewer.removeModel(modelID);
  measurer.invalidate();
  if (!viewer.hasModels) {
    if (measurer.active) setMeasureActive(false);
    measurer.clear();
  }
  clearQuery();
  clearCheckResults();
  rebuildIndex();
  if (!viewer.hasModels) el.dropzone.classList.add('visible');
}

// -------------------------------------------------------------------- visibility

/** Every IfcSpace in the merged index. */
function spaceElements() {
  return index ? (index.byEntity.get('IFCSPACE') || []) : [];
}

/** Pushes the current visibility policy — manual hides plus the space rule. */
function applyVisibility() {
  if (!index) {
    viewer.setHidden([]);
  } else {
    const hidden = [];
    for (const e of index.all) if (manualHidden.has(e.key)) hidden.push(e);
    if (!spacesVisible) {
      for (const e of spaceElements()) if (!manualHidden.has(e.key)) hidden.push(e);
    }
    for (const [modelID, keep] of isolation || []) {
      for (const id of viewer.drawnIds(modelID)) if (!keep.has(id)) hidden.push({ modelID, expressID: id });
    }
    viewer.setHidden(hidden);
  }

  const spaces = spaceElements().length;
  el.toolSpaces.classList.toggle('active', spacesVisible);
  setRailState(el.toolSpaces, spaces
    ? `${spaces} IfcSpace volume${spaces > 1 ? 's' : ''}, ${spacesVisible ? 'shown' : 'hidden'}`
    : 'No IfcSpace elements in this model');

  const hiddenCount = manualHidden.size;
  el.toolShowAll.classList.toggle('active', hiddenCount > 0);
  setRailState(el.toolShowAll, hiddenCount
    ? `${hiddenCount} element${hiddenCount > 1 ? 's' : ''} hidden`
    : 'Nothing is hidden');
  renderModelTab();
}

function setSpacesVisible(on) {
  spacesVisible = on;
  applyVisibility();
}

function showAll() {
  manualHidden.clear();
  isolation = null;
  spacesVisible = true;
  for (const e of viewer.entries) viewer.setModelVisible(e.modelID, true);
  applyVisibility();
  renderModels();
}

function hideElements(elements) {
  for (const e of elements) manualHidden.add(e.key);
  applyVisibility();
}

/** Hides everything except the given elements. */
function isolateElements(elements) {
  if (!index) return;
  const keep = new Set(elements.map((e) => e.key));
  manualHidden.clear();
  for (const e of index.all) if (!keep.has(e.key)) manualHidden.add(e.key);
  isolation = new Map(viewer.entries.map((e) => [e.modelID, new Set()]));
  for (const e of elements) keepDrawing(e);
  // An explicit isolate overrides the space rule, or isolating a space shows nothing.
  spacesVisible = true;
  applyVisibility();
}

/** Lets an element (and the parts that draw it) through an isolate. */
function keepDrawing(e) {
  const keep = isolation && isolation.get(e.modelID);
  if (!keep) return;
  keep.add(e.expressID);
  for (const id of e.parts || []) keep.add(id);
}

// ---------------------------------------------------------------- context menu

function openContextMenu(hit, x, y) {
  const item = pickedElement(hit);
  const hiddenCount = manualHidden.size;

  const parts = [];
  if (item) {
    parts.push(`<div class="ctx-head">${esc(item.name || item.entity)}
      <small>${esc(item.entity)}${item.storey ? ' · ' + esc(item.storey) : ''}</small></div>`);
    parts.push(`<button data-act="hide">Hide element</button>`);
    parts.push(`<button data-act="hide-type">Hide all ${esc(item.entity)}
      <span class="hint">${(index.byEntity.get(item.canonicalEntity) || []).length}</span></button>`);
    parts.push(`<button data-act="isolate">Isolate element</button>`);
    parts.push(`<div class="sep"></div>`);
    parts.push(`<button data-act="select">Show properties</button>`);
    parts.push(`<div class="sep"></div>`);
  }
  // The elements the current query colours (a soloed legend row narrows it), so
  // the picked-out components can be viewed on their own.
  const queried = legend
    .filter((g, i) => soloIndex < 0 || soloIndex === i)
    .flatMap((g) => g.elements);
  parts.push(`<button data-act="isolate-query"${queried.length ? '' : ' disabled'}>Isolate selected components
    ${queried.length ? `<span class="hint">${queried.length}</span>` : ''}</button>`);
  parts.push(`<button data-act="showall"${hiddenCount ? '' : ' disabled'}>Show all
    ${hiddenCount ? `<span class="hint">${hiddenCount} hidden</span>` : ''}</button>`);
  parts.push(`<button data-act="fit">Fit view</button>`);

  el.ctxmenu.innerHTML = parts.join('');
  el.ctxmenu.classList.add('visible');

  // Keep the menu inside the window.
  const r = el.ctxmenu.getBoundingClientRect();
  el.ctxmenu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  el.ctxmenu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  el.ctxmenu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      switch (b.dataset.act) {
        case 'hide': hideElements([item]); break;
        case 'hide-type': hideElements(index.byEntity.get(item.canonicalEntity) || []); break;
        case 'isolate': isolateElements([item]); break;
        case 'isolate-query': isolateElements(queried); break;
        case 'select': showElement(item); break;
        case 'showall': showAll(); break;
        case 'fit': viewer.fit(); break;
      }
    });
  });
}

function closeContextMenu() {
  el.ctxmenu.classList.remove('visible');
}

// ------------------------------------------------------------------ query tree

/** Search + "present in model" — the filters orthogonal to the hierarchy. */
function matchesSecondaryFilters(t) {
  const q = el.fSearch.value.trim().toLowerCase();
  const onlyPresent = el.fPresent.checked && index;

  if (onlyPresent && !(counts.get(t.id) > 0)) return false;
  if (q) {
    const hay = [t.component, t.entity, describeSubtypes(t.subtypes),
      ...t.requirements.map((r) => r.prop + ' ' + r.pset)].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * Does a target fall inside the project's authority scope and the query tab's
 * authority filter? A project listing no authorities scopes nothing out.
 */
function inScope(t) {
  if (!appliesToAgency(t, agencyFilter)) return false;
  return !projectAuthorities || t.agency === AGENCY_ALL || projectAuthorities.has(t.agency);
}

/** Does a workbook row's RSP_Priority pass the priority filter? */
const matchesPriority = (p) => !priorityFilter || p === priorityFilter;

function visibleTargets() {
  const list = ruleset.targets.filter((t) =>
    (!gatewayFilter || t.gateway === gatewayFilter) &&
    inScope(t) &&
    t.tags.some((g) => matchesPriority(g.priority)) &&
    matchesSecondaryFilters(t));
  // With an authority chosen, its own components read first and the ones every
  // authority shares follow. The sort is stable, so the order within each
  // group is unchanged.
  if (agencyFilter) {
    list.sort((a, b) =>
      GATEWAY_ORDER.indexOf(a.gateway) - GATEWAY_ORDER.indexOf(b.gateway) ||
      (a.agency === AGENCY_ALL) - (b.agency === AGENCY_ALL));
  }
  return list;
}

/** Re-renders every filter-driven part of the query tab: bubbles, then the tree. */
function refreshFilters() {
  renderGatewayBubbles();
  renderAgencyBubbles();
  renderPriorityBubbles();
  renderTree();
  renderProjectChip();
}

/** One row of pill filters: `items` is [{id, label, n}], id '' is the "all" bubble. */
function renderBubbles(container, items, activeId, onClick) {
  container.innerHTML = items.map((it) => `
    <button class="bubble${it.id === activeId ? ' active' : ''}${it.id && !it.n ? ' zero' : ''}"
            data-id="${esc(it.id)}">${esc(it.label)}<span class="bc">${it.n}</span></button>`).join('');
  container.querySelectorAll('.bubble').forEach((b) => {
    b.addEventListener('click', () => onClick(b.dataset.id));
  });
}

/**
 * Gateway is the top tier, but it belongs to the submission: it is shown here
 * and changed in project setup, the one place it is set.
 */
function renderGatewayBubbles() {
  if (!el.gwBubbles) return;
  const n = ruleset.targets.filter((t) => t.gateway === gatewayFilter && matchesSecondaryFilters(t)).length;
  el.gwBubbles.innerHTML = `
    <span class="bubble active static">${esc(GATEWAY_LABEL[gatewayFilter] || 'All gateways')}<span class="bc">${n}</span></span>
    <button class="link-btn" data-open-project>Change in project setup</button>`;
  el.gwBubbles.querySelector('[data-open-project]').addEventListener('click', (e) => {
    e.stopPropagation();
    openProjectPanel();
  });
}

/**
 * One gateway for the whole submission. The query filter and the URA check's
 * own gateway selector always agree, whichever of them was touched.
 */
function setGateway(gateway) {
  if (gateway !== gatewayFilter) markResultsStale('The submission gateway changed since these checks ran.');
  gatewayFilter = gateway;
  checkInputs.set('ura.gateway', gateway);
  // A drill-down: if the authority chosen below no longer has anything under
  // this gateway, drop back to "all authorities" rather than showing nothing.
  if (agencyFilter && ruleset && !ruleset.targets.some((t) =>
    t.agency === agencyFilter && (!gatewayFilter || t.gateway === gatewayFilter) && matchesSecondaryFilters(t))) {
    agencyFilter = '';
  }
  dropEmptyPriority();
  renderCheckMenu();
}

/** Authority is the second tier: scoped by whichever gateway is currently selected. */
function renderAgencyBubbles() {
  if (!el.agencyBubbles) return;
  const base = ruleset.targets.filter((t) =>
    (!gatewayFilter || t.gateway === gatewayFilter) && matchesSecondaryFilters(t) &&
    (!projectAuthorities || t.agency === AGENCY_ALL || projectAuthorities.has(t.agency)));
  // "ALL" is not an authority but a component every authority queries, so it
  // gets no bubble of its own and is counted under each of the others. An
  // authority the project scopes out gets no bubble either.
  const agencies = ruleset.agencies.filter((a) =>
    a !== AGENCY_ALL && (!projectAuthorities || projectAuthorities.has(a)));
  const items = [
    { id: '', label: 'All', n: base.length },
    ...agencies.map((a) => ({ id: a, label: a, n: base.filter((t) => appliesToAgency(t, a)).length })),
  ];
  renderBubbles(el.agencyBubbles, items, agencyFilter, (id) => {
    agencyFilter = id;
    dropEmptyPriority();
    renderAgencyBubbles();
    renderPriorityBubbles();
    renderTree();
  });
}

/** Targets the gateway and authority tiers leave in view, before priority. */
function priorityBase() {
  return ruleset.targets.filter((t) =>
    (!gatewayFilter || t.gateway === gatewayFilter) && inScope(t) && matchesSecondaryFilters(t));
}

/** As for authority: a priority with nothing left under the tiers above drops back to "all". */
function dropEmptyPriority() {
  if (priorityFilter && ruleset &&
      !priorityBase().some((t) => t.tags.some((g) => g.priority === priorityFilter))) {
    priorityFilter = '';
  }
}

const PRIORITY_ORDER = ['High', 'Medium', 'Low'];

/** Priority is the third tier: scoped by the gateway and authority selected above it. */
function renderPriorityBubbles() {
  if (!el.priorityBubbles) return;
  const base = priorityBase();
  const priorities = [...new Set(ruleset.targets.flatMap((t) => t.tags.map((g) => g.priority)).filter(Boolean))]
    .sort((a, b) => ((PRIORITY_ORDER.indexOf(a) + 1) || 99) - ((PRIORITY_ORDER.indexOf(b) + 1) || 99) ||
      a.localeCompare(b));
  // A workbook without the RSP_Priority column has nothing to filter by.
  el.priorityTier.hidden = !priorities.length;
  const items = [
    { id: '', label: 'All', n: base.length },
    ...priorities.map((p) => ({ id: p, label: p, n: base.filter((t) => t.tags.some((g) => g.priority === p)).length })),
  ];
  renderBubbles(el.priorityBubbles, items, priorityFilter, (id) => {
    priorityFilter = id;
    renderPriorityBubbles();
    renderTree();
  });
}

// ------------------------------------------------------------ component groups

/**
 * One agency + component, with every workbook selector row that names it.
 *
 * The workbook lists a component once per (entity, subtypes) row, and those
 * rows overlap — "Railing" has both IfcRailing[any] and IfcRailing[GUARDRAIL].
 * The user thinks in components, so the rows are folded together here and the
 * elements deduplicated, which is what makes the counts add up.
 *
 * @typedef {object} ComponentGroup
 * @property {string} key       agency|component
 * @property {string} agency
 * @property {string} component
 * @property {object[]} targets
 */

/** Folds targets (already scoped and ordered) into component groups. */
/**
 * The targets in scope folded into one group per RSP_Category — RSP's own
 * triage of the workbook, not the authority's, and not the "Identified
 * Component" column (a category routinely spans several components: "Rooms"
 * covers every named room type, "Area (AGF)" every bonus-GFA space). A row
 * nobody has triaged yet falls under "Uncategorised" rather than being
 * dropped. Several authorities can query the same category (Door: BCA, NEA
 * and SCDF), so a category is one bubble whatever asks for it; `agencies`
 * records who does.
 */
const UNCATEGORISED = 'Uncategorised';

/**
 * The category a requirement is shown under. A row left blank takes its
 * selector's first category, as an untriaged placeholder row always has.
 */
const reqCategory = (t, r) => r.rspCategory || t.category || UNCATEGORISED;

/**
 * A selector can sit under several categories (see `tags` in ifcsg.js): it is
 * listed in each whose rows pass the priority filter, and each shows only its
 * own rows' properties.
 */
function targetCategories(t) {
  const out = [];
  for (const g of t.tags) {
    const c = g.category || t.category || UNCATEGORISED;
    if (matchesPriority(g.priority) && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Is a requirement shown under this category at the current priority? */
const reqShown = (t, r, category) => reqCategory(t, r) === category && matchesPriority(r.rspPriority || null);

function componentGroups(targets) {
  const groups = new Map();
  for (const t of targets) {
    for (const key of targetCategories(t)) {
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, category: key, agencies: [], targets: [] }));
      if (!g.agencies.includes(t.agency)) g.agencies.push(t.agency);
      g.targets.push(t);
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.category === UNCATEGORISED) return 1;
    if (b.category === UNCATEGORISED) return -1;
    return a.category.localeCompare(b.category, undefined, { sensitivity: 'base' });
  });
}

/** Every element any of the group's selectors matches, each once. */
function groupElements(group) {
  const seen = new Map();
  for (const t of group.targets) {
    for (const e of selectElements(index, t)) seen.set(e.key, e);
  }
  return [...seen.values()];
}

/**
 * What an element is, as the modeller declared it: entity plus subtype.
 * A USERDEFINED PredefinedType carries the real name on ObjectType.
 */
function elementKind(e) {
  const pt = e.predefinedType;
  const sub = pt && pt !== 'USERDEFINED' && pt !== 'NOTDEFINED' ? pt : (e.objectType || '');
  return sub ? `${e.entity} · ${sub}` : e.entity;
}

const reqId = (r) => (r.pset + '|' + r.prop).toUpperCase();

/**
 * The group's properties as one flat list. A requirement that several rows
 * repeat (Door: DOOR, then GATE, then the combined row; or BCA and SCDF both
 * asking for it) is listed once, with the entities it applies to.
 * @returns {Array<{req: object, entities: string[]}>}
 */
function groupProperties(group) {
  const list = new Map();
  for (const t of group.targets) {
    for (const r of t.requirements) {
      if (!reqShown(t, r, group.category)) continue;
      let p = list.get(reqId(r));
      if (!p) list.set(reqId(r), (p = { req: r, entities: [] }));
      if (!p.entities.includes(t.entity)) p.entities.push(t.entity);
    }
  }
  return [...list.values()].sort((a, b) =>
    a.req.prop.localeCompare(b.req.prop, undefined, { sensitivity: 'base' }) ||
    a.req.pset.localeCompare(b.req.pset, undefined, { sensitivity: 'base' }));
}

/** Elements of every selector in the group that asks for this requirement. */
function propertyElements(group, req) {
  const id = reqId(req);
  const seen = new Map();
  for (const t of group.targets) {
    if (!t.requirements.some((r) => reqId(r) === id && reqShown(t, r, group.category))) continue;
    for (const e of selectElements(index, t)) seen.set(e.key, e);
  }
  return [...seen.values()];
}

// ------------------------------------------------------------------ query tree

/**
 * Two bubble sections: the components in scope, then — once one is chosen —
 * its properties, grouped under entity labels when it spans several entities.
 */
function renderTree() {
  if (!ruleset) return;
  const groups = componentGroups(visibleTargets());

  if (!groups.length) {
    const msg = agencyFilter || priorityFilter
      ? 'No mapped components fall under this gateway/authority/priority selection yet — try “All”.'
      : index ? 'No mapped components match these filters.'
              : 'Load an IFC model, or untick “Only components present in model”.';
    el.tree.innerHTML = `<div class="empty-note">${msg}</div>`;
    return;
  }

  const active = selection ? selection.group.key : null;
  const parts = [`<div class="q-head">Components<span class="qc">${groups.length}</span></div>`];
  // One flat row, one bubble per RSP_Category: which authority asks, and
  // which "Identified Component" rows feed a category, are in the tooltip,
  // not the layout.
  parts.push(`<div class="bubble-row plain">${groups.map((g) => {
    const n = index ? groupElements(g).length : null;
    const title = [g.agencies.map((a) => (a === AGENCY_ALL ? 'All authorities' : a)).join(', '),
      ...g.targets.map((t) => `${t.component}: ${t.entity} · ${describeSubtypes(t.subtypes)}`)].join('\n');
    return `<button class="bubble comp${g.key === active ? ' active' : ''}${n === 0 ? ' zero' : ''}"
      data-g="${esc(g.key)}" title="${esc(title)}">${esc(g.category)}${
        n === null ? '' : `<span class="bc">${n}</span>`}</button>`;
  }).join('')}</div>`);

  let props = [];
  if (selection) {
    const group = selection.group;
    props = groupProperties(group);
    parts.push(`<div class="q-head">Properties · ${esc(group.category)}<span class="qc">${props.length}</span></div>`);
    if (!props.length) {
      parts.push('<div class="empty-note">The mapping lists no properties for this component — it only declares which elements belong to it.</div>');
    } else {
      parts.push(`<div class="bubble-row plain">${props.map(({ req: r, entities }, i) => {
        const on = selection.req && reqId(selection.req) === reqId(r);
        const hint = [r.pset, entities.join(', '), r.dataType, r.unit,
          r.accepted.kind === 'enum' ? 'accepted: ' + r.accepted.values.join(', ') : '',
          r.accepted.kind === 'spaceValues' ? 'Space Values list' : ''].filter(Boolean).join('\n');
        return `<button class="bubble prop${on ? ' active' : ''}" data-r="${i}"
          title="${esc(hint)}">${esc(r.prop)}<span class="bp">${esc(r.pset)}</span></button>`;
      }).join('')}</div>`);
    }
  }

  el.tree.innerHTML = parts.join('');

  el.tree.querySelectorAll('.bubble.comp').forEach((b) => {
    const g = groups.find((x) => x.key === b.dataset.g);
    b.addEventListener('click', () => {
      if (selection && selection.group.key === g.key && !selection.req) clearQuery();
      else selectComponent(g);
    });
  });
  el.tree.querySelectorAll('.bubble.prop').forEach((b) => {
    b.addEventListener('click', () => selectProperty(selection.group, props[+b.dataset.r].req));
  });
}

// ---------------------------------------------------------------- query / colour

/** Colours a component's elements by what each one is: entity plus subtype. */
function selectComponent(group) {
  if (!index) {
    toast('Load an IFC model first.');
    return;
  }
  const elements = groupElements(group);
  if (!elements.length) {
    toast(`No elements in the loaded models match ${group.category}.`);
    return;
  }
  // Querying spaces while spaces are hidden would colour nothing; the request to
  // see them is explicit, so honour it and let the toggle reflect the change.
  if (elements.some((e) => e.canonicalEntity === 'IFCSPACE') && !spacesVisible) setSpacesVisible(true);

  selection = { group, req: null };
  soloIndex = -1;

  const kinds = new Map();
  for (const e of elements) {
    const k = elementKind(e);
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k).push(e);
  }
  legend = [...kinds.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([label, els], i) => ({ label, colour: PALETTE[i % PALETTE.length], elements: els, missing: false }));
  el.legendTitle.innerHTML =
    `${esc(group.category)}<small>${esc(group.agencies.join(', '))} · ${elements.length} element${elements.length === 1 ? '' : 's'} · ${kinds.size} kind${kinds.size === 1 ? '' : 's'}</small>`;

  renderTree();
  renderLegend();
  applyOverlay();
}

/** Colours the elements one property applies to by that property's value. */
function selectProperty(group, req) {
  const elements = propertyElements(group, req);
  if (!elements.length) {
    toast(`No elements in the loaded models carry ${req.pset}.${req.prop} under ${group.category}.`);
    return;
  }
  if (elements.some((e) => e.canonicalEntity === 'IFCSPACE') && !spacesVisible) setSpacesVisible(true);

  selection = { group, req };
  soloIndex = -1;

  let ci = 0;
  legend = groupByValue(elements, req).map((g) => ({
    label: g.label,
    colour: g.missing ? MISSING_COLOUR : PALETTE[ci++ % PALETTE.length],
    elements: g.elements,
    missing: g.missing,
  }));
  el.legendTitle.innerHTML =
    `${esc(req.prop)}<small>${esc(group.category)} · ${esc(req.pset)} · ${elements.length} element${elements.length === 1 ? '' : 's'}</small>`;
  // A property query can be fixed in bulk from the legend.
  el.btnSetValue.hidden = !elements.some(canEdit);
  el.legendEdit.classList.remove('visible');

  renderTree();
  renderLegend();
  applyOverlay();
}

/**
 * Opens the property query for one mapping requirement on the CX Queries tab,
 * so every element it applies to is coloured by value and Set value… can fill
 * the gap on all of them.
 */
function queryRequirement(req) {
  const owns = (g) => g.targets.some((t) => t.requirements.includes(req));
  const group = componentGroups(visibleTargets()).find(owns) ||
    componentGroups(ruleset.targets.filter((t) => !gatewayFilter || t.gateway === gatewayFilter)).find(owns);
  if (!group) {
    toast(`${req.pset}.${req.prop} is not among the components shown on CX Queries.`);
    return;
  }
  showTab('query');
  el.left.classList.remove('collapsed');
  selectProperty(group, req);
  if (selection && selection.req === req && !el.btnSetValue.hidden) {
    toast('Every element with this property is coloured by value. Use Set value… in the key to fill them all.');
  }
}

function clearQuery() {
  selection = null;
  legend = [];
  soloIndex = -1;
  el.legend.classList.remove('visible');
  if (viewer) viewer.clearGroups();
  renderTree();
}

function renderLegend() {
  // Bulk edit only makes sense for a property query.
  if (!selection || !selection.req) {
    el.btnSetValue.hidden = true;
    el.legendEdit.classList.remove('visible');
  }
  if (!legend.length) {
    el.legend.classList.remove('visible');
    return;
  }
  el.legend.classList.add('visible');
  el.legendRows.innerHTML = legend.map((g, i) => `
    <div class="lrow${soloIndex >= 0 && soloIndex !== i ? ' muted' : ''}" data-i="${i}">
      <span class="sw" style="background:${hex(g.colour)}"></span>
      <span class="lv" title="${esc(g.label)}">${esc(g.label)}</span>
      <span class="lc">${g.elements.length}</span>
    </div>`).join('');

  el.legendRows.querySelectorAll('.lrow').forEach((row) => {
    row.addEventListener('click', () => {
      const i = +row.dataset.i;
      // Click solos a value; clicking the soloed value again restores all.
      soloIndex = soloIndex === i ? -1 : i;
      renderLegend();
      applyOverlay();
    });
  });
}

/** Pushes the current legend to the viewer, honouring solo. */
function applyOverlay() {
  if (!viewer) return;
  const groups = legend
    .map((g, i) => ({ g, i }))
    .filter(({ i }) => soloIndex < 0 || soloIndex === i)
    .map(({ g }) => ({ elements: g.elements, colour: g.colour }));
  viewer.setQuery(groups, contextMode);
}

// ------------------------------------------------------------- compliance checks

/**
 * What a check module is allowed to do to the app.
 *
 * Modules render their own results but never touch the viewer, the legend or
 * the globals above. Everything they want to happen goes through here, so there
 * is one code path that colours the model no matter which check asked.
 */
const shellActions = {
  showInModel(groups, title, subtitle = '') {
    const usable = (groups || []).filter((g) => g.elements && g.elements.length);
    if (!usable.length) {
      toast('Those elements are not in the loaded models.');
      return;
    }
    legend = usable.map((g) => ({
      label: g.label, colour: g.colour, elements: g.elements, missing: false,
    }));
    selection = null;
    soloIndex = -1;
    // Colouring spaces while spaces are hidden would paint nothing.
    if (usable.some((g) => g.elements.some((e) => e.canonicalEntity === 'IFCSPACE')) && !spacesVisible) {
      setSpacesVisible(true);
    }
    el.legendTitle.innerHTML = `${esc(title)}<small>${esc(subtitle)}</small>`;
    renderLegend();
    applyOverlay();
    renderTree();
  },
  showElement(element) {
    if (element) showElement(element);
  },
  toast(message) {
    toast(message);
  },
  /**
   * Draws survey polygons — a cadastral lot, a site boundary — on the ground
   * plane. Rings arrive in projected metres, and the shell rebuilds the same
   * transform the check used to place them in the scene.
   */
  showSurvey(overlays) {
    if (!viewer || !index) return;
    const transform = buildTransform(index.georef, viewer.coordinationMatrix);
    if (!transform.ok) {
      toast('The model is not georeferenced, so survey outlines cannot be placed.');
      return;
    }
    const ground = viewer.groundLevel();
    viewer.setSurveyOverlays((overlays || []).map((o) => ({
      points: o.ring.map(([E, N]) => transform.svy21ToScene(E, N, 0)),
      colour: o.colour,
      opacity: 0.18,
      elevation: ground,
    })));
    viewer.fitSurvey(SURVEY_REACH_M);
    el.toolSurvey.classList.add('active');
    setRailState(el.toolSurvey, `${overlays.length} outline${overlays.length > 1 ? 's' : ''} drawn — click to clear`);

    // A lot far from the model is drawn where it really is, but left out of the
    // framing; say where it went, since that is the finding.
    const far = farOutlines(overlays, transform);
    if (far.length) {
      toast(far.map((f) => `${f.label} is ${f.distance} ${f.direction} of the model`).join('; ') +
        ' — drawn there, but out of view. Check that this is the right lot, or the model\'s georeferencing.');
    }
  },
};

/** Survey outlines further than this from the model are not framed with it. */
const SURVEY_REACH_M = 1000;

/**
 * Outlines whose centre is beyond SURVEY_REACH_M of the model, with distance
 * and compass direction. Measured in SVY21, where the rings already are; the
 * model is placed by its own outline when a check found one, otherwise by the
 * centre of its geometry.
 */
function farOutlines(overlays, transform) {
  const centre = (ring) => ring.reduce((a, [E, N]) => [a[0] + E / ring.length, a[1] + N / ring.length], [0, 0]);
  const own = overlays.find((o) => o.label === 'Site boundary' || o.label === 'Model extent');
  let E0, N0;
  if (own) {
    [E0, N0] = centre(own.ring);
  } else {
    const hull = viewer.modelHull();
    if (!hull.length) return [];
    const [x, z] = centre(hull); // ground-plane [x, z] pairs, scene coordinates
    ({ E: E0, N: N0 } = transform.sceneToSvy21({ x, y: 0, z }));
  }
  const compass = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return overlays.filter((o) => o !== own).map((o) => {
    const [E, N] = centre(o.ring);
    const d = Math.hypot(E - E0, N - N0);
    const bearing = (Math.atan2(E - E0, N - N0) * 180 / Math.PI + 360) % 360;
    return {
      label: o.label,
      metres: d,
      distance: d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d)} m`,
      direction: compass[Math.round(bearing / 45) % 8],
    };
  }).filter((f) => f.metres > SURVEY_REACH_M);
}

/** Where the project's cadastral lot GeoJSON lives: the geo-referencing check's input. */
const LOT_INPUT_KEY = 'geo-referencing.cadastralLot';
/** Green, as the URA plugin draws a lot (and as the geo-referencing check does). */
const LOT_COLOUR = 0x4fbf6a;

/**
 * The project's cadastral lot, parsed: `{ name, lots, error }`, or null when
 * none is set. Parsing is cheap and the text can change, so it is not cached.
 */
function projectLot() {
  const held = checkInputs.get(LOT_INPUT_KEY);
  if (!held || !held.text) return null;
  try {
    return { name: held.name, lots: parseCadastralGeoJson(held.text).lots, error: null };
  } catch (err) {
    return { name: held.name, lots: [], error: err.message };
  }
}

/**
 * What the survey tool draws: the project's lots, straight from the GeoJSON,
 * plus the model's own outline (site boundary or footprint) when a
 * geo-referencing run has found one. No run is needed to draw the lot.
 */
function surveyOutlines() {
  const lot = projectLot();
  const lots = lot ? lot.lots.map((l) => ({ label: `Lot ${l.key}`, ring: l.ring, colour: LOT_COLOUR })) : [];
  const geo = checkOutcomes.find((o) => o.id === 'geo-referencing' && o.result);
  const own = ((geo && geo.result.detail && geo.result.detail.overlays) || [])
    .filter((o) => !String(o.label).startsWith('Lot '));
  return [...lots, ...own];
}

/** After the lot changes: outlines already on screen are redrawn from the new one. */
function redrawSurveyIfShown() {
  if (viewer && viewer.hasSurveyOverlays) {
    viewer.clearSurveyOverlays();
    el.toolSurvey.classList.remove('active');
    const overlays = surveyOutlines();
    if (overlays.length) shellActions.showSurvey(overlays);
  }
  refreshSurveyRail();
}

/** The survey tool's state line, from what there is to draw. */
function refreshSurveyRail() {
  if (viewer && viewer.hasSurveyOverlays) return; // showSurvey wrote it
  const lot = projectLot();
  const n = surveyOutlines().length;
  setRailState(el.toolSurvey, lot && lot.error ? `${lot.name} could not be read`
    : !n ? 'No lot set — add it in project setup'
      : !viewer || !viewer.hasModels ? `${n} outline${n > 1 ? 's' : ''} ready — load a model to draw`
        : `${n} outline${n > 1 ? 's' : ''} ready — click to draw`);
}

/** Drops the last run's results. Called whenever the model set changes. */
function clearCheckResults() {
  if (checkAbort) checkAbort.abort();
  checkOutcomes = [];
  resultsStale = null;
  checkMenuOpen = true;
  applyCheckMenuFold();
  el.summary.classList.remove('visible');
  el.issues.innerHTML = '';
  el.btnColourStatus.disabled = true;
  // Survey outlines are placed against a particular model's datum, so they are
  // meaningless once the model set changes.
  if (viewer) {
    viewer.clearSurveyOverlays();
    el.toolSurvey.classList.remove('active');
    refreshSurveyRail();
  }
  if (el.checkMenu.children.length) renderCheckMenu();
}

/** Restores the previous selection, falling back to every non-experimental check. */
function loadSelection() {
  const ids = new Set(registry.all().filter((c) => !c.experimental).map((c) => c.id));
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null');
    if (Array.isArray(saved)) {
      const known = saved.filter((id) => registry.byId(id));
      // An empty saved list is a real choice; an unparseable one is not.
      return new Set(known);
    }
  } catch { /* storage blocked or corrupt — fall back to the default */ }
  return ids;
}

function saveSelection() {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...selectedChecks]));
  } catch { /* private window or blocked storage; the session still works */ }
}

/** The menu of available checks, grouped by authority. */
function renderCheckMenu() {
  const groups = registry.byAuthority();

  el.checkMenu.innerHTML = groups.map((group) => `
    <div class="cm-group">
      <div class="cm-head">${esc(group.authority)}</div>
      ${group.checks.map((c) => {
        const outcome = checkOutcomes.find((o) => o.id === c.id);
        let chip = '';
        if (outcome && outcome.error) {
          chip = '<span class="cm-chip bad">failed</span>';
        } else if (outcome && outcome.result) {
          const s = outcome.result.summary;
          chip = s.fail
            ? `<span class="cm-chip bad">${s.fail} issue${s.fail > 1 ? 's' : ''}</span>`
            // A check that asserted nothing has not found the model clean — it
            // has not looked at it. Saying "clean" there would be a lie.
            : s.assertions ? '<span class="cm-chip ok">clean</span>'
              : '<span class="cm-chip">nothing checked</span>';
        } else if (registry.stateOf(c.id) === 'loading') {
          chip = '<span class="cm-chip">loading…</span>';
        }
        return `
        <label class="cm-row" data-id="${esc(c.id)}">
          <input type="checkbox"${selectedChecks.has(c.id) ? ' checked' : ''} />
          <span class="cm-text">
            <span class="cm-name">${esc(c.title)}
              ${c.experimental ? '<span class="cm-tag">no rules yet</span>' : ''}
              ${chip}
            </span>
            <small>${esc(c.summary)}</small>
          </span>
        </label>
        ${selectedChecks.has(c.id) ? renderCheckInputs(c) : ''}`;
      }).join('')}
    </div>`).join('');

  el.checkMenu.querySelectorAll('.cm-row > input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', () => {
      const id = box.closest('.cm-row').dataset.id;
      if (box.checked) selectedChecks.add(id);
      else selectedChecks.delete(id);
      saveSelection();
      // Inputs appear and disappear with their check, so the menu is redrawn.
      renderCheckMenu();
    });
  });

  wireCheckInputs();
  updateRunButton();
  renderProjectChip();
  applyCheckMenuFold();
}

/**
 * Folds the check menu into a one-line bar while there are results, so the
 * results get the panel's height. With nothing to read yet the menu stays open.
 */
function applyCheckMenuFold() {
  const hasResults = checkOutcomes.length > 0;
  const open = !hasResults || checkMenuOpen;
  const n = selectedChecks.size;
  el.checkMenuBar.hidden = !hasResults;
  el.checkMenu.hidden = !open;
  el.checkMenuBarText.textContent = n === 0 ? 'No checks selected'
    : n === 1 ? '1 check selected' : `${n} checks selected`;
  el.checkMenuBarAct.innerHTML = open ? 'Done &#9652;' : 'Edit &#9662;';
}

/** The extra inputs a check declares, shown only while that check is selected. */
function renderCheckInputs(check) {
  if (!check.inputs || !check.inputs.length) return '';

  return `<div class="cm-inputs">${check.inputs.map((input) => {
    const key = check.id + '.' + input.id;
    const held = checkInputs.get(key);
    let control;
    if (input.kind === 'custom') {
      // Filled by the input's own module once the menu is in the page.
      control = `<div class="cm-custom" data-custom="${esc(key)}">
           <div class="cm-help">Loading…</div>
         </div>`;
    } else if (input.kind === 'project') {
      // Supplied once, in project setup; the check only shows what it will use.
      control = `<div class="cm-file">
           <span class="cm-filename">${held ? esc(held.name) : 'Not set'}</span>
           <button class="btn sm" data-open-project>${held ? 'Change' : 'Add'} in project setup</button>
         </div>`;
    } else if (input.kind === 'file') {
      control = `<div class="cm-file">
           <button class="btn sm" data-pick="${esc(key)}">Choose file</button>
           <input type="file" data-file="${esc(key)}" accept="${esc(input.accept || '')}" hidden />
           <span class="cm-filename">${held ? esc(held.name) : 'No file chosen'}</span>
           ${held ? `<button class="btn sm" data-clear="${esc(key)}" title="Remove">&times;</button>` : ''}
         </div>`;
    } else if (input.kind === 'select' && input.inProject) {
      const current = held === undefined ? input.default : held;
      const option = (input.options || []).find((o) => o.value === current);
      control = `<div class="cm-file">
           <span class="cm-filename">${esc(option ? option.label : current)}</span>
           <button class="btn sm" data-open-project>Change in project setup</button>
         </div>`;
    } else if (input.kind === 'select') {
      const current = held === undefined ? input.default : held;
      control = `<select class="cm-select" data-select="${esc(key)}">${
        (input.options || []).map((o) =>
          `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`
        ).join('')}</select>`;
    } else {
      control = `<input type="text" class="cm-textin" data-text="${esc(key)}"
           placeholder="${esc(input.placeholder || '')}" value="${esc(held || '')}" />`;
    }

    return `<div class="cm-input">
      <div class="cm-input-label">${esc(input.label)}</div>
      ${control}
      ${input.help ? `<div class="cm-help">${esc(input.help)}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function wireCheckInputs() {
  el.checkMenu.querySelectorAll('[data-custom]').forEach((host) => {
    const mod = customInputModules.get(host.dataset.custom);
    if (!mod) return;
    Promise.resolve(mod.mount(host, customInputApi)).catch((err) => {
      console.error(err);
      host.innerHTML = '<div class="cm-help">This input could not be shown — see the browser console.</div>';
    });
  });

  el.checkMenu.querySelectorAll('[data-open-project]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // Keep the click from reaching the document listener that closes the panel.
      e.stopPropagation();
      openProjectPanel();
    });
  });

  el.checkMenu.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.checkMenu.querySelector(`[data-file="${CSS.escape(btn.dataset.pick)}"]`).click();
    });
  });

  el.checkMenu.querySelectorAll('[data-file]').forEach((picker) => {
    picker.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        // Read once, here, so the check receives plain text and never touches
        // the file system itself.
        checkInputs.set(picker.dataset.file, { name: file.name, text: await file.text() });
        renderCheckMenu();
      } catch (err) {
        console.error(err);
        toast(`Could not read ${file.name}.`);
      }
      e.target.value = '';
    });
  });

  el.checkMenu.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      checkInputs.delete(btn.dataset.clear);
      renderCheckMenu();
    });
  });

  el.checkMenu.querySelectorAll('[data-text]').forEach((box) => {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('input', () => {
      const v = box.value.trim();
      if (v) checkInputs.set(box.dataset.text, v);
      else checkInputs.delete(box.dataset.text);
      renderProjectChip();
    });
  });

  el.checkMenu.querySelectorAll('[data-select]').forEach((box) => {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', (e) => {
      e.stopPropagation();
      if (box.dataset.select === 'ura.gateway') {
        setGateway(box.value);
        refreshFilters();
        return;
      }
      checkInputs.set(box.dataset.select, box.value);
      renderProjectChip();
    });
  });
}

/** Everything the user has supplied for one check, keyed by input id. */
function inputsFor(checkId) {
  const meta = registry.byId(checkId);
  const out = {};
  for (const input of (meta && meta.inputs) || []) {
    if (input.kind === 'custom') {
      const mod = customInputModules.get(checkId + '.' + input.id);
      if (mod) out[input.id] = mod.value();
      continue;
    }
    const held = checkInputs.get(checkId + '.' + input.id);
    // A select the user never touched still has the value the menu is showing.
    if (held !== undefined) out[input.id] = held;
    else if (input.default !== undefined) out[input.id] = input.default;
  }
  return out;
}

function updateRunButton() {
  const n = selectedChecks.size;
  el.btnRunCheck.disabled = !index || n === 0 || checkRunning;
  el.btnRunCheck.textContent = checkRunning
    ? 'Checking…'
    : n === 0 ? 'Select a check'
      : n === 1 ? 'Run 1 check' : `Run ${n} checks`;
}

/** Runs every selected check, in menu order. */
async function doRunCheck() {
  if (!index || !ruleset || !selectedChecks.size || checkRunning) return;

  const ids = registry.all().map((c) => c.id).filter((id) => selectedChecks.has(id));

  if (checkAbort) checkAbort.abort();
  checkAbort = new AbortController();

  checkRunning = true;
  updateRunButton();
  el.issues.innerHTML = '<div class="empty-note">Running…</div>';

  const ctx = {
    index,
    ruleset,
    modelNames: new Map(viewer.entries.map((e) => [e.modelID, e.name])),
    filter: (t) =>
      (!gatewayFilter || t.gateway === gatewayFilter) && inScope(t),
    signal: checkAbort.signal,
    progress: () => {},
    inputsFor,
    // The submitted files themselves, for the checks that are about the
    // submission rather than about the building.
    files: viewer.entries.map((e) => ({ modelID: e.modelID, name: e.name, bytes: e.bytes })),
    // Where the model sits, and what it is made of — needed by checks that ask
    // about position rather than properties.
    coordinationMatrix: viewer.coordinationMatrix,
    geometry: {
      // Hulls rather than raw points: the affine transform to survey
      // coordinates preserves convexity, so hulling in scene space first is
      // both exact and far cheaper than transforming millions of vertices.
      elementHull: (elements) => viewer.elementHull(elements),
      modelHull: () => viewer.modelHull(),
      groundLevel: () => viewer.groundLevel(),
    },
  };

  try {
    checkOutcomes = await runChecks(ids, ctx, (msg) => {
      el.issues.innerHTML = `<div class="empty-note">${esc(msg)}</div>`;
    });
    resultsStale = null;
    // The setup has done its job; give the results the room.
    checkMenuOpen = false;
    refreshSurveyRail();
    renderSummary();
    renderCheckResults();
    renderCheckMenu();
    el.btnColourStatus.disabled = !checkOutcomes.some((o) => o.result);
    el.btnToBcf.disabled = !checkOutcomes.some((o) => o.result && o.result.findings &&
      o.result.findings.some((f) => f.severity === SEVERITY.FAIL || f.severity === SEVERITY.WARN));
    el.btnReport.disabled = !checkOutcomes.length;
    // The run is the moment a model's results are known: record them, so a
    // submission checked one file at a time still adds up in the project file.
    // Recording is a convenience; a failure here must not lose the results.
    try {
      captureModelRecords();
    } catch (err) {
      console.error('The models could not be recorded in the project:', err);
    }

    const broken = checkOutcomes.filter((o) => o.error);
    if (broken.length) {
      toast(`${broken.length} check${broken.length > 1 ? 's' : ''} could not run — see the browser console.`);
    }
  } catch (err) {
    console.error(err);
    toast('The compliance check failed — see the browser console.');
  } finally {
    checkRunning = false;
    updateRunButton();
  }
}

/** Headline numbers across every check that ran. */
function renderSummary() {
  const t = totalsOf(checkOutcomes);
  const pct = t.assertions ? Math.round((t.pass / t.assertions) * 100) : 0;
  const scope = [gatewayFilter && GATEWAY_LABEL[gatewayFilter], agencyFilter]
    .filter(Boolean).join(' · ') || 'All gateways';
  const names = checkOutcomes.filter((o) => o.result).map((o) => o.meta.title).join(', ');

  const num = (n) => n.toLocaleString();
  // One line for what matters; the rest is a click away. The percentage is of
  // requirement checks (one property on one element, one URA rule…), not of
  // elements, so it says so.
  const headline = t.assertions
    ? `<b style="color:var(--ok)" title="${num(t.pass)} of ${num(t.assertions)} requirement checks pass. A requirement check is one requirement tested on one element.">${pct}% of requirements met</b>
       · <button class="sissues" data-show-issues title="Show only what fails"
           style="color:${t.fail ? 'var(--danger)' : 'var(--ok)'}">${num(t.fail)} issue${t.fail === 1 ? '' : 's'}</button>
       · ${num(t.elements)} element${t.elements === 1 ? '' : 's'} checked`
    : '<b>Nothing checked</b>';

  el.summary.classList.add('visible');
  el.summary.innerHTML = `
    ${resultsStale ? `<div class="stale-note">
      <span><b>Out of date.</b> ${esc(resultsStale)}</span>
      <button class="btn sm primary" data-rerun>Re-run</button>
    </div>` : ''}
    <div class="sbar">
      <i style="width:${pct}%;background:var(--ok)"></i>
      <i style="width:${100 - pct}%;background:var(--danger)"></i>
    </div>
    <div class="sline">
      <span>${headline}</span>
      <label class="stoggle" title="Hide passing rows, clean rules and clean checks">
        <input type="checkbox" data-issues-only${issuesOnly ? ' checked' : ''} /> Issues only
      </label>
    </div>
    <details class="sdetails"><summary>Details</summary>
    <div class="sgrid">
      <span class="k">Checks run</span><span class="v">${esc(names || 'none')}</span>
      <span class="k">Scope</span><span class="v">${esc(scope)}</span>
      <span class="k">Models</span><span class="v">${viewer.entries.length}</span>
      <span class="k">Elements checked</span><span class="v">${t.elements}</span>
      <span class="k">Requirement checks</span><span class="v">${t.assertions}</span>
      <span class="k">Met</span><span class="v" style="color:var(--ok)">${t.pass} (${pct}%)</span>
      <span class="k">Issues</span><span class="v" style="color:var(--danger)">${t.fail}</span>
    </div></details>`;

  const toggle = el.summary.querySelector('[data-issues-only]');
  toggle.addEventListener('change', (e) => {
    issuesOnly = e.target.checked;
    el.issues.classList.toggle('issues-only', issuesOnly);
  });
  // The issue count is the way into them.
  const show = el.summary.querySelector('[data-show-issues]');
  if (show) {
    show.addEventListener('click', () => {
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      el.issues.scrollTop = 0;
    });
  }
  const rerun = el.summary.querySelector('[data-rerun]');
  if (rerun) rerun.addEventListener('click', doRunCheck);
}

/**
 * Marks the last run's results as no longer describing the model, without
 * throwing them away: the user decides when to re-run.
 */
function markResultsStale(reason) {
  if (!checkOutcomes.length) return;
  resultsStale = reason;
  renderSummary();
}

/** Errors first, then most issues first; ties keep the menu's order. */
function outcomeRank(o) {
  if (o.error) return Number.MAX_SAFE_INTEGER;
  return o.result ? o.result.summary.fail || 0 : 0;
}

/**
 * One section per check. The module renders its own body, so the shell never
 * needs to understand what any particular check found.
 */
function renderCheckResults() {
  el.issues.innerHTML = '';
  el.issues.classList.toggle('issues-only', issuesOnly);

  if (!checkOutcomes.length) {
    el.issues.innerHTML = '<div class="empty-note">No checks were run.</div>';
    return;
  }

  // Array sort is stable, so equal ranks stay in menu order.
  const ordered = checkOutcomes.slice().sort((a, b) => outcomeRank(b) - outcomeRank(a));

  for (const outcome of ordered) {
    const section = document.createElement('div');
    const summary = outcome.result ? outcome.result.summary : null;
    // Only checks that found something open by default; a clean check is one line.
    const clean = !outcome.error && !(summary && summary.fail);
    section.className = 'check-result' + (clean ? ' clean collapsed' : '');

    const pill = outcome.error
      ? '<span class="pill bad">error</span>'
      : summary && summary.fail ? `<span class="pill bad">${summary.fail}</span>`
        // "Nothing checked" is not "clean": a check with no rules, or one whose
        // rules all fell out of scope, asserted nothing about this model.
        : summary && summary.assertions ? '<span class="pill ok">clean</span>'
          : '<span class="pill">nothing checked</span>';

    section.innerHTML = `
      <div class="cr-head" title="Show or hide this check's results">
        <span class="cr-caret">&#9662;</span>
        <span class="cr-title">${esc(outcome.meta.title)}
          <small>${esc(outcome.meta.authority)} · ${Math.round(outcome.ms)} ms</small>
        </span>${pill}
      </div>
      ${outcome.result && outcome.result.note
        ? `<div class="cr-note">${esc(outcome.result.note)}</div>` : ''}
      <div class="cr-body"></div>`;

    const body = section.querySelector('.cr-body');
    section.querySelector('.cr-head').addEventListener('click', () => {
      section.classList.toggle('collapsed');
    });

    if (outcome.error) {
      body.innerHTML =
        `<div class="empty-note">This check could not run.<br><code>${esc(outcome.error.message)}</code></div>`;
    } else {
      const module = registry.peek ? registry.peek(outcome.id) : null;
      const renderer = module && typeof module.render === 'function' ? module.render : null;
      if (renderer) renderer(outcome.result, body, shellActions);
      else renderGenericFindings(outcome.result, body);
    }

    el.issues.appendChild(section);
  }
}

/** Fallback results view for a module that does not render its own. */
function renderGenericFindings(result, host) {
  const findings = result.findings || [];
  if (!findings.length) {
    host.innerHTML = '<div class="empty-note">Nothing to report.</div>';
    return;
  }
  const shown = findings.slice(0, 300);
  host.innerHTML = '<div class="ilist">' + shown.map((f, i) => `
    <div class="irow${f.element ? ' pick' : ''}" data-sev="${esc(f.severity)}" data-f="${i}">
      <span class="status-dot" style="background:${hex(SEVERITY_COLOUR[f.severity] || SEVERITY_COLOUR.fail)}"></span>
      <span class="ik">${esc(f.label || f.code)}
        <span class="imsg">${esc(f.message || '')}</span></span>
    </div>`).join('') + '</div>';

  host.querySelectorAll('.irow.pick').forEach((row) => {
    row.addEventListener('click', () => showElement(shown[+row.dataset.f].element));
  });
}

/**
 * Colours every checked element by its worst severity across every check that
 * ran, so one view answers "where are the problems" regardless of which check
 * found them.
 */
function colourByStatus() {
  if (!checkOutcomes.length) return;

  const worst = new Map();   // element key -> severity

  for (const outcome of checkOutcomes) {
    if (!outcome.result) continue;
    for (const key of outcome.result.summary.elementKeys || []) {
      if (!worst.has(key)) worst.set(key, SEVERITY.PASS);
    }
    for (const f of outcome.result.findings || []) {
      if (!f.element) continue;
      const current = worst.get(f.element.key) || SEVERITY.PASS;
      worst.set(f.element.key, worstOf([current, f.severity]));
    }
  }

  if (!worst.size) {
    toast('No elements were checked, so there is nothing to colour.');
    return;
  }

  const buckets = new Map();
  for (const [key, severity] of worst) {
    if (!buckets.has(severity)) buckets.set(severity, []);
    const element = index.byId.get(key);
    if (element) buckets.get(severity).push(element);
  }

  const groups = SEVERITY_ORDER
    .filter((s) => buckets.has(s) && buckets.get(s).length)
    .map((s) => ({
      label: SEVERITY_LABEL[s],
      colour: SEVERITY_COLOUR[s],
      elements: buckets.get(s),
    }));

  shellActions.showInModel(groups, 'Compliance status',
    `${worst.size} element${worst.size === 1 ? '' : 's'} across ${checkOutcomes.filter((o) => o.result).length} checks`);
}

// ----------------------------------------------------------------- dashboard

let dashResult = null;

/** Cards folded down to their headline, remembered in this browser. */
const DASH_FOLDS_KEY = 'rsp.dashCollapsed';
const dashCollapsed = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(DASH_FOLDS_KEY) || '[]'));
  } catch {
    return new Set();
  }
})();
function saveDashFolds() {
  try {
    localStorage.setItem(DASH_FOLDS_KEY, JSON.stringify([...dashCollapsed]));
  } catch { /* storage blocked */ }
}
/** Cards whose "not set" list is open; closed again each session. */
const dashUnsetOpen = new Set();

/** Sums recorded breakdown rows into a map keyed by label. */
function addRows(into, rows) {
  for (const r of rows || []) {
    const row = into.get(r.label) || { label: r.label, value: 0, count: 0 };
    row.value += r.value || 0;
    row.count += r.count || 0;
    into.set(r.label, row);
  }
}

const byValueDesc = (a, b) => b.value - a.value || b.count - a.count || a.label.localeCompare(b.label);

/** File names ascending, numeric-aware so ...-9 sorts before ...-10. */
const byFileName = (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The dashboard, assembled from what the project has recorded for every model
 * — the totals a submission reports, whether or not the files are open.
 *
 * The record is the source of truth: each model's quantities are extracted
 * when it loads (see buildModelRecord) and stay in the project file, so
 * unloading a file takes its geometry out of the viewer without taking its
 * area out of the total. A currently loaded model's live metric is carried
 * alongside as `live`, which is all that "Show in model" needs.
 *
 * @param {object|null} liveDash  the dashboard of the loaded models, or null
 */
function computeProjectDashboard(liveDash) {
  const records = (project && project.models) || [];
  const liveById = new Map((liveDash ? liveDash.metrics : []).map((m) => [m.id, m]));

  const metrics = DASHBOARD_METRICS.map((spec) => {
    const byFile = [];
    const byLevel = new Map();
    const byType = new Map();
    const byGroup = new Map();
    const subtotals = new Map();
    const sources = new Set();
    const near = new Map();
    let total = 0;
    let count = 0;
    let candidates = 0;
    let missingValue = 0;
    const unset = [];

    for (const r of records) {
      const m = (r.dashboard || []).find((x) => x.id === spec.id);
      if (!m) continue;
      total += m.total || 0;
      count += m.count || 0;
      candidates += m.candidates || 0;
      missingValue += m.missingValue || 0;
      for (const s of m.valueSources || []) sources.add(s);
      if (m.count) byFile.push({ label: r.name, value: m.total || 0, count: m.count });
      addRows(byLevel, m.byLevel);
      addRows(byType, m.byType);
      addRows(byGroup, m.byGroup);
      addRows(subtotals, m.subtotals);
      // The record's name, not the one stored with the row, so a renamed file
      // lists its spaces under the name shown everywhere else.
      for (const u of m.unset || []) unset.push({ ...u, file: r.name });
      for (const n of m.nearMisses || []) near.set(n.label, (near.get(n.label) || 0) + n.count);
    }

    return {
      id: spec.id, title: spec.title, entity: spec.entity, unit: spec.unit, decimals: spec.decimals,
      source: spec.source, note: spec.note || null, whereLabel: spec.whereLabel || null,
      isCount: !spec.measure,
      candidates, present: count > 0, count, total, missingValue,
      valueSources: [...sources],
      // Declared order, so a subtotal a file never reported still reads as zero
      // rather than disappearing.
      subtotals: (spec.subtotals || []).map((s) =>
        subtotals.get(s.label) || { label: s.label, value: 0, count: 0 }),
      nearMisses: count ? [] : [...near.entries()].map(([label, n]) => ({ label, count: n }))
        .sort((a, b) => b.count - a.count),
      byType: [...byType.values()].sort(byValueDesc),
      groupTitle: spec.groupBy ? spec.groupBy.title : null,
      byGroup: [...byGroup.values()].sort(byValueDesc),
      // Files read as a list of submitted drawings, so they keep their own
      // order rather than being ranked by size.
      byFile: byFile.sort(byFileName),
      byLevel: [...byLevel.values()].sort(byValueDesc),
      requiredLabel: spec.required ? spec.required.label : null,
      // In the order they would be fixed: file by file, level by level.
      unset: unset.sort((a, b) => byFileName({ label: a.file }, { label: b.file })
        || String(a.storey).localeCompare(String(b.storey), undefined, { numeric: true })
        || String(a.name).localeCompare(String(b.name), undefined, { numeric: true })),
      live: liveById.get(spec.id) || null,
    };
  });

  const missing = metrics.filter((m) => !m.present);
  const incomplete = metrics.filter((m) => m.present && m.missingValue > 0);
  const unsetRequired = metrics.filter((m) => m.unset.length);
  return {
    metrics,
    summary: {
      total: metrics.length,
      present: metrics.length - missing.length,
      missing: missing.map((m) => m.title),
      incomplete: incomplete.map((m) => ({ title: m.title, missing: m.missingValue, of: m.count })),
      unsetRequired: unsetRequired.map((m) =>
        ({ title: m.title, property: m.requiredLabel, missing: m.unset.length, of: m.count })),
    },
  };
}

function openDashboard() {
  // Recording first means an open dashboard always reflects what is loaded
  // now, including any property edits made since the file was opened.
  if (viewer.hasModels) {
    try {
      captureModelRecords();
    } catch (err) {
      console.error('The models could not be recorded in the project:', err);
    }
  }
  const records = (project && project.models) || [];
  if (!records.length) {
    toast('Load an IFC model first.');
    return;
  }

  const liveDash = index
    ? computeDashboard(index, new Map(viewer.entries.map((e) => [e.modelID, e.name])))
    : null;
  dashResult = computeProjectDashboard(liveDash);

  const loaded = viewer.entries.length;
  const unloaded = records.length - loaded;
  el.dashSub.textContent =
    `${records.length} model${records.length > 1 ? 's' : ''} in the project · ` +
    (unloaded > 0 ? `${loaded} loaded, ${unloaded} from the project record · ` : 'all loaded · ') +
    `${dashResult.summary.present} of ${dashResult.summary.total} metrics found`;
  renderDashboard();
  closeTopPanels('dash');
  el.dash.classList.add('visible');
  el.btnDash.classList.add('active');
}

function closeDashboard() {
  el.dash.classList.remove('visible');
  el.btnDash.classList.remove('active');
}

/**
 * The model list, the project panel and the dashboard share the top bar's
 * left side; opening one closes the others.
 * @param {'models'|'project'|'dash'} keep  the one being opened
 */
function closeTopPanels(keep) {
  if (keep !== 'models') el.modelPicker.classList.remove('open');
  if (keep !== 'project') el.projectPicker.classList.remove('open');
  if (keep !== 'dash') closeDashboard();
}

function renderDashboard() {
  if (!dashResult) return;
  const { metrics, summary } = dashResult;
  const parts = [];

  const unloaded = ((project && project.models) || []).length - viewer.entries.length;
  if (unloaded > 0) {
    parts.push(`
      <div class="dash-alert">
        <b>${unloaded} model${unloaded > 1 ? 's are' : ' is'} not loaded —</b> ${unloaded > 1 ? 'their' : 'its'}
        quantities are counted from the project record, taken when the file was last open.
        Load the file again to highlight its elements in the 3D view.
      </div>`);
  }

  // Quantities the submission does not contain at all are listed after the
  // real figures, in their own compact section, rather than in a banner.
  if (summary.incomplete.length) {
    parts.push(`
      <div class="dash-alert warn">
        <b>Elements found but no value authored —</b> these totals understate the real figure.
        <ul>${summary.incomplete.map((m) =>
          `<li>${esc(m.title)}: ${m.missing} of ${m.of} elements have no value</li>`).join('')}</ul>
      </div>`);
  }
  if (summary.unsetRequired.length) {
    parts.push(`
      <div class="dash-alert warn">
        <b>Required property not set —</b> these elements are counted in the total but cannot be attributed.
        <ul>${summary.unsetRequired.map((m) =>
          `<li>${esc(m.title)}: ${m.missing} of ${m.of} elements have no <code>${esc(m.property)}</code></li>`).join('')}</ul>
      </div>`);
  }

  parts.push('<div class="cards">');
  const ordered = [...metrics.filter((m) => m.present), ...metrics.filter((m) => !m.present)];
  let absentStarted = false;
  for (const m of ordered) {
    if (!m.present && !absentStarted) {
      absentStarted = true;
      parts.push(`</div><div class="dash-sub">Not found in the submission
        <small>${summary.missing.length} of ${summary.total} reported quantities have no matching elements. Open a card to see why.</small></div>
        <div class="cards compact">`);
    }
    const rows = dashBreakdown === 'file' ? m.byFile : dashBreakdown === 'level' ? m.byLevel : [];
    const brkTitle = dashBreakdown === 'file' ? 'BY FILE' : 'BY LEVEL';

    const flag = !m.present
      ? '<span class="flag">Not found</span>'
      : m.missingValue
        ? `<span class="flag partial">${m.missingValue} without value</span>`
        : m.unset.length
          ? `<span class="flag partial">${m.unset.length} not set</span>`
          : '<span class="flag ok">OK</span>';

    // Missing quantities start folded; the stored set holds the cards the user
    // flipped from their default.
    const folded = m.present ? dashCollapsed.has(m.id) : !dashCollapsed.has(m.id);
    parts.push(`<div class="card${m.present ? '' : ' absent'}${folded ? ' collapsed' : ''}" data-m="${esc(m.id)}">
      <div class="card-head">
        <div class="ct"><h3>${esc(m.title)}</h3>${flag}<button class="card-fold" data-act="fold"
          title="${folded ? 'Expand' : 'Collapse'} this card" aria-expanded="${!folded}">${folded ? '&#9656;' : '&#9662;'}</button></div>
        <div class="card-val${m.present ? '' : ' none'}">${
          m.present ? esc(fmtNum(m.total, m.decimals)) : '—'
        }<small>${esc(m.unit)}</small></div>
        <div class="card-meta">${
          m.present
            ? `${m.count} element${m.count > 1 ? 's' : ''}` +
              (m.whereLabel ? ` · ${esc(m.whereLabel)}` : '') +
              (m.candidates > m.count ? ` · ${m.candidates - m.count} excluded by filter` : '')
            : 'no matching elements'
        }</div>
      </div>`);

    if (!m.present) {
      parts.push('<div class="card-empty">');
      if (m.whereExcluded) {
        // Matched the subtype fine — the `where` filter is what zeroed it out.
        // Missing entirely vs. set false changes what the architect does next.
        const { total, missingProperty } = m.whereExcluded;
        parts.push(`${total} element${total > 1 ? 's' : ''} matched the mapping's subtype, but
          every one was excluded by <code>${esc(m.whereLabel || 'the filter')}</code>. ${
          missingProperty === total
            ? `None of them carry that property at all — this looks like a verification ` +
              `step that has not been run yet, not an absence of floor area.`
            : missingProperty > 0
              ? `${missingProperty} of them do not carry the property at all; the rest have it set to false.`
              : `All of them have the property explicitly set to false.`
        }`);
      } else if (m.nearMisses.length) {
        // The elements exist but are typed differently — that is a finding, not
        // an absence, and the distinction changes what the architect does next.
        parts.push(`Nothing matches the mapping's subtype, but similarly named
          elements are present. They would not be found by the authority's query:
          <table class="brk" style="margin-top:6px">${m.nearMisses.map((n) =>
            `<tr><td class="k">${esc(n.label)}</td><td class="c">${n.count}</td></tr>`).join('')}</table>`);
      } else {
        parts.push(`Nothing in the project's models matches this definition. Either the
          elements are not modelled, or their ObjectType is not set as the mapping requires.`);
      }
      parts.push('</div>');
    } else {
      parts.push('<div class="card-body">');

      if (m.subtotals && m.subtotals.length) {
        parts.push(`<div class="brk-title">OF WHICH</div><table class="brk">`);
        for (const s of m.subtotals) {
          parts.push(`<tr><td class="k">${esc(s.label)}</td>
            <td class="n">${esc(fmtNum(s.value, m.decimals))} ${esc(m.unit)}</td>
            <td class="c">${s.count}</td></tr>`);
        }
        parts.push('</table>');
      }

      if (m.byType.length > 1 || (m.byType.length === 1 && m.isCount)) {
        parts.push(`<div class="brk-title">BY TYPE</div><table class="brk">`);
        for (const r of m.byType) {
          parts.push(`<tr><td class="k">${esc(r.label)}</td>
            <td class="n">${esc(fmtNum(r.value, m.decimals))}${m.isCount ? '' : ' ' + esc(m.unit)}</td>
            <td class="c">${m.isCount ? '' : r.count}</td></tr>`);
        }
        parts.push('</table>');
      }

      if (m.groupTitle && m.byGroup.length) {
        parts.push(`<div class="brk-title">${esc(m.groupTitle)}</div><table class="brk">`);
        for (const r of m.byGroup) {
          parts.push(`<tr><td class="k">${esc(r.label)}</td>
            <td class="n">${esc(fmtNum(r.value, m.decimals))}${m.isCount ? '' : ' ' + esc(m.unit)}</td>
            <td class="c">${r.count}</td></tr>`);
        }
        parts.push('</table>');
      }

      if (m.unset.length) {
        // Each space by name, so the missing ones can be found and fixed rather
        // than only counted. A loaded one is selected in the 3D view on click.
        const unsetTotal = m.unset.reduce((t, u) => t + (u.value || 0), 0);
        const liveIds = new Set(((m.live && m.live.unset) || []).map((u) => u.globalId).filter(Boolean));
        const multiFile = new Set(m.unset.map((u) => u.file)).size > 1;
        // Folded by default: hundreds of rooms would push every other card off
        // screen. Opened, the list scrolls inside the card for the same reason.
        const listOpen = dashUnsetOpen.has(m.id);
        parts.push(`<button class="brk-title unset brk-toggle" data-act="unset-list" aria-expanded="${listOpen}">
          <span>${listOpen ? '&#9662;' : '&#9656;'}</span> ${esc(m.requiredLabel)} NOT SET · ${m.unset.length} element${
          m.unset.length > 1 ? 's' : ''} · ${esc(fmtNum(unsetTotal, m.decimals))} ${esc(m.unit)}</button>
          <div class="brk-scroll"${listOpen ? '' : ' hidden'}><table class="brk">`);
        for (const u of m.unset) {
          const live = u.globalId && liveIds.has(u.globalId);
          parts.push(`<tr${live ? ` class="pick" data-gid="${esc(u.globalId)}" title="Select in the 3D view"` : ''}>
            <td class="k">${esc(u.name)}<small>${esc(u.storey)}${multiFile ? ` · ${esc(u.file)}` : ''}</small></td>
            <td class="n">${esc(fmtNum(u.value || 0, m.decimals))} ${esc(m.unit)}</td></tr>`);
        }
        parts.push('</table></div>');
      }

      if (rows.length) {
        parts.push(`<div class="brk-title">${brkTitle}</div><table class="brk">`);
        for (const r of rows) {
          parts.push(`<tr><td class="k">${esc(r.label)}</td>
            <td class="n">${esc(fmtNum(r.value, m.decimals))}${m.isCount ? '' : ' ' + esc(m.unit)}</td>
            <td class="c">${m.isCount ? '' : r.count}</td></tr>`);
        }
        parts.push('</table>');
      }
      parts.push('</div>');
      // Only the loaded part of a metric can be highlighted: the record holds
      // the figures, never the elements they were measured from.
      if (m.live && m.live.count) {
        parts.push(`<div class="card-actions">
          <button class="btn sm" data-act="show">Show in model${
            m.live.count < m.count ? ` (${m.live.count} of ${m.count} loaded)` : ''
          }</button>${m.live.unsetElements && m.live.unsetElements.length
            ? `<button class="btn sm" data-act="show-unset">Show not set (${m.live.unsetElements.length})</button>`
            : ''}</div>`);
      }
    }

    const srcBits = [m.source];
    if (m.valueSources.length) srcBits.push(`Value read from ${m.valueSources.join(', ')}`);
    if (m.note) srcBits.push(m.note);
    parts.push(`<div class="card-src">${srcBits.map(esc).join('<br>')}</div></div>`);
  }
  parts.push('</div>');

  el.dashBody.innerHTML = parts.join('');

  // Folding toggles in place: a re-render would lose the scroll position.
  el.dashBody.querySelectorAll('[data-act="fold"]').forEach((b) => {
    b.addEventListener('click', () => {
      const card = b.closest('.card');
      const folded = card.classList.toggle('collapsed');
      // Stored as a flip from the card's default (missing ones start folded).
      const flipped = card.classList.contains('absent') ? !folded : folded;
      if (flipped) dashCollapsed.add(card.dataset.m);
      else dashCollapsed.delete(card.dataset.m);
      b.innerHTML = folded ? '&#9656;' : '&#9662;';
      b.title = `${folded ? 'Expand' : 'Collapse'} this card`;
      b.setAttribute('aria-expanded', String(!folded));
      saveDashFolds();
    });
  });
  el.dashBody.querySelectorAll('[data-act="unset-list"]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.closest('.card').dataset.m;
      const list = b.nextElementSibling;
      list.hidden = !list.hidden;
      if (list.hidden) dashUnsetOpen.delete(id);
      else dashUnsetOpen.add(id);
      b.querySelector('span').innerHTML = list.hidden ? '&#9656;' : '&#9662;';
      b.setAttribute('aria-expanded', String(!list.hidden));
    });
  });

  el.dashBody.querySelectorAll('[data-act="show"]').forEach((b) => {
    b.addEventListener('click', () => {
      const m = metrics.find((x) => x.id === b.closest('.card').dataset.m);
      if (m && m.live) showMetricInModel(m.live);
    });
  });
  el.dashBody.querySelectorAll('[data-act="show-unset"]').forEach((b) => {
    b.addEventListener('click', () => {
      const m = metrics.find((x) => x.id === b.closest('.card').dataset.m);
      if (m && m.live) showUnsetInModel(m.live);
    });
  });
  el.dashBody.querySelectorAll('tr.pick[data-gid]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const m = metrics.find((x) => x.id === tr.closest('.card').dataset.m);
      const item = m && m.live && m.live.unsetElements.find((e) => e.globalId === tr.dataset.gid);
      if (!item) return;
      if (m.entity === 'IFCSPACE' && !spacesVisible) setSpacesVisible(true);
      closeDashboard();
      showElement(item);
    });
  });
}

/**
 * Colours a metric's elements by whether its required property is set, so the
 * spaces still missing it stand out against the ones already done.
 */
function showUnsetInModel(metric) {
  const unset = new Set(metric.unsetElements);
  const done = metric.elements.filter((e) => !unset.has(e));
  legend = [
    { label: `${metric.requiredLabel} not set`, colour: PALETTE[0], elements: metric.unsetElements, missing: false },
    ...(done.length
      ? [{ label: `${metric.requiredLabel} set`, colour: PALETTE[1], elements: done, missing: false }]
      : []),
  ];

  selection = null;
  soloIndex = -1;
  if (metric.entity === 'IFCSPACE' && !spacesVisible) setSpacesVisible(true);
  el.legendTitle.innerHTML =
    `${esc(metric.title)}<small>${metric.unsetElements.length} of ${metric.count} without ${esc(metric.requiredLabel)}</small>`;
  renderLegend();
  applyOverlay();
  closeDashboard();
}

/** Colours a metric's elements in the 3D view and closes the overlay. */
function showMetricInModel(metric) {
  // Colour per lot/bin type where the metric has one, otherwise a single bucket.
  const byType = metric.byType.filter((t) => t.elements.length);
  legend = byType.length > 1
    ? byType.map((t, i) => ({
        label: t.label,
        colour: PALETTE[i % PALETTE.length],
        elements: t.elements,
        missing: false,
      }))
    : [{ label: metric.title, colour: SINGLE_COLOUR, elements: metric.elements, missing: false }];

  selection = null;
  soloIndex = -1;
  if (metric.entity === 'IFCSPACE' && !spacesVisible) setSpacesVisible(true);
  el.legendTitle.innerHTML =
    `${esc(metric.title)}<small>${metric.count} element${metric.count === 1 ? '' : 's'} · ${esc(fmtNum(metric.total, metric.decimals))} ${esc(metric.unit)}</small>`;
  renderLegend();
  applyOverlay();
  closeDashboard();
}

// ------------------------------------------------------------- element inspector

/**
 * The indexed element a pick lands on. A geometry-less aggregate (a stair) can
 * never be hit directly, so a hit on one of its parts resolves to the host when
 * the part is not itself mapped (a stringer), and to the part when it is (a
 * flight, which has requirements of its own and links back to its host).
 */
function pickedElement(hit) {
  if (!hit || !index) return null;
  const key = `${hit.modelID}:${hit.expressID}`;
  const item = index.byId.get(key);
  if (item) return item;
  const hostKey = index.hostOf.get(key);
  return hostKey ? index.byId.get(hostKey) || null : null;
}

function onPick(hit) {
  // A section drag ends with a click on the same element; while armed, that
  // click is drawing intent, not a pick.
  if (sectionArmed) return;
  if (!hit || !index) {
    closeElementPanel();
    return;
  }
  const item = pickedElement(hit);
  if (!item) {
    viewer.setSelection(hit);
    el.panelBody.innerHTML =
      `<div class="prop-type">Element ${hit.expressID}</div>
       <div class="prop-id">Not covered by the IFC-SG mapping</div>`;
    el.panel.classList.add('visible');
    return;
  }
  showElement(item);
}

/** Hides the properties panel and drops the 3D highlight with it. */
function closeElementPanel() {
  el.panel.classList.remove('visible');
  viewer.clearSelection();
  if (mtSelected) {
    mtSelected = null;
    renderModelTab();
  }
}

function showElement(item) {
  const modelName = viewer.models.get(item.modelID)?.name;
  const rows = [
    ['Entity', item.entity],
    ['PredefinedType', item.predefinedType],
    ['ObjectType', item.objectType],
    ['Storey', item.storey],
    ['Model', viewer.entries.length > 1 ? modelName : null],
    ['Tag', item.tag],
    ['GlobalId', item.globalId],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  // Re-rendering the same element after an edit keeps the camera where the user left it.
  const sel = viewer.selection;
  viewer.setSelection(item, { pivot: !sel || sel.modelID !== item.modelID || sel.expressID !== item.expressID });
  lastPicked = item;
  revealInModelTree(item);
  const editable = canEdit(item);
  const fixable = []; // requirements behind the "Fix" buttons, by index
  let html = `<div class="prop-type">${esc(item.name || item.entity)}${editable
    ? ' <button class="btn xs" data-rename title="Rename this element in the IFC">Rename</button>' : ''}</div>
              <div class="prop-id">Express ID ${item.expressID}</div>`;
  html += rows.map(([k, v]) =>
    `<div class="prop-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

  // A flight is picked, but the FireExit the authority asks about sits on the
  // stair that aggregates it. Link the two so neither reads as missing.
  const host = item.hostKey ? index.byId.get(item.hostKey) : null;
  if (host) {
    html += `<div class="prop-row"><span class="k">Part of</span>
             <span class="v"><a href="#" data-host="${esc(host.key)}">${esc(host.name || host.entity)}</a>
             <small>${esc(host.entity)}</small></span></div>`;
  }
  if (item.parts && item.parts.length) {
    const n = item.parts.length;
    html += `<div class="prop-row"><span class="k">Geometry</span>
             <span class="v">${n} aggregated part${n === 1 ? '' : 's'}</span></div>`;
  }

  // Live pass/fail from every loaded check that can explain one element. This is
  // evaluated on demand, so it is correct whether or not a check has been run,
  // and a check the user has never loaded simply contributes nothing.
  if (ruleset) {
    // Same gateway and authority scope as a check run, so the panel agrees with
    // the Compliance tab (and does not list a requirement once per gateway).
    const ctx = {
      index, ruleset, modelNames: new Map(),
      filter: (t) => (!gatewayFilter || t.gateway === gatewayFilter) && inScope(t),
    };

    for (const { meta, module } of registry.loadedModules()) {
      if (typeof module.explain !== 'function') continue;

      let findings = [];
      try {
        findings = module.explain(item, ctx) || [];
      } catch (err) {
        console.error(`The ${meta.title} check could not explain this element:`, err);
        continue;
      }

      html += `<div class="sec-head">${esc(meta.title.toUpperCase())}</div>`;
      if (!findings.length) {
        html += `<div style="color:var(--text-dim);font-size:12px">
                   No requirements for this entity and subtype.</div>`;
        continue;
      }

      let rule = null;
      for (const f of findings) {
        if (f.rule && f.rule !== rule) {
          rule = f.rule;
          html += `<div class="pset-name">${esc(rule)}</div>`;
        }
        const colour = hex(f.colour !== undefined ? f.colour : SEVERITY_COLOUR[f.severity]);
        const detail = f.severity === SEVERITY.PASS ? '' : ' — ' + esc(f.label);
        // A failing IFC-SG requirement can be fixed in place: the finding
        // carries the requirement, so the editor knows the pset, property and type.
        let fix = '';
        if (editable && f.req && f.severity !== SEVERITY.PASS) {
          fixable.push(f.req);
          const i = fixable.length - 1;
          // Fixing one element at a time does not scale: offer the query that
          // shows every element with this property, where Set value… fills them all.
          fix = `<button class="btn xs" data-fix="${i}">Fix</button>` +
            `<button class="btn xs" data-bulk="${i}" title="Query this property on every element, to set it on all of them at once">All…</button>`;
        }
        html += `
          <div class="chk-row">
            <span class="status-dot" style="background:${colour}" title="${esc(f.label)}"></span>
            <span class="ck">${breakAtDots(esc(f.message || f.label))}<small>${detail}</small></span>
            <span class="cv">${esc(f.value === undefined ? '' : f.value)}</span>${fix}
          </div>`;
      }
    }
  }

  // Everything actually present on the element, for cross-checking.
  const psetNames = Object.keys(item.psets).sort();
  if (psetNames.length) {
    html += `<div class="sec-head">PROPERTY SETS IN MODEL</div>`;
    for (const pn of psetNames) {
      html += `<div class="pset-name">${esc(pn)}</div>`;
      for (const [k, v] of Object.entries(item.psets[pn])) {
        const pencil = editable
          ? `<button class="btn xs" data-edit data-pset="${esc(pn)}" data-prop="${esc(k)}" title="Change this value in the IFC">Edit</button>` : '';
        html += `<div class="prop-row"><span class="k">${esc(k)}</span>
                 <span class="v">${esc(isEmptyValue(v) ? '—' : formatValue(v))}</span>${pencil}</div>`;
      }
    }
  }

  el.panelBody.innerHTML = html;
  el.panel.classList.add('visible');

  const hostLink = el.panelBody.querySelector('a[data-host]');
  if (hostLink) {
    hostLink.addEventListener('click', (e) => {
      e.preventDefault();
      const target = index && index.byId.get(hostLink.dataset.host);
      if (target) showElement(target);
    });
  }

  // Editing affordances: each opens an inline row under the thing it edits.
  el.panelBody.querySelectorAll('[data-bulk]').forEach((b) => {
    b.addEventListener('click', () => queryRequirement(fixable[+b.dataset.bulk]));
  });

  el.panelBody.querySelectorAll('[data-fix]').forEach((b) => {
    b.addEventListener('click', () => {
      const req = fixable[+b.dataset.fix];
      const current = getValue(item, req.pset, req.prop);
      openInlineEdit(b.closest('.chk-row'), {
        label: `${req.pset}.${req.prop}`,
        value: isEmptyValue(current) ? '' : formatValue(current),
        options: acceptedOptions(req),
        hint: req.dataType ? `Type: ${req.dataType}` : '',
        onSave: (v) => editProperty(item, req.pset, req.prop, v, { dataType: req.dataType }).then(() => showElement(item)),
      });
    });
  });
  el.panelBody.querySelectorAll('[data-edit]').forEach((b) => {
    b.addEventListener('click', () => {
      const { pset, prop } = b.dataset;
      const current = item.psets[pset] ? item.psets[pset][prop] : undefined;
      openInlineEdit(b.closest('.prop-row'), {
        label: `${pset}.${prop}`,
        value: isEmptyValue(current) ? '' : formatValue(current),
        options: typeof current === 'boolean' ? ['TRUE', 'FALSE'] : null,
        onSave: (v) => editProperty(item, pset, prop, v).then(() => showElement(item)),
      });
    });
  });
  const renameBtn = el.panelBody.querySelector('[data-rename]');
  if (renameBtn) {
    renameBtn.addEventListener('click', () => {
      openInlineEdit(renameBtn.closest('.prop-type'), {
        label: 'Name',
        value: item.name || '',
        onSave: (v) => renameElement(item, v).then(() => showElement(item)),
      });
    });
  }
}

// ----------------------------------------------------------------- project file

/**
 * The active project (see project.js for the format). It is where the
 * submission context, the check selection and every check input are kept
 * between sessions. `projectHandle` is the file on disk when the browser can
 * write back to it; `projectSavedFp` is the state as last saved or opened, so
 * the chip can show unsaved changes.
 */
let project = null;
let projectHandle = null;
let projectSavedFp = null;
/** Authorities the project puts in scope, or null for every authority. */
let projectAuthorities = null;

/** Is a check's authority inside the project scope? IFC-SG checks always are. */
function checkInScope(check) {
  const a = String(check.authority || '').toUpperCase();
  return a === 'IFC-SG' || !projectAuthorities || projectAuthorities.has(a);
}

/** The current state as a project document, ready to save. */
function collectProject() {
  const base = project || emptyProject();
  // The submission's file list: the recorded models once there are any, since
  // those name every file checked so far rather than only the ones open now.
  const files = base.models && base.models.length
    ? base.models.map((m) => m.name)
    : (viewer && viewer.hasModels ? viewer.entries.map((e) => e.name) : base.project.files);
  const inputs = {};
  // The submission gateway carries the URA selector, so it is not repeated here.
  for (const [key, value] of checkInputs) if (key !== 'ura.gateway') inputs[key] = value;
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    project: { ...base.project, files },
    submission: {
      gateway: gatewayFilter || GATEWAY.CONSTRUCTION,
      authorities: projectAuthorities ? [...projectAuthorities] : [],
    },
    checks: {
      selected: registry.all().map((c) => c.id).filter((id) => selectedChecks.has(id)),
      inputs,
      presets: enabledPresets().map((p) => p.id),
    },
    // What each model is, what it measured and how it checked. Written by
    // captureModelRecords after every run; carried through untouched here.
    models: base.models || [],
    ruleset: { generated: ruleset ? ruleset.meta.generated : base.ruleset.generated },
    // Hand edits made in the viewer, by file, so the team can see what changed
    // outside Revit. Informational: they are not re-applied on load.
    edits: editLogsByFile(base.edits || {}),
    saved: base.saved,
  };
}

/**
 * Makes a project the app's state: gateway, authority scope, check selection,
 * check inputs and preset ticks. Anything the file does not say keeps its
 * default rather than the previous project's value.
 */
async function applyProject(p, { handle = null, quiet = false } = {}) {
  project = p;
  projectHandle = handle;
  projectAuthorities = p.submission.authorities.length ? new Set(p.submission.authorities) : null;
  if (agencyFilter && projectAuthorities && !projectAuthorities.has(agencyFilter)) agencyFilter = '';

  const unknown = [];
  if (p.checks.selected) {
    selectedChecks = new Set();
    for (const id of p.checks.selected) {
      if (registry.byId(id)) selectedChecks.add(id);
      else unknown.push(id);
    }
  } else {
    // A file that never recorded a selection: every check its authorities ask for.
    selectedChecks = new Set(registry.all()
      .filter((c) => !c.experimental && checkInScope(c)).map((c) => c.id));
  }
  saveSelection();

  checkInputs.clear();
  for (const [key, value] of Object.entries(p.checks.inputs)) checkInputs.set(key, value);
  setGateway(p.submission.gateway);

  await applyPresetTicks(p.checks.presets);

  const now = collectProject();
  projectSavedFp = fingerprint(now);
  rememberProject(now);
  refreshFilters();
  renderCheckMenu();
  renderStartProjects();
  refreshDashboardAvailability();
  // A lot drawn for the previous project does not belong to this one.
  if (viewer && viewer.hasSurveyOverlays) {
    viewer.clearSurveyOverlays();
    el.toolSurvey.classList.remove('active');
  }
  refreshSurveyRail();

  if (!quiet) toast(`Project ${labelOf(p)} loaded.`);
  if (unknown.length) toast(`Checks the project names but this viewer lacks were ignored: ${unknown.join(', ')}.`);
  if (ruleset && p.ruleset.generated && p.ruleset.generated !== ruleset.meta.generated) {
    toast('This project was saved against a different IFC-SG workbook. Requirements may have changed since.');
  }
}

/**
 * Ticks exactly the presets the project names. Ticks live in the shared
 * presets file, so this writes through the same store the editor uses; on a
 * host where that file is read-only the ticks are left as they are.
 */
async function applyPresetTicks(ids) {
  if (!ids) return;
  await loadPresets();
  const want = new Set(ids);
  const list = currentPresets();
  const next = list.map((p) => ({ ...p, enabled: want.has(p.id) }));
  if (next.every((p, i) => p.enabled === list[i].enabled)) return;
  if (!canSave()) {
    toast('The project\'s preset ticks could not be applied: presets are read-only on this host.');
    return;
  }
  try {
    await savePresets(next);
  } catch (err) {
    console.error(err);
    toast('The project\'s preset ticks could not be applied: ' + err.message);
  }
}

async function restoreLastProject() {
  renderStartProjects();
  const p = lastProject();
  if (!p) return;
  try {
    await applyProject(p, { quiet: true });
    toast(`Project ${labelOf(p)} restored from last time.`);
  } catch (err) {
    console.error(err);
    clearLastProject();
  }
}

/** Reads a dropped or chosen file and applies it. */
async function openProjectFile(file, handle = null) {
  try {
    const p = parseProject(await file.text());
    await applyProject(p, { handle });
  } catch (err) {
    console.error(err);
    toast(`${file.name}: ${err.message}`);
  }
}

async function openProjectPicker() {
  try {
    const opened = await openFromDisk();
    if (opened) await applyProject(opened.project, { handle: opened.handle });
  } catch (err) {
    console.error(err);
    toast('The project could not be opened: ' + err.message);
  }
}

function newProject() {
  project = emptyProject();
  projectHandle = null;
  projectSavedFp = null;
  clearLastProject();
  renderProjectChip();
  refreshDashboardAvailability();
  openProjectPanel(true);
}

async function saveProject(forcePicker = false) {
  const p = collectProject();
  p.saved = new Date().toISOString();
  try {
    // The picker must be opened inside the click that asked for it, so
    // nothing awaits before saveToDisk.
    const { handle, name } = await saveToDisk(p, projectHandle, forcePicker);
    project = p;
    projectHandle = handle;
    projectSavedFp = fingerprint(p);
    rememberProject(p);
    renderProjectChip();
    renderProjectPanel();
    renderStartProjects();
    toast(`Project saved as ${name}.`);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error(err);
    toast('The project could not be saved: ' + err.message);
  }
}

/** True while the state differs from what the project file holds. */
function projectDirty() {
  if (!project) return false;
  if (projectSavedFp === null) return true;
  return fingerprint(collectProject()) !== projectSavedFp;
}

function renderProjectChip() {
  if (!el.projectChip) return;
  const name = el.projectChip.querySelector('.pc-name');
  const dot = el.projectChip.querySelector('.pc-dot');
  if (!project) {
    name.textContent = 'No project';
    el.projectChip.classList.remove('has-project');
    el.projectChip.title = 'Project settings: save the submission context and check setup to a file';
    dot.hidden = true;
  } else {
    const dirty = projectDirty();
    name.textContent = `${labelOf(project)} · ${GATEWAY_LABEL[gatewayFilter] || gatewayFilter}`;
    el.projectChip.classList.add('has-project');
    el.projectChip.title = dirty ? 'Project has unsaved changes' : 'Project settings';
    dot.hidden = !dirty;
  }
  if (el.projectPicker.classList.contains('open')) renderProjectPanel();
}

function openProjectPanel(focusCode = false) {
  closeTopPanels('project');
  el.projectPicker.classList.add('open');
  renderProjectPanel();
  if (focusCode) {
    const box = el.projectPanel.querySelector('[data-f="code"]');
    if (box) box.focus();
  }
}

function renderProjectPanel() {
  if (!el.projectPicker.classList.contains('open')) return;
  const p = project || emptyProject();
  const dirty = projectDirty();
  const agencies = ruleset ? ruleset.agencies.filter((a) => a !== AGENCY_ALL) : [];
  const rows = reconcileModels();
  const totals = submissionTotals();
  const nChecks = selectedChecks.size;
  const inputCount = [...checkInputs.keys()].filter((k) => k !== 'ura.gateway').length;
  const lot = projectLot();

  el.projectPanel.innerHTML = `
    <div class="pp-head">
      <span>PROJECT SETUP</span>
      <span class="pp-state">${!project ? 'none open'
        : dirty ? (projectSavedFp === null ? 'not saved yet' : 'unsaved changes')
          : (p.saved ? 'saved ' + new Date(p.saved).toLocaleString() : 'saved')}</span>
      <button class="pp-close" data-close title="Close (Esc)">&times;</button>
    </div>
    <div class="pp-body">
      <label class="pp-field"><span>Project code</span>
        <input data-f="code" value="${esc(p.project.code)}" placeholder="e.g. 250008" /></label>
      <label class="pp-field"><span>Name</span>
        <input data-f="name" value="${esc(p.project.name)}" placeholder="Development name" /></label>
      <label class="pp-field"><span>Developer / client</span>
        <input data-f="developer" value="${esc(p.project.developer)}" /></label>

      <div class="pp-field"><span>Cadastral lot GeoJSON <small>from URA's site-information service</small></span>
        <div class="cm-file">
          <button class="btn sm" data-lot-pick>${lot ? 'Replace…' : 'Choose file…'}</button>
          <input type="file" data-lot-file accept=".geojson,.json,application/geo+json,application/json" hidden />
          <span class="cm-filename">${lot ? esc(lot.name) : 'No file chosen'}</span>
          ${lot ? '<button class="btn sm" data-lot-clear title="Remove the lot from the project">&times;</button>' : ''}
        </div>
        <div class="pp-note">${!lot
          ? 'Drawn on the ground by the survey tool, and checked by Geo-referencing. Saved inside the project file.'
          : lot.error ? `<span style="color:var(--danger)">Could not be read: ${esc(lot.error)}</span>`
            : `${lot.lots.length} lot${lot.lots.length === 1 ? '' : 's'}: ${esc(lot.lots.map((l) => l.key).join(', '))}
               ${viewer.hasModels ? '<button class="btn xs" data-lot-draw style="margin-left:6px">Draw on model</button>' : ''}`}
        </div></div>

      <div class="pp-field"><span>Submission gateway</span>
        <select data-f="gateway">${GATEWAY_ORDER.map((g) =>
          `<option value="${g}"${g === gatewayFilter ? ' selected' : ''}>${esc(GATEWAY_LABEL[g])}</option>`).join('')}
        </select></div>

      <div class="pp-field"><span>Authorities in scope <small>none ticked = all</small></span>
        <div class="bubble-row plain">${agencies.map((a) =>
          `<button class="bubble${projectAuthorities && projectAuthorities.has(a) ? ' active' : ''}" data-auth="${esc(a)}">${esc(a)}</button>`).join('')}
        </div></div>

      <div class="pp-field"><span>Checks</span>
        <div class="pp-note">${nChecks} selected · ${inputCount} input${inputCount === 1 ? '' : 's'} supplied · ${enabledPresets().length} preset${enabledPresets().length === 1 ? '' : 's'} ticked
          <small>Set these on the Compliance tab. They are saved with the project.</small></div></div>

      <div class="pp-field"><span>Models <small>matched by content, not by file name</small></span>
        ${rows.length ? `<ul class="pp-models">${rows.map((r, i) => `
          <li class="st-${r.state}" data-row="${i}" title="${esc(r.record && r.record.identity ? describeIdentity(r.record.identity) : (r.identity ? describeIdentity(r.identity) : ''))}">
            <div class="pm-top">
              <span class="pm-name">${esc(r.name)}</span>
              <span class="chip ${r.state === RECORD_STATE.MATCH ? 'done' : r.state === RECORD_STATE.NEW || r.state === RECORD_STATE.MISSING || r.state === RECORD_STATE.LEGACY ? '' : 'alert'}">${esc(STATE_LABEL[r.state])}</span>
            </div>
            <div class="pm-sub">${esc(modelSubtitle(r))}</div>
            ${r.reasons.length ? `<div class="pm-why">${esc(r.reasons.join('; '))}</div>` : ''}
            ${r.state === RECORD_STATE.RENAMED
              ? `<div class="pm-act"><button class="btn xs" data-rename-record="${i}">Use the new name</button></div>` : ''}
            ${r.state === RECORD_STATE.UPDATED
              ? `<div class="pm-act"><button class="btn xs" data-recheck="${i}">Re-check to refresh</button></div>` : ''}
            ${r.record ? `<div class="pm-act"><button class="btn xs" data-forget-record="${i}">Forget</button></div>` : ''}
          </li>`).join('')}</ul>`
          : '<div class="pp-note">No models recorded yet. Load a model and run the checks; its results are recorded here.</div>'}
        <div class="pp-note" style="margin-top:6px">
          ${totals.checked
            ? `${totals.checked} of ${totals.models} recorded model${totals.models === 1 ? '' : 's'} checked · ${totals.elements} mapped element${totals.elements === 1 ? '' : 's'} · ${totals.fail} failure${totals.fail === 1 ? '' : 's'}, ${totals.warn} warning${totals.warn === 1 ? '' : 's'} across the submission`
            : 'Run the checks to record a model.'}
          ${viewer.hasModels ? '<button class="btn xs" data-record style="margin-left:6px">Record loaded models</button>' : ''}
        </div>
      </div>
    </div>
    <div class="pp-actions">
      <button class="btn sm" data-act="new">New</button>
      <button class="btn sm" data-act="open">Open…</button>
      <span class="spacer"></span>
      <button class="btn sm" data-act="save-as">Save as…</button>
      <button class="btn sm primary" data-act="save"${project ? '' : ' disabled'}>Save</button>
    </div>`;

  const ensureProject = () => { if (!project) { project = emptyProject(); projectSavedFp = null; } };

  el.projectPanel.querySelectorAll('input[data-f]').forEach((box) => {
    box.addEventListener('input', () => {
      ensureProject();
      project.project[box.dataset.f] = box.value.trim();
      // Only the chip: redrawing the panel mid-keystroke would lose the caret.
      const dot = el.projectChip.querySelector('.pc-dot');
      dot.hidden = !projectDirty();
      el.projectChip.querySelector('.pc-name').textContent =
        `${labelOf(project)} · ${GATEWAY_LABEL[gatewayFilter] || gatewayFilter}`;
      el.projectChip.classList.add('has-project');
      el.projectPanel.querySelector('[data-act="save"]').disabled = false;
    });
  });

  // The cadastral lot: read and validated here, stored as the geo-referencing
  // check's input so the check and the project file both carry it unchanged.
  const lotFile = el.projectPanel.querySelector('[data-lot-file]');
  el.projectPanel.querySelector('[data-lot-pick]').addEventListener('click', () => lotFile.click());
  lotFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    let text, parsed;
    try {
      text = await file.text();
      parsed = parseCadastralGeoJson(text);
    } catch (err) {
      toast(`${file.name} could not be used: ${err.message}`);
      return;
    }
    ensureProject();
    checkInputs.set(LOT_INPUT_KEY, { name: file.name, text });
    // The lot numbers come with the file; the report lists them.
    for (const l of parsed.lots) if (!project.project.lots.includes(l.key)) project.project.lots.push(l.key);
    for (const w of parsed.warnings) toast(w);
    redrawSurveyIfShown();
    renderCheckMenu(); // redraws the chip, this panel and the check inputs
  });
  const lotClear = el.projectPanel.querySelector('[data-lot-clear]');
  if (lotClear) {
    lotClear.addEventListener('click', () => {
      checkInputs.delete(LOT_INPUT_KEY);
      redrawSurveyIfShown();
      renderCheckMenu();
    });
  }
  const lotDraw = el.projectPanel.querySelector('[data-lot-draw]');
  if (lotDraw) {
    lotDraw.addEventListener('click', () => {
      el.projectPicker.classList.remove('open');
      shellActions.showSurvey(surveyOutlines());
    });
  }

  el.projectPanel.querySelector('[data-f="gateway"]').addEventListener('change', (e) => {
    ensureProject();
    setGateway(e.target.value);
    refreshFilters();
  });

  el.projectPanel.querySelector('[data-close]').addEventListener('click', () => {
    el.projectPicker.classList.remove('open');
  });

  el.projectPanel.querySelectorAll('[data-auth]').forEach((b) => {
    b.addEventListener('click', () => {
      ensureProject();
      const a = b.dataset.auth;
      const set = new Set(projectAuthorities || []);
      const adding = !set.has(a);
      if (adding) set.add(a); else set.delete(a);
      projectAuthorities = set.size ? set : null;
      markResultsStale('The authorities in scope changed since these checks ran.');
      // The authority's checks follow it in and out of scope; other checks are left alone.
      for (const c of registry.all()) {
        if (String(c.authority).toUpperCase() !== a) continue;
        if (adding && !c.experimental) selectedChecks.add(c.id);
        if (!adding) selectedChecks.delete(c.id);
      }
      saveSelection();
      refreshFilters();
      renderCheckMenu();
    });
  });

  const recordBtn = el.projectPanel.querySelector('[data-record]');
  if (recordBtn) {
    recordBtn.addEventListener('click', () => {
      const n = captureModelRecords();
      toast(`${n} model${n === 1 ? '' : 's'} recorded in the project.`);
    });
  }
  el.projectPanel.querySelectorAll('[data-rename-record]').forEach((b) => {
    b.addEventListener('click', () => {
      const row = rows[+b.dataset.renameRecord];
      const was = row.record.name;
      row.record.name = row.name;
      renderProjectPanel();
      renderProjectChip();
      toast(`Recorded as "${row.name}" — it was "${was}".`);
    });
  });
  el.projectPanel.querySelectorAll('[data-recheck]').forEach((b) => {
    b.addEventListener('click', () => {
      el.projectPicker.classList.remove('open');
      showTab('check');
      toast('This file has been re-issued since it was recorded. Run the checks to refresh its record.');
    });
  });
  el.projectPanel.querySelectorAll('[data-forget-record]').forEach((b) => {
    b.addEventListener('click', () => {
      const row = rows[+b.dataset.forgetRecord];
      if (!window.confirm(`Forget the record for "${row.record.name}"? Its results leave the project file.`)) return;
      project.models = project.models.filter((m) => m !== row.record);
      renderProjectPanel();
      renderProjectChip();
      refreshDashboardAvailability();
    });
  });

  el.projectPanel.querySelector('[data-act="new"]').addEventListener('click', newProject);
  el.projectPanel.querySelector('[data-act="open"]').addEventListener('click', openProjectPicker);
  el.projectPanel.querySelector('[data-act="save"]').addEventListener('click', () => saveProject(false));
  el.projectPanel.querySelector('[data-act="save-as"]').addEventListener('click', () => {
    ensureProject();
    saveProject(true);
  });
}

/** The start card's project row: open a project file, or start a new one. */
function renderStartProjects() {
  if (!el.startProjects) return;
  el.startProjects.innerHTML = `
    <div class="sp-row">
      <button class="btn" data-act="open">Open project file…</button>
      <button class="btn" data-act="new">New project</button>
    </div>`;

  // These open the project panel; the same click must not reach the document
  // listener that closes it.
  el.startProjects.querySelector('[data-act="open"]').addEventListener('click', (e) => {
    e.stopPropagation();
    openProjectPicker();
  });
  el.startProjects.querySelector('[data-act="new"]').addEventListener('click', (e) => {
    e.stopPropagation();
    newProject();
  });
}

function wireProjectUI() {
  el.projectChip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.projectPicker.classList.contains('open')) el.projectPicker.classList.remove('open');
    else openProjectPanel();
  });
  el.projectPanel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => el.projectPicker.classList.remove('open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.projectPicker.classList.remove('open');
  });
  window.addEventListener('beforeunload', (e) => {
    if (!projectDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// -------------------------------------------------------------------- model tab

/** The hierarchy of the loaded models (js/model-tree.js), rebuilt when the set changes. */
let mtRoots = null;
/** Node id -> node, for the rows on screen. */
const mtNodes = new Map();
/** Element key -> ids of the nodes above it, so a 3D pick can open its branch. */
const mtPathOf = new Map();
const mtExpanded = new Set();
/** Node id -> how many children are listed; a big class is shown a page at a time. */
const mtShown = new Map();
const MT_PAGE = 500;
/** The element selected from the tree or the 3D view, highlighted in both. */
let mtSelected = null;

const mtVisible = () => $('tab-model').style.display !== 'none';

function ensureModelTree() {
  if (mtRoots) return;
  mtRoots = buildModelTree(indexes, new Map(viewer.entries.map((e) => [e.modelID, e.name])));
  mtNodes.clear();
  mtPathOf.clear();
  const walk = (node, path) => {
    mtNodes.set(node.id, node);
    if (node.element) mtPathOf.set(node.element.key, path);
    for (const c of node.children) walk(c, [...path, node.id]);
  };
  for (const r of mtRoots) walk(r, []);
  // A lone model opens on its levels rather than on one closed row.
  if (mtRoots.length === 1) mtExpanded.add(mtRoots[0].id);
}

/** Hidden when every element in it that draws anything is hidden. */
function mtHidden(elements) {
  let drawn = 0;
  for (const e of elements) {
    // A stair draws through its parts, so its parts are what gets hidden.
    const ids = e.hasGeometry === false ? e.parts || [] : [e.expressID];
    if (!ids.length) continue;
    drawn++;
    if (!viewer.isHidden({ modelID: e.modelID, expressID: ids[0] })) return false;
  }
  return drawn > 0;
}

function renderModelTab() {
  if (!viewer || !mtVisible()) return;
  if (!index) {
    mtRoots = null;
    el.mtBody.innerHTML = '<div class="empty-note">Load an IFC file to browse its levels, classes and elements.</div>';
    return;
  }
  const q = el.mtSearch.value.trim();
  if (q) renderModelSearch(q);
  else renderModelHierarchy();
}

function renderModelHierarchy() {
  ensureModelTree();
  const parts = [];
  const row = (node, depth) => {
    const open = mtExpanded.has(node.id);
    const leaf = !node.children.length;
    const sel = node.element && mtSelected === node.element.key;
    const off = mtHidden(node.elements);
    parts.push(`<div class="mt-row${sel ? ' sel' : ''}${off ? ' off' : ''}" data-id="${esc(node.id)}"
        style="padding-left:${4 + depth * 14}px">
      <span class="mt-tw">${leaf ? '' : open ? '&#9662;' : '&#9656;'}</span>
      <span class="mt-label" title="${esc(node.label)}">${esc(node.label)}${node.sub ? `<small>${esc(node.sub)}</small>` : ''}</span>
      ${node.element && leaf ? '' : `<span class="mt-n">${node.elements.length}</span>`}
      <button class="mt-act" data-act="fit" title="Zoom to">Zoom</button>
      <button class="mt-act" data-act="iso" title="Hide everything else">Isolate</button>
      <button class="mt-act" data-act="vis" title="${off ? 'Show' : 'Hide'}">${off ? 'Show' : 'Hide'}</button>
    </div>`);
    if (!open || leaf) return;
    const limit = mtShown.get(node.id) || MT_PAGE;
    for (const c of node.children.slice(0, limit)) row(c, depth + 1);
    if (node.children.length > limit) {
      parts.push(`<div class="mt-more" style="padding-left:${22 + depth * 14}px">
        <button class="btn xs" data-more="${esc(node.id)}">Show ${Math.min(MT_PAGE, node.children.length - limit)} more</button>
        of ${node.children.length - limit} not listed</div>`);
    }
  };
  for (const r of mtRoots) row(r, 0);
  if (!mtRoots.some((r) => r.elements.length)) {
    parts.push('<div class="empty-note">No mapped elements in the loaded models.</div>');
  }
  parts.push(`<div class="mt-more">Lists the elements the IFC-SG mapping covers, by file, level and class.</div>`);
  const top = el.mtBody.scrollTop;
  el.mtBody.innerHTML = parts.join('');
  el.mtBody.scrollTop = top;
}

/** The current search, kept so its rows and buttons can act on what was found. */
let mtHits = { results: [], total: 0 };

function renderModelSearch(q) {
  const modelName = (e) => viewer.models.get(e.modelID)?.name || '';
  mtHits = searchElements(index.all, q, { properties: el.mtProps.checked, modelName });
  const { results, total } = mtHits;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    .map((w) => w.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&'));
  const re = new RegExp('(' + words.join('|') + ')', 'gi');
  const mark = (text) =>
    String(text).split(re).map((piece, i) => (i % 2 ? `<mark>${esc(piece)}</mark>` : esc(piece))).join('');
  const multi = viewer.entries.length > 1;

  const parts = [`<div class="mt-head"><span>${total} result${total === 1 ? '' : 's'}${
    total > results.length ? ` · first ${results.length} listed` : ''}</span><span class="spacer"></span>${
    total ? `<button class="btn xs" data-hits="show" title="Colour every result in the 3D view">Show in model</button>
      <button class="btn xs" data-hits="iso" title="Hide everything else">Isolate</button>` : ''}</div>`];
  if (!total) {
    parts.push(`<div class="empty-note">Nothing matches every word.${el.mtProps.checked ? ''
      : ' Tick “Include property values” to search property sets as well.'}</div>`);
  }
  for (const { element: e, matched } of results) {
    const sub = [e.entity, e.storey, multi ? modelName(e) : null, ...matched].filter(Boolean);
    parts.push(`<div class="mt-hit${mtSelected === e.key ? ' sel' : ''}" data-key="${esc(e.key)}">
      <div>${mark(elementLabel(e))}</div>
      <div class="mh-sub">${sub.map(mark).join(' · ')}</div></div>`);
  }
  el.mtBody.innerHTML = parts.join('');
}

/** Spaces start hidden; acting on one from the tree means it should be seen. */
function revealSpaces(elements) {
  if (!spacesVisible && elements.some((e) => e.canonicalEntity === 'IFCSPACE')) setSpacesVisible(true);
}

function selectFromModelTab(element) {
  revealSpaces([element]);
  mtSelected = element.key;
  showElement(element);
}

/** Opens the branch holding an element picked anywhere, and scrolls it into view. */
function revealInModelTree(item) {
  mtSelected = item.key;
  if (!mtVisible()) return;
  if (!el.mtSearch.value.trim()) {
    ensureModelTree();
    for (const id of mtPathOf.get(item.key) || []) {
      mtExpanded.add(id);
      // A pick deep in a big class must not be on a page that is not shown.
      const node = mtNodes.get(id);
      const at = node ? node.children.findIndex((c) => c.elements.some((x) => x.key === item.key)) : -1;
      if (at >= (mtShown.get(id) || MT_PAGE)) mtShown.set(id, at + 1);
    }
  }
  renderModelTab();
  const rowEl = el.mtBody.querySelector('.mt-row.sel, .mt-hit.sel');
  if (rowEl) rowEl.scrollIntoView({ block: 'nearest' });
}

function showHiddenElements(elements) {
  for (const e of elements) {
    manualHidden.delete(e.key);
    keepDrawing(e);
  }
  revealSpaces(elements);
  applyVisibility();
}

function wireModelTab() {
  let timer;
  el.mtSearch.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(renderModelTab, 160);
  });
  el.mtSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      el.mtSearch.value = '';
      renderModelTab();
    } else if (e.key === 'Enter' && mtHits.results.length) {
      selectFromModelTab(mtHits.results[0].element);
    }
  });
  el.mtProps.addEventListener('change', renderModelTab);

  // "/" jumps to the search from anywhere outside a text field, as on most sites.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    el.left.classList.remove('collapsed');
    showTab('model');
    el.mtSearch.focus();
    el.mtSearch.select();
  });

  el.mtBody.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) {
      const id = more.dataset.more;
      mtShown.set(id, (mtShown.get(id) || MT_PAGE) + MT_PAGE);
      renderModelTab();
      return;
    }

    const hitsBtn = e.target.closest('[data-hits]');
    if (hitsBtn) {
      // Every match, not only the listed page.
      const all = searchElements(index.all, el.mtSearch.value, {
        properties: el.mtProps.checked, limit: Infinity,
        modelName: (x) => viewer.models.get(x.modelID)?.name || '',
      }).results.map((r) => r.element);
      if (hitsBtn.dataset.hits === 'show') {
        shellActions.showInModel([{ label: 'Search results', colour: SINGLE_COLOUR, elements: all }],
          'Search', `“${el.mtSearch.value.trim()}” · ${all.length} element${all.length === 1 ? '' : 's'}`);
      } else {
        isolateElements(all);
        viewer.fitElements(all);
      }
      return;
    }

    const hit = e.target.closest('.mt-hit');
    if (hit) {
      const item = index.byId.get(hit.dataset.key);
      if (item) selectFromModelTab(item);
      return;
    }

    const rowEl = e.target.closest('.mt-row');
    const node = rowEl && mtNodes.get(rowEl.dataset.id);
    if (!node) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      switch (act.dataset.act) {
        case 'fit':
          revealSpaces(node.elements);
          if (!viewer.fitElements(node.elements)) toast('Nothing in that branch draws any geometry.');
          break;
        case 'iso':
          isolateElements(node.elements);
          viewer.fitElements(node.elements);
          break;
        case 'vis':
          if (mtHidden(node.elements)) showHiddenElements(node.elements);
          else hideElements(node.elements);
          break;
      }
      return;
    }
    // A branch opens and closes; an element is selected (and, with parts, opens too).
    if (node.children.length && !node.element) {
      if (mtExpanded.has(node.id)) mtExpanded.delete(node.id);
      else mtExpanded.add(node.id);
      renderModelTab();
      return;
    }
    if (node.children.length && e.target.closest('.mt-tw')) {
      if (mtExpanded.has(node.id)) mtExpanded.delete(node.id);
      else mtExpanded.add(node.id);
      renderModelTab();
      return;
    }
    selectFromModelTab(node.element);
  });

  el.mtBody.addEventListener('dblclick', (e) => {
    const target = e.target.closest('.mt-row, .mt-hit');
    if (!target || e.target.closest('[data-act], button')) return;
    const node = target.dataset.id ? mtNodes.get(target.dataset.id) : null;
    const elements = node ? node.elements : [index.byId.get(target.dataset.key)].filter(Boolean);
    if (elements.length) viewer.fitElements(elements);
  });
}

// ------------------------------------------------------------------------- tabs

function showTab(tab) {
  for (const id of ['query', 'model', 'warnings', 'check', 'issues', 'guide', 'feedback']) {
    $('tab-' + id).style.display = id === tab ? 'flex' : 'none';
  }
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  if (tab === 'model') renderModelTab();
  if (tab === 'guide') renderGuide($('tab-guide'), { showMe: guideShowMe });
  if (tab === 'feedback') renderFeedback($('feedback-body'), { context: feedbackContext, toast });
  else workTab = tab;
  $('tab-help').dataset.guide = TAB_GUIDE[tab] || '';
  $('tab-help').hidden = !TAB_GUIDE[tab];
}

/** Each working tab's entry in the User Guide, opened by its "?". */
const TAB_GUIDE = { query: 'queries', model: 'search', warnings: 'warnings', check: 'compliance', issues: 'issues' };
/** The tab in use before Feedback, which a bug report usually concerns. */
let workTab = 'query';

/**
 * What a feedback report says about the app's state, as [label, value] rows.
 * Counts and settings only; file and project names just when `names` is set.
 */
function feedbackContext({ names }) {
  const rows = [['Tab in use', workTab]];
  const mem = $('mem-val').textContent.trim();
  if (mem && mem !== '—') rows.push(['Memory', mem]);

  const entries = viewer ? viewer.entries : [];
  if (!entries.length) return [...rows, ['Models', 'none loaded']];
  const mapped = entries.reduce((n, e) => n + (indexes.get(e.modelID)?.count ?? 0), 0);
  const large = entries.filter((e) => e.kind === 'frag').length;
  rows.push(['Models', `${entries.length} loaded${large ? ` (${large} large)` : ''} · ${mapped.toLocaleString()} mapped elements`]);
  if (names) {
    rows.push(['Model files', entries.map((e) => e.name).join(', ')]);
    if (project) rows.push(['Project', labelOf(project)]);
  }
  rows.push(['Gateway', GATEWAY_LABEL[gatewayFilter] || 'all']);
  rows.push(['Authorities', projectAuthorities && projectAuthorities.size ? [...projectAuthorities].join(', ') : 'all']);

  const ticked = registry.all().filter((c) => selectedChecks.has(c.id)).map((c) => c.title);
  rows.push(['Checks ticked', ticked.join(', ') || 'none']);
  if (checkOutcomes.some((o) => o.result)) {
    const t = totalsOf(checkOutcomes);
    const failed = checkOutcomes.filter((o) => o.error).map((o) => o.meta.title);
    rows.push(['Last run', `${t.assertions ? Math.round((t.pass / t.assertions) * 100) : 0}% met · ${t.fail} issues · ` +
      `${t.elements} elements checked${resultsStale ? ' · out of date' : ''}${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`]);
  } else {
    rows.push(['Last run', 'not run']);
  }
  const fails = warnings.filter((w) => w.severity === 'fail').length;
  rows.push(['Warnings', warnings.length
    ? `${fails} will fail, ${warnings.length - fails} to review (${warnings.map((w) => w.id).join(', ')})` : 'none']);
  return rows;
}

/**
 * The guide's "Show me": opens the tab a control lives on and makes the control
 * pulse, so the reader finds it on screen. A control that only exists in some
 * states (the colour key, the edits bar) says when it appears instead.
 */
function guideShowMe({ tab, target, hint }) {
  if (tab) {
    el.left.classList.remove('collapsed');
    showTab(tab);
  }
  const node = document.querySelector(target);
  if (!node || !node.getClientRects().length) {
    toast(hint || 'That appears once a model is loaded.');
    return;
  }
  node.scrollIntoView({ block: 'nearest' });
  node.classList.remove('guide-spot');
  void node.offsetWidth; // restart the pulse when shown twice in a row
  node.classList.add('guide-spot');
  setTimeout(() => node.classList.remove('guide-spot'), 2600);
  // Leaving the guide for another tab: a word on the way back.
  if (tab) toast('Back to the steps: the User Guide tab, bottom left.');
}

// -------------------------------------------------------------------- IFC editing

/** modelID -> IfcEditor, created the first time that model is edited. */
const editors = new Map();
/** modelID -> text scan, shared by GUID lookup and the editor. */
const textScans = new Map();
/** The element the inspector last showed; new BCF topics attach to it. */
let lastPicked = null;

/** Can this element be edited? Only while its source file is still to hand. */
function canEdit(item) {
  const entry = item && viewer && viewer.models.get(item.modelID);
  return !!(entry && entry.file);
}

/** The text scan for a model, made once and reused by editing and BCF. */
async function textScanFor(modelID) {
  let scan = textScans.get(modelID);
  if (scan) return scan;
  const entry = viewer.models.get(modelID);
  if (!entry || !entry.file) throw new Error('The source file for this model is no longer available.');
  el.loading.classList.add('visible');
  try {
    scan = await scanFile(entry.file, (pct) => setProgress(pct, `Reading ${entry.name}…`));
  } finally {
    el.loading.classList.remove('visible');
  }
  textScans.set(modelID, scan);
  return scan;
}

async function editorFor(modelID) {
  let ed = editors.get(modelID);
  if (ed) return ed;
  const entry = viewer.models.get(modelID);
  if (!entry || !entry.file) throw new Error('The source file for this model is no longer available.');
  ed = new IfcEditor(entry.file, { name: entry.name, scan: textScans.get(modelID) || null });
  el.loading.classList.add('visible');
  try {
    await ed.prepare((msg, pct) => setProgress(pct, `${msg} (${entry.name})`));
  } finally {
    el.loading.classList.remove('visible');
  }
  if (ed.scan) textScans.set(modelID, ed.scan);
  editors.set(modelID, ed);
  return ed;
}

/** Sets a property in the file and mirrors it into the index straight away. */
async function editProperty(element, pset, prop, value, { dataType = null } = {}) {
  try {
    const ed = await editorFor(element.modelID);
    const stored = await ed.setProperty(element, pset, prop, value, { dataType });
    const psetKey = Object.keys(element.psets).find((k) => k.toUpperCase() === pset.toUpperCase()) || pset;
    if (!element.psets[psetKey]) element.psets[psetKey] = {};
    const propKey = Object.keys(element.psets[psetKey]).find((k) => k.toUpperCase() === prop.toUpperCase()) || prop;
    element.psets[psetKey][propKey] = stored;
    afterEdit();
    return stored;
  } catch (err) {
    console.error(err);
    toast('The edit could not be made: ' + err.message);
    throw err;
  }
}

async function renameElement(element, name) {
  try {
    const ed = await editorFor(element.modelID);
    await ed.setName(element, name);
    element.name = name;
    for (const s of (index && index.storeys) || []) {
      if (s.modelID === element.modelID && s.expressID === element.expressID) s.name = name;
    }
    afterEdit();
    return name;
  } catch (err) {
    console.error(err);
    toast('The rename could not be made: ' + err.message);
    throw err;
  }
}

/** Refreshes everything that shows values after an edit landed. */
function afterEdit() {
  markResultsStale('The model has been edited since these checks ran.');
  renderEditsBar();
  renderProjectChip();
  // A property query's legend is a picture of the values, so redraw it.
  if (selection && selection.req) selectProperty(selection.group, selection.req);
}

function renderEditsBar() {
  const list = [...editors.values()].filter((ed) => ed.hasEdits);
  const n = list.reduce((s, ed) => s + ed.editCount, 0);
  el.editsBar.classList.toggle('visible', n > 0);
  if (!n) return;
  el.editsText.innerHTML = `${n} edit${n === 1 ? '' : 's'} in ${list.length} file${list.length === 1 ? '' : 's'}` +
    `<small>Export writes the changed lines into a copy of each file. The Revit model is unchanged.</small>`;
}

/** Log per file for the project record, this session's edits over the saved ones. */
function editLogsByFile(saved) {
  const out = { ...saved };
  for (const ed of editors.values()) {
    if (ed.log.length) out[ed.name] = ed.log;
  }
  return out;
}

/** The values a requirement accepts, as options for the inline editor. */
function acceptedOptions(req) {
  const acc = req.accepted || {};
  if (acc.kind === 'boolean' || req.dataType === 'Boolean') return ['TRUE', 'FALSE'];
  if (acc.kind === 'enum' && acc.values && acc.values.length) return acc.values;
  if (acc.kind === 'spaceValues' && ruleset && ruleset.spaceValues[req.prop]) {
    return ruleset.spaceValues[req.prop].map((v) => v.value);
  }
  return null;
}

/** Let a long "Pset.Property" name wrap at its dots before anywhere else. */
const breakAtDots = (html) => html.replace(/\./g, '.<wbr>');

const PANEL_WIDTH_KEY = 'rsp.panelWidth';

/** Drag the element panel's left edge to widen it; the width is remembered. */
function wirePanelResize() {
  const handle = $('panel-resize');
  try {
    const saved = +localStorage.getItem(PANEL_WIDTH_KEY);
    if (saved) el.panel.style.width = saved + 'px';
  } catch { /* ignore */ }

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    el.panel.classList.add('resizing');
    const right = el.panel.getBoundingClientRect().right;
    const move = (ev) => { el.panel.style.width = Math.round(right - ev.clientX) + 'px'; };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      el.panel.classList.remove('resizing');
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(el.panel.offsetWidth)); } catch { /* ignore */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

/**
 * An inline editor under a row: a select when the values are enumerated, a
 * text box otherwise. Enter saves, Escape cancels, and the row is the only
 * one open at a time.
 */
function openInlineEdit(anchor, { label, value, options = null, hint = '', onSave }) {
  el.panelBody.querySelectorAll('.edit-row').forEach((r) => r.remove());
  const row = document.createElement('div');
  row.className = 'edit-row';
  const control = options
    ? `<select>${options.map((o) => `<option value="${esc(o)}"${String(o).toUpperCase() === String(value).toUpperCase() ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
    : `<input type="text" value="${esc(value)}" placeholder="${esc(label)}" />`;
  row.innerHTML = `${control}<button class="btn xs primary" data-save>Save</button><button class="btn xs" data-cancel>Cancel</button>` +
    (hint ? `<span class="hint">${esc(hint)}</span>` : '');
  anchor.insertAdjacentElement('afterend', row);
  const box = row.querySelector('input, select');
  box.focus();
  if (box.select) box.select();

  const save = async () => {
    const v = box.value.trim();
    if (!v && !options) { toast('Enter a value, or cancel.'); return; }
    row.querySelector('[data-save]').disabled = true;
    try {
      await onSave(v);
    } catch {
      row.querySelector('[data-save]').disabled = false;
    }
  };
  row.querySelector('[data-save]').addEventListener('click', save);
  row.querySelector('[data-cancel]').addEventListener('click', () => row.remove());
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') row.remove();
  });
}

/** Writes every edited file, each validated first. */
async function exportEdits() {
  const list = [...editors.values()].filter((ed) => ed.hasEdits);
  if (!list.length) return;
  el.btnExportIfc.disabled = true;
  try {
    for (const ed of list) {
      el.loading.classList.add('visible');
      setProgress(30, `Validating ${ed.exportName}…`);
      let check;
      try {
        check = await ed.validate(WebIFC, WASM_PATH);
      } finally {
        el.loading.classList.remove('visible');
      }
      if (!check.ok) {
        console.error(check.problems);
        toast(`${ed.name}: the edited lines did not validate — ${check.problems[0]}`);
        continue;
      }
      const blob = await ed.export();
      await saveBlob(blob, ed.exportName, [{ description: 'IFC', accept: { 'application/octet-stream': ['.ifc'] } }]);
      toast(`${ed.exportName} written (${ed.editCount} edit${ed.editCount === 1 ? '' : 's'}).`);
    }
  } catch (err) {
    if (!(err && err.name === 'AbortError')) {
      console.error(err);
      toast('The export failed: ' + err.message);
    }
  } finally {
    el.btnExportIfc.disabled = false;
  }
}

/**
 * Saves a blob through the native picker where it exists, else as a download.
 * @param {FileSystemHandle} [startIn]  a file whose folder the picker opens in
 */
async function saveBlob(blob, name, types, startIn) {
  if (typeof window.showSaveFilePicker === 'function') {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, types, ...(startIn ? { startIn } : {}) });
    } catch (err) {
      // A handle the browser no longer accepts (the file moved, say) is not
      // worth failing the save over: ask again from the default folder.
      if (!startIn || (err && err.name === 'AbortError')) throw err;
      handle = await window.showSaveFilePicker({ suggestedName: name, types });
    }
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function discardEdits() {
  const n = [...editors.values()].reduce((s, ed) => s + ed.editCount, 0);
  if (!n) return;
  if (!window.confirm(`Forget all ${n} edit${n === 1 ? '' : 's'}? The values shown will no longer match the file.`)) return;
  for (const ed of editors.values()) ed.discard();
  markResultsStale('Edits were discarded since these checks ran.');
  renderEditsBar();
  renderProjectChip();
  toast('Edits discarded. Reload the model to see the original values again.');
}

/** The legend's bulk edit: one value onto every element the legend shows. */
function openLegendEdit() {
  if (!selection || !selection.req) return;
  const req = selection.req;
  const targets = legend
    .filter((g, i) => soloIndex < 0 || soloIndex === i)
    .flatMap((g) => g.elements).filter(canEdit);
  const options = acceptedOptions(req);
  el.legendEdit.innerHTML = (options
    ? `<select>${options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`
    : `<input type="text" placeholder="${esc(req.prop)} value" />`) +
    `<button class="btn xs primary" data-apply>Set on ${targets.length}</button><button class="btn xs" data-cancel>Cancel</button>`;
  el.legendEdit.classList.add('visible');
  const box = el.legendEdit.querySelector('input, select');
  box.focus();
  el.legendEdit.querySelector('[data-cancel]').addEventListener('click', () => el.legendEdit.classList.remove('visible'));
  el.legendEdit.querySelector('[data-apply]').addEventListener('click', async () => {
    const v = box.value.trim();
    if (!v) return;
    el.legendEdit.querySelector('[data-apply]').disabled = true;
    let done = 0;
    for (const element of targets) {
      try {
        const ed = await editorFor(element.modelID);
        const stored = await ed.setProperty(element, req.pset, req.prop, v, { dataType: req.dataType });
        const psetKey = Object.keys(element.psets).find((k) => k.toUpperCase() === req.pset.toUpperCase()) || req.pset;
        if (!element.psets[psetKey]) element.psets[psetKey] = {};
        const propKey = Object.keys(element.psets[psetKey]).find((k) => k.toUpperCase() === req.prop.toUpperCase()) || req.prop;
        element.psets[psetKey][propKey] = stored;
        done++;
      } catch (err) {
        console.error(err);
        toast(`Stopped after ${done} elements: ${err.message}`);
        break;
      }
    }
    el.legendEdit.classList.remove('visible');
    toast(`${req.pset}.${req.prop} set on ${done} element${done === 1 ? '' : 's'}.`);
    afterEdit();
  });
}

function wireEditingUI() {
  el.btnSetValue.addEventListener('click', openLegendEdit);
  el.btnExportIfc.addEventListener('click', exportEdits);
  el.btnDiscardEdits.addEventListener('click', discardEdits);
}

// ------------------------------------------------------------------ BCF issues

/** The open BCF: imported topics plus the ones raised here. */
let bcf = { topics: [], extra: new Map(), version: '2.1' };
let bcfSelected = null;
const AUTHOR_KEY = 'rsp-ifcsg.author';

function bcfAuthor() {
  return (el.bcfAuthor.value || '').trim() || 'RSP CX Radar';
}

const TYPE_CHIP = { fail: 'fail', error: 'fail', alert: 'alert', warning: 'alert', info: 'info' };
const STATUSES = ['Active', 'Resolved', 'Closed'];

function renderBcfList() {
  el.btnBcfExport.disabled = !bcf.topics.length;
  if (!bcf.topics.length) {
    el.bcfList.innerHTML = '<div class="empty-note">No issues yet. Import a BCF from the CORENET X Model Checker, raise a topic on a selected element, or turn check findings into topics with “To BCF” on the Compliance tab.</div>';
    el.bcfDetail.classList.remove('visible');
    return;
  }
  el.bcfList.innerHTML = bcf.topics.map((t) => {
    const typeChip = t.type ? `<span class="chip ${TYPE_CHIP[t.type.toLowerCase()] || ''}">${esc(t.type)}</span>` : '';
    const done = /resolved|closed/i.test(t.status || '');
    const statusChip = t.status ? `<span class="chip${done ? ' done' : ''}">${esc(t.status)}</span>` : '';
    const when = t.created ? new Date(t.created).toLocaleDateString() : '';
    return `<div class="bcf-row${t.guid === bcfSelected ? ' active' : ''}" data-guid="${esc(t.guid)}">
      <div class="bt">${esc(t.title)}<small>${esc([t.author, when, t.comments.length ? `${t.comments.length} comment${t.comments.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))}</small></div>
      <div class="chips">${typeChip}${statusChip}</div>
    </div>`;
  }).join('');
  el.bcfList.querySelectorAll('.bcf-row').forEach((row) => {
    row.addEventListener('click', () => selectTopic(row.dataset.guid));
  });
}

function selectTopic(guid) {
  bcfSelected = guid;
  renderBcfList();
  const topic = bcf.topics.find((t) => t.guid === guid);
  if (!topic) return;
  renderBcfDetail(topic);
  showTopicInModel(topic);
}

/** Every element GUID a topic points at: its viewpoints, then its description. */
function topicGuids(topic) {
  const out = new Set();
  for (const v of topic.viewpoints) for (const g of v.selection) out.add(g);
  // The Model Checker writes the GUID into the description; catch that too.
  for (const m of (topic.description || '').matchAll(/\b([0-9A-Za-z_$]{22})\b/g)) out.add(m[1]);
  return [...out];
}

/** Resolves GUIDs to drawable elements, through the index or the file text. */
async function resolveGuids(guids) {
  const found = [];
  const missing = [];
  for (const g of guids) {
    const el_ = index && index.byGuid.get(g);
    if (el_) found.push(el_);
    else missing.push(g);
  }
  if (missing.length && viewer && viewer.hasModels) {
    for (const entry of viewer.entries) {
      if (!entry.file) continue;
      let scan;
      try {
        scan = await textScanFor(entry.modelID);
      } catch {
        continue;
      }
      for (const g of [...missing]) {
        const id = scan.guidToId.get(g);
        if (id === undefined) continue;
        // Not in the index, but drawable: a bare element record is enough to colour it.
        found.push({ modelID: entry.modelID, expressID: id, key: `${entry.modelID}:${id}`, globalId: g, parts: [], name: g, entity: 'Element' });
        missing.splice(missing.indexOf(g), 1);
      }
    }
  }
  return { found, missing };
}

async function showTopicInModel(topic) {
  if (!viewer || !viewer.hasModels) return;
  const guids = topicGuids(topic);
  const { found, missing } = await resolveGuids(guids);
  const vp = topic.viewpoints.find((v) => v.camera);
  if (found.length) {
    shellActions.showInModel([{ label: topic.title, colour: 0xd16a4f, elements: found }], 'Issue', topic.title);
    if (!vp) viewer.fitElements(found);
  }
  if (vp && vp.camera) viewer.setViewpoint(vp.camera);
  if (missing.length && !found.length) {
    toast(guids.length
      ? `None of this topic's ${guids.length} element${guids.length === 1 ? '' : 's'} are in the loaded models.`
      : 'This topic does not name any element.');
  }
}

function renderBcfDetail(topic) {
  const statuses = [...new Set([...STATUSES, topic.status].filter(Boolean))];
  const snap = topic.viewpoints.find((v) => v.snapshotData);
  const snapUrl = snap ? URL.createObjectURL(new Blob([snap.snapshotData], { type: 'image/png' })) : null;
  el.bcfDetail.innerHTML = `
    <div class="bd-title">${esc(topic.title)}</div>
    <div class="bd-meta">${esc([topic.type, topic.author, topic.created ? new Date(topic.created).toLocaleString() : ''].filter(Boolean).join(' · '))}</div>
    ${topic.description ? `<div class="bd-desc">${esc(topic.description)}</div>` : ''}
    ${snapUrl ? `<img class="bd-snap" src="${snapUrl}" alt="Snapshot" />` : ''}
    <div class="bd-row"><span>Status</span><select data-status>${statuses.map((s) =>
      `<option${s === topic.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
    <div class="bd-row"><span>Assigned</span><input data-assigned value="${esc(topic.assignedTo || '')}" placeholder="name or email" /></div>
    ${topic.comments.map((c) => `<div class="bd-comment">${esc(c.text)}<small>${esc(c.author)} · ${esc(c.date ? new Date(c.date).toLocaleString() : '')}</small></div>`).join('')}
    <textarea data-comment placeholder="Add a comment…"></textarea>
    <div class="bd-actions">
      <button class="btn sm" data-show>Show in model</button>
      <button class="btn sm" data-comment-add>Comment</button>
      <span class="spacer"></span>
      <button class="btn sm" data-delete title="Remove this topic from the file">Delete</button>
    </div>`;
  el.bcfDetail.classList.add('visible');

  el.bcfDetail.querySelector('[data-status]').addEventListener('change', (e) => {
    topic.status = e.target.value;
    touchTopic(topic, bcfAuthor());
    renderBcfList();
  });
  el.bcfDetail.querySelector('[data-assigned]').addEventListener('change', (e) => {
    topic.assignedTo = e.target.value.trim() || null;
    touchTopic(topic, bcfAuthor());
  });
  el.bcfDetail.querySelector('[data-show]').addEventListener('click', () => showTopicInModel(topic));
  el.bcfDetail.querySelector('[data-comment-add]').addEventListener('click', () => {
    const box = el.bcfDetail.querySelector('[data-comment]');
    const text = box.value.trim();
    if (!text) return;
    topic.comments.push(newComment(bcfAuthor(), text));
    touchTopic(topic, bcfAuthor());
    renderBcfDetail(topic);
    renderBcfList();
  });
  el.bcfDetail.querySelector('[data-delete]').addEventListener('click', () => {
    if (!window.confirm(`Delete the topic "${topic.title}"?`)) return;
    bcf.topics = bcf.topics.filter((t) => t !== topic);
    bcfSelected = null;
    el.bcfDetail.classList.remove('visible');
    renderBcfList();
  });
}

async function importBcfFile(file) {
  try {
    const parsed = await readBcf(await file.arrayBuffer());
    const byGuid = new Map(bcf.topics.map((t) => [t.guid, t]));
    let added = 0, replaced = 0;
    for (const t of parsed.topics) {
      if (byGuid.has(t.guid)) { replaced++; bcf.topics[bcf.topics.indexOf(byGuid.get(t.guid))] = t; }
      else { added++; bcf.topics.push(t); }
    }
    for (const [k, v] of parsed.extra) if (!bcf.extra.has(k)) bcf.extra.set(k, v);
    bcf.version = parsed.version || bcf.version;
    renderBcfList();
    showTab('issues');
    toast(`${file.name}: ${added} topic${added === 1 ? '' : 's'} imported${replaced ? `, ${replaced} updated` : ''}.`);
  } catch (err) {
    console.error(err);
    toast(`${file.name}: ${err.message}`);
  }
}

/** A topic raised by hand on the element the inspector shows, with a snapshot. */
async function newTopicFromSelection() {
  const elements = lastPicked ? [lastPicked]
    : legend.filter((g, i) => soloIndex < 0 || soloIndex === i).flatMap((g) => g.elements);
  const guids = elements.map((e) => e.globalId).filter(Boolean);
  const modelName = lastPicked ? (viewer.models.get(lastPicked.modelID)?.name || '') : '';
  el.bcfDetail.innerHTML = `
    <div class="bd-form">
      <div class="bd-title">New topic${lastPicked ? ` on ${esc(lastPicked.name || lastPicked.entity)}` : ''}</div>
      <div class="bd-row"><span>Title</span><input data-title placeholder="What is wrong" /></div>
      <div class="bd-row"><span>Type</span><select data-type><option>Issue</option><option>Fail</option><option>Alert</option><option>Info</option></select></div>
      <div class="bd-row"><span>Details</span><textarea data-desc placeholder="Optional description"></textarea></div>
      <div class="bd-meta">${guids.length ? `${guids.length} element${guids.length === 1 ? '' : 's'} attached, with a snapshot of the current view.` : 'No element selected: the topic will carry the camera only.'}</div>
      <div class="bd-actions"><button class="btn sm primary" data-create>Create</button><button class="btn sm" data-cancel>Cancel</button></div>
    </div>`;
  el.bcfDetail.classList.add('visible');
  el.bcfDetail.querySelector('[data-title]').focus();
  el.bcfDetail.querySelector('[data-cancel]').addEventListener('click', () => el.bcfDetail.classList.remove('visible'));
  el.bcfDetail.querySelector('[data-create]').addEventListener('click', async () => {
    const title = el.bcfDetail.querySelector('[data-title]').value.trim();
    if (!title) { toast('Give the topic a title.'); return; }
    const type = el.bcfDetail.querySelector('[data-type]').value;
    const description = el.bcfDetail.querySelector('[data-desc]').value.trim();
    const topic = newTopic({
      title, type, description, author: bcfAuthor(),
      files: viewer.entries.map((e) => e.name),
    });
    let snapshotData = null;
    try {
      const png = await viewer.snapshot();
      snapshotData = png ? new Uint8Array(await png.arrayBuffer()) : null;
    } catch { snapshotData = null; }
    topic.viewpoints.push(newViewpoint({ selection: guids, camera: viewer.cameraViewpoint(), snapshotData }));
    if (modelName && !description) topic.description = guids.map((g) => `${g}; ${modelName}`).join('\n');
    bcf.topics.push(topic);
    selectTopic(topic.guid);
  });
}

/** Every failing or warning finding of the last run becomes a topic, in MC's description format. */
function findingsToBcf() {
  const files = viewer.entries.map((e) => e.name);
  const modelName = new Map(viewer.entries.map((e) => [e.modelID, e.name]));
  let n = 0;
  const CAP = 2000;
  for (const outcome of checkOutcomes) {
    const meta = registry.byId(outcome.id);
    if (!outcome.result || !meta) continue;
    for (const f of outcome.result.findings || []) {
      if (f.severity !== SEVERITY.FAIL && f.severity !== SEVERITY.WARN) continue;
      if (n >= CAP) break;
      const element = f.element || {};
      const guid = element.globalId || '';
      const topic = newTopic({
        title: `${meta.title}: ${f.label || f.code}`,
        type: f.severity === SEVERITY.FAIL ? 'Fail' : 'Alert',
        description: [f.rule || meta.title, f.message || f.label, guid, modelName.get(element.modelID) || '']
          .filter(Boolean).join('; '),
        author: bcfAuthor(),
        files,
      });
      if (guid) topic.viewpoints.push(newViewpoint({ selection: [guid] }));
      bcf.topics.push(topic);
      n++;
    }
  }
  renderBcfList();
  showTab('issues');
  toast(n >= CAP
    ? `${CAP} topics created; the rest were left out to keep the file manageable.`
    : `${n} topic${n === 1 ? '' : 's'} created from the check findings.`);
}

async function exportBcf() {
  if (!bcf.topics.length) return;
  try {
    const blob = await writeBcf(bcf);
    const base = project && project.project.code ? project.project.code : 'issues';
    await saveBlob(blob, `${base}.bcf`, [{ description: 'BCF', accept: { 'application/octet-stream': ['.bcf', '.bcfzip'] } }]);
    toast(`${bcf.topics.length} topic${bcf.topics.length === 1 ? '' : 's'} written.`);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error(err);
    toast('The BCF could not be written: ' + err.message);
  }
}

function wireBcfUI() {
  try {
    el.bcfAuthor.value = localStorage.getItem(AUTHOR_KEY) || '';
  } catch { /* storage blocked */ }
  el.bcfAuthor.addEventListener('change', () => {
    try { localStorage.setItem(AUTHOR_KEY, el.bcfAuthor.value.trim()); } catch { /* ignore */ }
  });
  el.btnBcfImport.addEventListener('click', () => el.bcfInput.click());
  el.bcfInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importBcfFile(file);
    e.target.value = '';
  });
  el.btnBcfNew.addEventListener('click', newTopicFromSelection);
  el.btnBcfExport.addEventListener('click', exportBcf);
  renderBcfList();
}

// -------------------------------------------------------------- model records

/**
 * A project keeps one record per model it has checked: what the file is, what
 * the dashboard measured, how each check came out and what it found. That is
 * what lets a four-file submission be checked one file at a time on a machine
 * that cannot hold them all, and still add up.
 *
 * Records are matched to files by content, never by name — see model-id.js.
 */

/** Findings kept per model. Beyond this the record stores a count. */
const FINDINGS_PER_MODEL = 3000;

const RECORD_STATE = {
  MATCH: 'match',       // loaded, and the record describes this same file
  RENAMED: 'renamed',   // loaded and matched, but the record has another name
  UPDATED: 'updated',   // loaded and matched, but the file has been re-issued
  NEW: 'new',           // loaded, no record yet
  MISSING: 'missing',   // recorded, not loaded now
  LEGACY: 'legacy',     // a name from a version 1 project, never checked here
};

const STATE_LABEL = {
  [RECORD_STATE.MATCH]: 'Loaded · recorded',
  [RECORD_STATE.RENAMED]: 'Renamed',
  [RECORD_STATE.UPDATED]: 'Re-issued',
  [RECORD_STATE.NEW]: 'Loaded · not recorded',
  [RECORD_STATE.MISSING]: 'Not loaded',
  [RECORD_STATE.LEGACY]: 'Expected',
};

/** A breakdown row without its element references, which cannot be written to a file. */
const recordedRow = (r) => ({ label: r.label, value: r.value, count: r.count });

/**
 * One model's dashboard, as recorded in the project: every quantity the card
 * shows, plus the breakdowns behind it, so the dashboard can be rebuilt from
 * the project file alone once the model is no longer loaded. Only the element
 * references are dropped — those live and die with the wasm index.
 * @param {object|null} dash  the dashboard computed for this model alone
 */
function dashboardForModel(dash) {
  if (!dash) return [];
  return dash.metrics.map((m) => ({
    id: m.id, title: m.title, unit: m.unit, decimals: m.decimals, isCount: m.isCount,
    total: m.total, count: m.count, candidates: m.candidates, missingValue: m.missingValue,
    valueSources: m.valueSources,
    subtotals: m.subtotals.map(recordedRow),
    byType: m.byType.map(recordedRow),
    byGroup: (m.byGroup || []).map(recordedRow),
    byLevel: m.byLevel.map(recordedRow),
    nearMisses: m.nearMisses,
    unset: m.unset,
  }));
}

/**
 * One model's record: current dashboard quantities always, check results
 * from the last run when there was one (kept from `prev` otherwise, so a
 * capture on load or on opening the dashboard cannot erase a prior run).
 * @param {object} entry     the viewer entry
 * @param {object|null} prev an existing record to update in place
 */
function buildModelRecord(entry, prev) {
  const idx = indexes.get(entry.modelID);
  const identity = identities.get(entry.modelID) || (prev && prev.identity) || null;
  // A finding about the submission rather than an element (file size, levels
  // across files) carries no element. It can only be attributed to a file when
  // that file was the only one open.
  const alone = viewer.entries.length === 1;

  let checks = [];
  let findings = [];
  let truncated = 0;

  // A capture triggered by loading or by opening the dashboard, rather than
  // by a check run, has no fresh outcomes to draw from. Keep whatever was
  // last recorded instead of wiping it out — only an actual run replaces it.
  if (!checkOutcomes.length && prev) {
    checks = [...(prev.checks || [])];
    findings = [...(prev.findings || [])];
    truncated = prev.findingsTruncated || 0;
  }

  for (const o of checkOutcomes) {
    const meta = o.meta || registry.byId(o.id);
    if (!meta) continue;
    if (o.error) {
      checks.push({ id: o.id, title: meta.title, authority: meta.authority, status: 'error',
        fail: 0, warn: 0, elements: null, assertions: null, pass: null, scope: alone ? 'file' : 'shared' });
      continue;
    }
    let fail = 0;
    let warn = 0;
    const touched = new Set();
    for (const f of o.result.findings || []) {
      const mine = f.element ? f.element.modelID === entry.modelID : alone;
      if (!mine) continue;
      if (f.element) touched.add(f.element.key);
      if (f.severity === SEVERITY.FAIL) fail++;
      else if (f.severity === SEVERITY.WARN) warn++;
      else continue;
      if (findings.length < FINDINGS_PER_MODEL) {
        findings.push({
          check: o.id,
          guid: f.element ? (f.element.globalId || null) : null,
          name: f.element ? (f.element.name || f.element.entity || null) : null,
          entity: f.element ? f.element.entity || null : null,
          severity: f.severity,
          code: f.code || null,
          label: f.label || null,
          message: f.message || null,
          rule: f.rule || null,
        });
      } else {
        truncated++;
      }
    }
    const s = o.result.summary || {};
    checks.push({
      id: o.id, title: meta.title, authority: meta.authority,
      status: fail ? 'fail' : warn ? 'warn' : (alone && !s.assertions) ? 'empty' : 'pass',
      fail, warn,
      // Only meaningful for a file checked on its own; otherwise the run's
      // totals cover every file and cannot be split.
      elements: alone ? (s.elements || 0) : touched.size,
      assertions: alone ? (s.assertions || 0) : null,
      pass: alone ? (s.pass || 0) : null,
      scope: alone ? 'file' : 'shared',
    });
  }

  const g = idx && idx.georef;
  return {
    id: (prev && prev.id) || 'm' + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: entry.name,
    identity,
    checkedAt: checkOutcomes.length ? new Date().toISOString() : (prev ? prev.checkedAt : null),
    rulesetGenerated: ruleset ? ruleset.meta.generated : null,
    elements: idx ? idx.count : 0,
    storeys: idx ? idx.storeys.map((s) => ({ name: s.name, elevation: s.elevation, globalId: s.globalId || null })) : [],
    georef: g ? {
      hasMapConversion: !!g.mapConversion,
      eastings: g.mapConversion ? g.mapConversion.eastings : null,
      northings: g.mapConversion ? g.mapConversion.northings : null,
      rotation: g.mapConversion ? g.mapConversion.rotation : null,
      crs: g.crs ? g.crs.name || null : null,
      lengthUnit: g.lengthUnitName || null,
    } : null,
    // Computed against this model's own index, so the figures belong to this
    // file alone and stay correct however the federated set is composed.
    dashboard: idx ? dashboardForModel(computeDashboard(idx, new Map([[entry.modelID, entry.name]])))
      : (prev ? prev.dashboard : []),
    checks,
    findings,
    findingsTruncated: truncated,
    legacy: false,
  };
}

/**
 * Writes a record for every loaded model into the project, matching each file
 * to any record it already has by content.
 * @returns {number} how many models were recorded
 */
function captureModelRecords() {
  if (!viewer.hasModels) return 0;
  if (!project) project = emptyProject();

  const records = project.models ? [...project.models] : [];
  // One record per file: a record already claimed by an earlier file in this
  // pass cannot be claimed again, however well it scores.
  const claimed = new Set();
  for (const entry of viewer.entries) {
    const identity = identities.get(entry.modelID);
    const hit = identity
      ? bestMatch(identity, records.filter((r) => r.identity && !claimed.has(r)))
      : { record: null };
    // Fall back to the name only for a version 1 record, which has no identity
    // to match against.
    const legacy = !hit.record && records.find((r) => r.legacy && !claimed.has(r) && r.name === entry.name);
    const prev = hit.record || legacy || null;
    if (prev) claimed.add(prev);
    const record = buildModelRecord(entry, prev);
    const at = prev ? records.indexOf(prev) : -1;
    if (at >= 0) records[at] = record;
    else records.push(record);
  }
  project.models = records;
  renderProjectChip();
  renderProjectPanel();
  return viewer.entries.length;
}

/**
 * Loaded models and stored records, side by side: what matched, what was
 * renamed, what has been re-issued and what is missing.
 * @returns {Array<{state: string, name: string, recordName: string|null,
 *   record: object|null, modelID: number|null, reasons: string[], match: object|null}>}
 */
function reconcileModels() {
  const records = (project && project.models) || [];
  const rows = [];
  const used = new Set();

  for (const entry of viewer.entries) {
    const identity = identities.get(entry.modelID) || null;
    const hit = identity ? bestMatch(identity, records.filter((r) => r.identity && !used.has(r))) : { record: null, confidence: MATCH.NONE, reasons: [] };
    let record = hit.record;
    let reasons = hit.reasons || [];
    if (!record) {
      // A version 1 record carries a name and nothing else.
      const legacy = records.find((r) => r.legacy && !used.has(r) && r.name === entry.name);
      if (legacy) { record = legacy; reasons = ['matched by file name only']; }
    }
    if (!record) {
      rows.push({ state: RECORD_STATE.NEW, name: entry.name, recordName: null, record: null,
        modelID: entry.modelID, reasons: [], match: null, identity });
      continue;
    }
    used.add(record);
    const revision = compareRevision(record.identity, identity);
    const state = revision.changed ? RECORD_STATE.UPDATED
      : record.name !== entry.name ? RECORD_STATE.RENAMED
        : RECORD_STATE.MATCH;
    rows.push({
      state, name: entry.name, recordName: record.name, record, modelID: entry.modelID,
      reasons: state === RECORD_STATE.UPDATED ? revision.reasons : reasons,
      match: hit.record ? hit : null, identity,
    });
  }

  for (const record of records) {
    if (used.has(record)) continue;
    rows.push({
      state: record.legacy ? RECORD_STATE.LEGACY : RECORD_STATE.MISSING,
      name: record.name, recordName: record.name, record, modelID: null, reasons: [], match: null, identity: null,
    });
  }
  return rows;
}

/** The one line under a model's name in the project panel. */
function modelSubtitle(row) {
  const r = row.record;
  if (!r) {
    return row.identity && row.identity.headerName && row.identity.headerName !== row.name
      ? `exported as ${row.identity.headerName} · not recorded yet`
      : 'not recorded yet';
  }
  const bits = [];
  if (row.state === RECORD_STATE.RENAMED) bits.push(`recorded as ${r.name}`);
  if (r.checkedAt) {
    const fails = (r.checks || []).reduce((s, c) => s + (c.fail || 0), 0);
    const warns = (r.checks || []).reduce((s, c) => s + (c.warn || 0), 0);
    bits.push(`checked ${new Date(r.checkedAt).toLocaleDateString()}`);
    bits.push(`${fails} fail, ${warns} warn`);
  } else if (r.legacy) {
    bits.push('from an earlier project file');
  } else {
    bits.push('recorded, not checked');
  }
  if (r.elements) bits.push(`${r.elements} element${r.elements === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/** Totals across every record, loaded or not — the submission as a whole. */
function submissionTotals() {
  const records = (project && project.models) || [];
  const checked = records.filter((r) => r.checkedAt);
  let fail = 0;
  let warn = 0;
  for (const r of checked) {
    for (const c of r.checks || []) { fail += c.fail || 0; warn += c.warn || 0; }
  }
  const dates = checked.map((r) => r.checkedAt).sort();
  return {
    models: records.length,
    checked: checked.length,
    elements: records.reduce((s, r) => s + (r.elements || 0), 0),
    fail, warn,
    oldest: dates[0] || null,
    newest: dates[dates.length - 1] || null,
  };
}

// ------------------------------------------------------------ readiness report

/**
 * The submission readiness PDF: the last run's outcomes, the project context,
 * a snapshot of the current view, and the hand-edit log, built without any
 * library (see report/pdf.js) and saved through the same picker as everything else.
 */
async function makeReport() {
  if (!checkOutcomes.length) {
    toast('Run the checks first; the report is built from their results.');
    return;
  }
  el.btnReport.disabled = true;
  try {
    let snapshot = null;
    try {
      const jpeg = viewer.hasModels ? await viewer.snapshot(1000, 'image/jpeg', 0.82) : null;
      if (jpeg) snapshot = { bytes: new Uint8Array(await jpeg.arrayBuffer()), width: jpeg.width, height: jpeg.height };
    } catch (err) {
      console.warn('No snapshot for the report:', err);
    }
    const ranIds = new Set(checkOutcomes.map((o) => o.id));
    const bytes = buildReadinessReport({
      project,
      models: viewer.entries.map((e) => ({
        name: e.name, bytes: e.bytes,
        elements: indexes.has(e.modelID) ? indexes.get(e.modelID).count : 0,
      })),
      outcomes: checkOutcomes,
      notRun: registry.all().filter((c) => !ranIds.has(c.id)),
      ruleset: ruleset ? { source: ruleset.meta.source, generated: ruleset.meta.generated } : {},
      author: (el.bcfAuthor.value || '').trim(),
      snapshot,
      edits: editLogsByFile(project ? project.edits || {} : {}),
      scope: {
        gateway: gatewayFilter || GATEWAY.CONSTRUCTION,
        authorities: projectAuthorities ? [...projectAuthorities] : [],
      },
    });
    const base = project && project.project.code ? project.project.code : 'submission';
    await saveBlob(new Blob([bytes], { type: 'application/pdf' }), `${base}-readiness-report.pdf`,
      [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }]);
    toast('Readiness report written.');
  } catch (err) {
    if (!(err && err.name === 'AbortError')) {
      console.error(err);
      toast('The report could not be written: ' + err.message);
    }
  } finally {
    el.btnReport.disabled = !checkOutcomes.length;
  }
}

// ------------------------------------------------- Microsoft Teams (no-op outside)

(function initTeams() {
  const script = document.createElement('script');
  script.src = 'https://res.cdn.office.net/teams-js/2.19.0/js/MicrosoftTeams.min.js';
  script.onload = () => {
    try {
      window.microsoftTeams.app.initialize()
        .then(() => window.microsoftTeams.app.notifySuccess())
        .catch(() => {});
    } catch { /* not running inside Teams */ }
  };
  document.head.appendChild(script);
})();

init();
