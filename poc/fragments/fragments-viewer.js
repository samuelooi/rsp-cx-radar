/**
 * A viewer on That Open Fragments, behind the same interface as js/viewer.js,
 * so the app can switch engines without its callers changing much.
 *
 * Covered so far: loading (an IFC is converted in a worker and cached, see
 * frag-store.js), several models at once, model visibility, hiding, query
 * colour groups with the ghost / hidden / normal context, selection with the
 * orbit pivot gliding onto it, picking, robust framing (farElements), BCF
 * viewpoints and snapshots.
 *
 * Not yet: plan views, sections, the geometry queries the checks use
 * (elementPoints, elementHull, …) and survey overlays.
 *
 * Differences from js/viewer.js callers must know about:
 *  - `pickElement` is async (Fragments raycasts in its worker), and returns
 *    the hit point too. `onPick` listeners still receive the hit object.
 *  - `refresh` (and so every visibility or colour change) is async; calls made
 *    while one is running are folded into one more pass.
 *  - Element ids are Fragments local ids, which the IFC importer takes from
 *    the IFC's expressIDs, so `{ modelID, expressID }` keeps working.
 *  - Properties come from the model itself (`itemData`), not from web-ifc.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as FRAGS from '@thatopen/fragments';
import { fragFor } from './frag-store.js';

/** The Fragments worker, served beside this file (see README: hosted pages). */
const WORKER_URL = new URL('./vendor/fragments-worker.mjs', import.meta.url).href;

/** See js/viewer.js: elements beyond this from the model's core are not framed. */
const FAR_FACTOR = 3;
const FAR_MIN_M = 300;

const PIVOT_MS = 350;

const SELECTION = {
  color: new THREE.Color(0x2f8cff), renderedFaces: FRAGS.RenderedFaces.TWO, opacity: 1, transparent: false,
};
const GHOST = {
  color: new THREE.Color(0xb8c0cc), renderedFaces: FRAGS.RenderedFaces.TWO, opacity: 0.07, transparent: true,
};

export class FragmentsViewer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1e23);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    this.camera.position.set(18, 14, 18);
    this.activeCamera = this.camera;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    // Forma's mapping, as in js/viewer.js.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('start', () => { this._pivotAnim = null; });
    // Fragments streams detail by what the camera sees, so it is told each move.
    this.controls.addEventListener('change', () => this.fragments.update());

    this.scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x1a1c20, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(20, 30, 10);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-20, 10, -15);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(60, 60, 0x343a42, 0x2a2e35);
    this.scene.add(this.grid);
    this.groundY = 0;

    // Fragments places every model after the first against the first one's
    // coordinates (settings.autoCoordinate), which is the federation datum
    // js/viewer.js keeps in coordinationMatrix.
    this.fragments = new FRAGS.FragmentsModels(WORKER_URL);
    // Coplanar faces from different elements flicker; a small random offset
    // per material settles them (That Open's own examples do the same).
    this.fragments.models.materials.list.onItemSet.add(({ value: material }) => {
      if (material.isLodMaterial) return;
      material.polygonOffset = true;
      material.polygonOffsetUnits = 1;
      material.polygonOffsetFactor = Math.random();
    });
    this.coordinationMatrix = null;

    /** modelID -> entry, see load() */
    this.models = new Map();
    this._seq = 0;

    this.hiddenByModel = new Map();
    this.hiddenVersion = 0;
    this.farElements = [];
    this.groups = [];
    this.contextMode = 'ghost';
    this.selection = null;
    this._pivotAnim = null;

    this.pickSuspended = false;
    this.pickListeners = [];
    this.menuListeners = [];
    this.frameListeners = [];
    this.lastPickMs = 0;

    this._downPos = {};
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => { this._downPos[e.button] = { x: e.clientX, y: e.clientY }; });
    dom.addEventListener('click', async (e) => {
      if (this.pickSuspended || this._wasDrag(0, e)) return;
      const hit = await this.pickElement(e);
      this.pickListeners.forEach((cb) => cb(hit));
    });
    dom.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (this._wasDrag(2, e)) return;
      const hit = await this.pickElement(e);
      this.menuListeners.forEach((cb) => cb(hit, e.clientX, e.clientY));
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this._animate());
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.fragments.update();
  }

  _animate() {
    this._stepPivot();
    this.controls.update();
    for (const cb of this.frameListeners) cb();
    this.renderer.render(this.scene, this.activeCamera);
  }

  _wasDrag(button, e) {
    const d = this._downPos[button];
    return !!d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5;
  }

  onPick(cb) { this.pickListeners.push(cb); }
  onContextMenu(cb) { this.menuListeners.push(cb); }
  onFrame(cb) { this.frameListeners.push(cb); }

  // ------------------------------------------------------------ model loading

  get hasModels() { return this.models.size > 0; }
  get entries() { return [...this.models.values()]; }

  /**
   * Opens an IFC (converted in a worker, or read from the cache) or a .frag,
   * alongside anything already open.
   * @param {File} file
   * @param {(pct: number, stage?: string, ifcClass?: string) => void} [onProgress]
   *   `ifcClass` is the class whose geometry was just finished: the converter
   *   reports once per class, so a large class is a long silent step.
   * @param {{ signal?: AbortSignal }} [opts] abort to cancel a conversion
   */
  async load(file, onProgress = () => {}, { signal } = {}) {
    const timings = {};
    const { bytes, source, convertMs } = await fragFor(file, {
      signal,
      onProgress: (p, stage, ifcClass) => onProgress(p * 90, stage, ifcClass),
    });
    if (convertMs != null) timings.convertMs = convertMs;

    onProgress(92, 'opening');
    const modelID = ++this._seq;
    // Fragments takes the buffer over (it is transferred to its worker).
    const fragSize = bytes.byteLength;
    const t0 = performance.now();
    const model = await this.fragments.load(bytes, { modelId: String(modelID), camera: this.camera });
    this.scene.add(model.object);
    await this.fragments.update(true);
    timings.openMs = performance.now() - t0;

    // Per-element extents, for framing without stray far-away geometry.
    const t1 = performance.now();
    const ids = await model.getItemsIdsWithGeometry();
    const boxList = await model.getBoxes(ids);
    const boxes = new Map();
    ids.forEach((id, i) => {
      const b = boxList[i];
      if (b && !b.isEmpty()) boxes.set(id, [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]);
    });
    timings.boxesMs = performance.now() - t1;

    if (!this.coordinationMatrix) {
      try { this.coordinationMatrix = await model.getCoordinationMatrix(); } catch { /* no datum */ }
    }

    const entry = {
      modelID,
      name: file.name,
      bytes: file.size || 0,
      file,
      model,
      fragSize,
      source,
      geometryIds: ids,
      boxes,
      visible: true,
      timings,
    };
    this.models.set(modelID, entry);
    await this.refresh();
    return entry;
  }

  async removeModel(modelID) {
    const entry = this.models.get(modelID);
    if (!entry) return;
    if (this.selection && this.selection.modelID === modelID) this.selection = null;
    this.models.delete(modelID);
    this.hiddenByModel.delete(modelID);
    this.scene.remove(entry.model.object);
    await this.fragments.disposeModel(entry.model.modelId);
    if (!this.models.size) this.coordinationMatrix = null;
    await this.refresh();
  }

  setModelVisible(modelID, on) {
    const entry = this.models.get(modelID);
    if (!entry) return;
    entry.visible = on;
    return this.refresh();
  }

  /** Nothing to release: the parsed IFC never reaches this page. Kept for the interface. */
  releaseModelData() {}

  /**
   * An element's attributes and relations, read from the model.
   * @returns {Promise<object|null>}
   */
  async itemData(el, config = { attributesDefault: true, relationsDefault: { attributes: false, relations: false } }) {
    const entry = this.models.get(el.modelID);
    if (!entry) return null;
    const [data] = await entry.model.getItemsData([el.expressID], config);
    return data || null;
  }

  // ------------------------------------------------------------- visibility

  _geometryIds(el) {
    return el.parts && el.parts.length ? [el.expressID, ...el.parts] : [el.expressID];
  }

  hiddenSet(modelID) {
    let s = this.hiddenByModel.get(modelID);
    if (!s) this.hiddenByModel.set(modelID, (s = new Set()));
    return s;
  }

  isHidden(el) {
    const s = this.hiddenByModel.get(el.modelID);
    return !!s && s.has(el.expressID);
  }

  get hiddenCount() {
    let n = 0;
    for (const s of this.hiddenByModel.values()) n += s.size;
    return n;
  }

  setHidden(elements) {
    this.hiddenByModel.clear();
    for (const el of elements) {
      const set = this.hiddenSet(el.modelID);
      for (const id of this._geometryIds(el)) set.add(id);
    }
    this.hiddenVersion++;
    return this.refresh();
  }

  showAll() {
    this.hiddenByModel.clear();
    this.hiddenVersion++;
    for (const entry of this.models.values()) entry.visible = true;
    return this.refresh();
  }

  // --------------------------------------------------------------- overlays

  /** @param {Array<{elements: Array, colour: number}>} groups */
  setGroups(groups) {
    this.groups = groups || [];
    return this.refresh();
  }

  setQuery(groups, contextMode) {
    this.groups = groups || [];
    if (contextMode) this.contextMode = contextMode;
    return this.refresh();
  }

  clearGroups() {
    this.groups = [];
    return this.refresh();
  }

  setContextMode(mode) {
    this.contextMode = mode;
    return this.refresh();
  }

  reset() {
    this.groups = [];
    this.contextMode = 'ghost';
    return this.refresh();
  }

  /**
   * Reconciles every model with the hidden set, the query groups, the context
   * mode and the selection. Fragments applies each change in its worker, so
   * this is async; calls made while it runs fold into one more pass.
   */
  refresh() {
    this._boxCache = null;
    this._dirty = true;
    if (!this._refreshing) {
      this._refreshing = (async () => {
        try {
          while (this._dirty) {
            this._dirty = false;
            await this._apply();
          }
        } finally {
          this._refreshing = null;
        }
      })();
    }
    return this._refreshing;
  }

  async _apply() {
    const hasQuery = this.groups.length > 0;
    for (const entry of this.models.values()) {
      const { model, modelID } = entry;
      model.object.visible = entry.visible;
      if (!entry.visible) continue;

      const hidden = this.hiddenByModel.get(modelID);
      await model.resetHighlight();
      await model.resetVisible();
      if (hidden && hidden.size) await model.setVisible([...hidden], false);

      if (hasQuery) {
        const grouped = new Set();
        const perGroup = this.groups.map((g) => {
          const ids = [];
          for (const el of g.elements) {
            if (el.modelID !== modelID || this.isHidden(el)) continue;
            for (const id of this._geometryIds(el)) {
              if (hidden && hidden.has(id)) continue;
              ids.push(id);
              grouped.add(id);
            }
          }
          return { ids, colour: g.colour };
        });

        if (this.contextMode === 'ghost') {
          await model.highlight(undefined, GHOST);
        } else if (this.contextMode === 'hidden') {
          const others = entry.geometryIds.filter((id) => !grouped.has(id));
          if (others.length) await model.setVisible(others, false);
        }
        for (const { ids, colour } of perGroup) {
          if (!ids.length) continue;
          await model.highlight(ids, { ...SELECTION, color: new THREE.Color(colour) });
        }
      }

      const sel = this.selection;
      if (sel && sel.modelID === modelID) {
        const ids = this._geometryIds(sel).filter((id) => !hidden || !hidden.has(id));
        if (ids.length) await model.highlight(ids, SELECTION);
      }
    }
    await this.fragments.update(true);
  }

  // -------------------------------------------------------------- selection

  setSelection(el, { pivot = true } = {}) {
    this.selection = el && this.models.has(el.modelID)
      ? { modelID: el.modelID, expressID: el.expressID, parts: el.parts }
      : null;
    const done = this.refresh();
    if (this.selection && pivot) this._pivotTo(this.selection);
    return done;
  }

  clearSelection() {
    return this.setSelection(null);
  }

  /** Bounding box of a set of elements, through their parts where they have them. */
  async _elementsBox(elements) {
    const box = new THREE.Box3();
    const perModel = new Map();
    for (const el of elements || []) {
      if (!perModel.has(el.modelID)) perModel.set(el.modelID, []);
      perModel.get(el.modelID).push(...this._geometryIds(el));
    }
    for (const [modelID, ids] of perModel) {
      const entry = this.models.get(modelID);
      if (entry) box.union(await entry.model.getMergedBox(ids));
    }
    return box;
  }

  async _pivotTo(el) {
    const box = await this._elementsBox([el]);
    if (box.isEmpty()) return;
    const to = box.getCenter(new THREE.Vector3());
    if (to.distanceToSquared(this.camera.position) < 1e-4) return;
    this._pivotAnim = { from: this.controls.target.clone(), to, t0: performance.now() };
  }

  _stepPivot() {
    const a = this._pivotAnim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.t0) / PIVOT_MS);
    const k = 1 - Math.pow(1 - t, 3);
    this.controls.target.lerpVectors(a.from, a.to, k);
    if (t >= 1) this._pivotAnim = null;
  }

  // ----------------------------------------------------------------- picking

  /**
   * The nearest visible element under the pointer, across every model.
   * @returns {Promise<{modelID:number, expressID:number, point:THREE.Vector3, normal?:THREE.Vector3}|null>}
   */
  async pickElement(event) {
    if (!this.hasModels) return null;
    const t0 = performance.now();
    const mouse = new THREE.Vector2(event.clientX, event.clientY);
    const dom = this.renderer.domElement;
    let best = null;
    for (const entry of this.models.values()) {
      if (!entry.visible) continue;
      const hit = await entry.model.raycast({ camera: this.activeCamera, mouse, dom });
      if (hit && (!best || hit.distance < best.hit.distance)) best = { entry, hit };
    }
    this.lastPickMs = performance.now() - t0;
    if (!best) return null;
    return { modelID: best.entry.modelID, expressID: best.hit.localId, point: best.hit.point, normal: best.hit.normal };
  }

  // ------------------------------------------------------------------ camera

  /** See js/viewer.js _visibleBox: frame everything except far-away strays. */
  _visibleBox() {
    const visible = this.entries.filter((e) => e.visible);
    const key = visible.map((e) => e.modelID).join(',');
    if (this._boxCache && this._boxCache.key === key) return this._boxCache.box;

    const all = [];
    for (const e of visible) for (const [id, b] of e.boxes) all.push({ modelID: e.modelID, expressID: id, b });

    let box = null;
    let far = [];
    if (all.length >= 5) {
      const pct = (axis, q) => {
        const v = all.map((x) => (x.b[axis] + x.b[axis + 3]) / 2).sort((a, b) => a - b);
        return v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
      };
      const core = new THREE.Box3(
        new THREE.Vector3(pct(0, 0.1), pct(1, 0.1), pct(2, 0.1)),
        new THREE.Vector3(pct(0, 0.9), pct(1, 0.9), pct(2, 0.9)));
      const size = core.getSize(new THREE.Vector3());
      const limit = Math.max(FAR_MIN_M, FAR_FACTOR * Math.max(size.x, size.y, size.z));
      const c = new THREE.Vector3();
      box = new THREE.Box3();
      for (const x of all) {
        c.set((x.b[0] + x.b[3]) / 2, (x.b[1] + x.b[4]) / 2, (x.b[2] + x.b[5]) / 2);
        const d = core.distanceToPoint(c);
        if (d > limit) far.push({ modelID: x.modelID, expressID: x.expressID, distance: d });
        else box.expandByPoint(c.set(x.b[0], x.b[1], x.b[2])).expandByPoint(c.set(x.b[3], x.b[4], x.b[5]));
      }
      if (box.isEmpty()) { box = null; far = []; }
    }
    if (!box) {
      box = new THREE.Box3();
      for (const e of visible) box.union(e.model.box);
      if (box.isEmpty()) box = null;
    }
    far.sort((a, b) => b.distance - a.distance);
    this.farElements = far;
    this._boxCache = { key, box };
    return box;
  }

  fit() {
    const box = this._visibleBox();
    if (!box) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 10;
    const dist = maxDim * 1.6;
    this.camera.position.set(center.x + dist, center.y + dist * 0.75, center.z + dist);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 50;
    this.camera.updateProjectionMatrix();
    this._pivotAnim = null;
    this.controls.target.copy(center);
    this.controls.update();
    this.grid.position.y = box.min.y;
    this.groundY = box.min.y;
    this.fragments.update(true);
  }

  async fitElements(elements) {
    const box = await this._elementsBox(elements);
    if (box.isEmpty()) return false;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const dist = Math.max(Math.max(size.x, size.y, size.z), 2) * 1.8;
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.75, 1);
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this._pivotAnim = null;
    this.controls.target.copy(center);
    this.controls.update();
    this.fragments.update(true);
    return true;
  }

  /** See js/viewer.js: the camera as a BCF viewpoint, IFC coordinates, Z up. */
  cameraViewpoint() {
    const Minv = (this.coordinationMatrix || new THREE.Matrix4()).clone().invert();
    const toIfc = (v) => { const s = v.clone().applyMatrix4(Minv); return { x: s.x, y: -s.z, z: s.y }; };
    const toIfcDir = (v) => { const s = v.clone().transformDirection(Minv); return { x: s.x, y: -s.z, z: s.y }; };
    const cam = this.activeCamera;
    const direction = new THREE.Vector3();
    cam.getWorldDirection(direction);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
    return { type: 'perspective', position: toIfc(cam.position), direction: toIfcDir(direction), up: toIfcDir(up), fov: cam.fov };
  }

  setViewpoint(vp) {
    if (!vp || !vp.position || !vp.direction) return false;
    const M = this.coordinationMatrix || new THREE.Matrix4();
    const fromIfc = (p) => new THREE.Vector3(p.x, p.z, -p.y).applyMatrix4(M);
    const fromIfcDir = (p) => new THREE.Vector3(p.x, p.z, -p.y).transformDirection(M).normalize();
    const position = fromIfc(vp.position);
    const direction = fromIfcDir(vp.direction);
    if (!Number.isFinite(position.x) || direction.lengthSq() < 1e-9) return false;
    this.camera.position.copy(position);
    if (vp.up) this.camera.up.copy(fromIfcDir(vp.up));
    if (vp.fov) this.camera.fov = vp.fov;
    this.camera.updateProjectionMatrix();
    const box = this._visibleBox();
    const reach = box ? box.getSize(new THREE.Vector3()).length() * 0.5 : 20;
    this._pivotAnim = null;
    this.controls.target.copy(position).addScaledVector(direction, reach);
    this.controls.update();
    this.fragments.update(true);
    return true;
  }

  /** A PNG of the current view, rendered fresh so the buffer is populated. */
  snapshot(maxWidth = 1280, type = 'image/png', quality = 0.85) {
    this.renderer.render(this.scene, this.activeCamera);
    const src = this.renderer.domElement;
    const scale = Math.min(1, maxWidth / src.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(src.width * scale);
    canvas.height = Math.round(src.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#' + this.scene.background.getHexString();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((blob) =>
      resolve(blob ? Object.assign(blob, { width: canvas.width, height: canvas.height }) : null), type, quality));
  }
}
