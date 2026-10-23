/**
 * Three.js viewer: multi-model loading, element visibility, and the isolate /
 * colour overlays the IFC-SG queries drive.
 *
 * Two independent mechanisms are at work, and they deliberately do not overlap:
 *
 *  - **Colouring** uses web-ifc-three "subsets" — extra meshes that reuse the
 *    model's vertex buffers but index only the chosen elements. Subsets read
 *    from a pristine index cache, so they are unaffected by the hiding below.
 *
 *  - **Hiding** rewrites the base mesh's own index buffer, collapsing a hidden
 *    element's triangles to degenerate (zero-area) ones that the GPU discards.
 *    That costs only the hidden elements' indices, so hiding stays instant even
 *    on a large model, and the base mesh stays a single draw call.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IFCLoader } from 'web-ifc-three/IFCLoader';
import { convexHull } from './geo/polygon.js';

/**
 * Where web-ifc's engine (web-ifc.wasm, from the same 0.0.36 release the
 * import map loads) is served from: a copy kept in this repository, beside the
 * app. Hosts that allow scripts from a CDN but no other requests to it (a
 * published Claude artifact, a strict CSP) would otherwise fail to load it.
 * An absolute URL, because web-ifc resolves a relative one against its own
 * script's location on the CDN.
 */
export const WASM_PATH = new URL('../vendor/web-ifc/', import.meta.url).href;

/**
 * Store vertex normals as signed bytes instead of floats.
 *
 * web-ifc emits three float32 per vertex for normals, which on a large model is
 * the single biggest buffer in the scene (357 MB on a 71 MB IFC). A unit normal
 * needs nowhere near that range: signed-byte normals cost a quarter as much and
 * are accurate to about half a degree, which is not visible on flat-shaded
 * building geometry. Set this to false if shading ever looks wrong.
 */
const COMPRESS_NORMALS = true;

/**
 * Rewrites a geometry's float32 normals as signed bytes, flagged `normalized`
 * so WebGL maps them back to [-1, 1] in the shader. Returns the bytes saved.
 */
export function compressNormals(geometry) {
  const src = geometry && geometry.attributes && geometry.attributes.normal;
  if (!src || src.array instanceof Int8Array) return 0;

  const from = src.array;
  const packed = new Int8Array(from.length);
  for (let i = 0; i < from.length; i++) {
    const v = from[i];
    // Clamp before scaling: web-ifc normals are unit length, but a denormal or
    // NaN would otherwise wrap around in the byte conversion.
    packed[i] = v >= 1 ? 127 : v <= -1 ? -127 : Math.round((v || 0) * 127);
  }

  geometry.setAttribute('normal', new THREE.BufferAttribute(packed, 3, true));
  return from.byteLength - packed.byteLength;
}

/**
 * Bounding box of every element in a mesh, from its per-vertex expressID
 * attribute: expressID -> [minX, minY, minZ, maxX, maxY, maxZ].
 * One pass over the vertices, made once per model at load.
 */
export function elementBoxes(geometry) {
  const boxes = new Map();
  const pos = geometry.attributes.position;
  const ids = geometry.attributes.expressID;
  if (!pos || !ids) return boxes;
  const p = pos.array;
  const id = ids.array;
  for (let i = 0, n = pos.count; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    let b = boxes.get(id[i]);
    if (!b) boxes.set(id[i], (b = [x, y, z, x, y, z]));
    else {
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
      if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
    }
  }
  return boxes;
}

/**
 * Elements are "far" when their centre lies further than this from the core of
 * the model: FAR_FACTOR times the core's size, and never less than FAR_MIN_M.
 * The core is the box holding the middle 80% of element centres on each axis.
 * Anything within three core-widths of it stays, so a long site of trees or a
 * row of blocks stays whole, while a stray object kilometres away does not
 * stretch the view.
 */
const FAR_FACTOR = 3;
const FAR_MIN_M = 300;

/** The selected element's highlight: Forma's selection blue, lit a little from within. */
const SELECTION_COLOUR = 0x2f8cff;
const SELECTION_EMISSIVE = 0x0b3d80;
const SELECTION_ID = 'selection';

/** How long the orbit pivot takes to glide onto a newly selected element. */
const PIVOT_MS = 350;

/**
 * Large models are drawn by That Open Fragments instead of web-ifc-three (see
 * loadFragments). Its worker is served from this repository, like the wasm.
 */
const FRAG_WORKER_URL = new URL('../vendor/fragments/worker.mjs', import.meta.url).href;

/**
 * Fragments models get handles from here up, so they never collide with
 * web-ifc's (0, 1, 2, …) in `modelID:expressID` keys.
 */
const FRAG_ID_BASE = 1000;

/** Elements per getItemsGeometry request while building a shadow mesh. */
const FRAG_GEOMETRY_CHUNK = 2000;

export class Viewer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1e23);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    this.camera.position.set(18, 14, 18);

    // A second camera for plan views: true orthographic, straight down, so a
    // "plan" is an accurate flat projection rather than a steep perspective shot.
    this.orthoCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 5000);
    this.activeCamera = this.camera;
    this._orthoHalfHeight = 10;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    // Forma's mapping: left drag orbits, right or middle drag pans, the wheel
    // zooms. A right *click* (no drag) still opens the context menu.
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    // A drag that starts while the pivot is still gliding to a selection takes
    // over from wherever the glide got to.
    this.controls.addEventListener('start', () => { this._pivotAnim = null; });
    // Fragments streams detail by what the camera sees, so it is told each move.
    this.controls.addEventListener('change', () => this.fragments && this.fragments.update());

    // Locked to top-down: no orbit, just pan/zoom, so plan mode can't be tilted
    // into a perspective view by accident. With nothing to orbit, left drag
    // pans too.
    this.controlsOrtho = new OrbitControls(this.orthoCamera, this.renderer.domElement);
    this.controlsOrtho.enableDamping = true;
    this.controlsOrtho.dampingFactor = 0.08;
    this.controlsOrtho.enableRotate = false;
    this.controlsOrtho.screenSpacePanning = true;
    this.controlsOrtho.enabled = false;
    this.controlsOrtho.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controlsOrtho.addEventListener('change', () => this.fragments && this.fragments.update());

    /** That Open's FragmentsModels, created with the first large model (see loadFragments). */
    this.fragments = null;
    this._fragSeq = 0;
    this._fragSync = null;   // the running Fragments reconcile, see _syncFragments
    this._fragDirty = false;

    // Section cuts (axis-aligned, placed on a picked face) and the plan level
    // cut (horizontal), combined into one clipping-plane list on the renderer.
    this.sectionPlanes = [];   // [{ id, axis, normal, anchor, plane, group }]
    this._sectionSeq = 0;
    this._sectionDrag = null;  // { id, anchor0, t0 } while a cut is being slid
    this.planClipPlane = null; // THREE.Plane | null
    this.groundY = 0;

    this.scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x1a1c20, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(20, 30, 10);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-20, 10, -15);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(60, 60, 0x343a42, 0x2a2e35);
    this.scene.add(this.grid);

    this.loader = new IFCLoader();
    // ifcManager.setWasmPath cannot mark the path absolute, so set it on the API.
    this.loader.ifcManager.state.api.SetWasmPath(WASM_PATH, true);
    this.loader.ifcManager.state.wasmPath = WASM_PATH;

    /**
     * The shared datum for federated models, adopted from the first file loaded.
     *
     * IFC files in a set are authored against a common survey origin, often far
     * from (0,0,0). web-ifc's COORDINATE_TO_ORIGIN shifts a model to the origin
     * using a transform derived from *that file alone*, which is right for a
     * single model and wrong for a federation — each file gets a different
     * shift and their relative placement is destroyed. So the first model is
     * re-centred normally, its transform is captured here, and every later model
     * is loaded with that same transform and no re-centring of its own.
     *
     * Applying it inside web-ifc (rather than moving the mesh afterwards) means
     * vertices are generated already near the origin, which matters because
     * web-ifc returns them as float32.
     */
    this.coordinationMatrix = null;

    /** modelID -> { modelID, name, mesh, baseMaterials, ghostMaterials, visible } */
    this.models = new Map();

    /** modelID -> Set<expressID> the user has hidden. */
    this.hiddenByModel = new Map();

    this.farElements = [];       // elements left out of framing, see _visibleBox
    this.groups = [];            // [{ elements, colour }] from the active query
    this.overlays = [];          // created subsets, tracked for exact teardown
    this.surveyOverlays = [];    // cadastral / site-boundary polygons, see setSurveyOverlays
    this.contextMode = 'ghost';  // how un-selected geometry is drawn during a query
    this.hiddenVersion = 0;      // bumped on every visibility change, see _applyHidden

    // The selected element, redrawn over the model in one highlight colour, and
    // the orbit pivot gliding onto it (see setSelection).
    this.selection = null;       // { modelID, expressID, parts? } | null
    this.selectionMesh = null;
    this.selectionMaterial = new THREE.MeshLambertMaterial({
      color: SELECTION_COLOUR,
      emissive: SELECTION_EMISSIVE,
      side: THREE.DoubleSide,
      // Pull the highlight towards the camera so it wins against the base mesh
      // and any overlay drawn over the same triangles.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this._pivotAnim = null;      // { from, to, t0 } while the pivot is moving

    this.pickListeners = [];
    this.menuListeners = [];

    // Both mouse buttons drive a camera drag (left orbits, right pans), so a
    // click/contextmenu firing on release of a drag would otherwise pick an
    // element or pop the menu at wherever the drag happened to end. Track each
    // button's mousedown point and ignore the follow-up if it moved.
    this._downPos = {};
    this.frameListeners = [];
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this._downPos[e.button] = { x: e.clientX, y: e.clientY };
    });

    this.renderer.domElement.addEventListener('click', async (e) => {
      // A tool that owns clicks (measuring) sets this, so no pick is wasted.
      if (this.pickSuspended || this._wasDrag(0, e)) return;
      const hit = await this._pickAtAsync(e);
      this.pickListeners.forEach((cb) => cb(hit));
    });
    this.renderer.domElement.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      if (this._wasDrag(2, e)) return;
      const hit = await this._pickAtAsync(e);
      this.menuListeners.forEach((cb) => cb(hit, e.clientX, e.clientY));
    });

    // Large models answer picks from their worker; see _probe.
    this._fragTris = new Map();
    this._probeHit = null;
    this._probeRun = null;
    this._probeWanted = null;
    this._cameraVersion = 0;
    for (const c of [this.controls, this.controlsOrtho]) c.addEventListener('change', () => { this._cameraVersion++; });
    this.renderer.domElement.addEventListener('pointermove', (e) => {
      if (this.fragments && !e.buttons && this._hasFragments()) this._probe(e);
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this._animate();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._applyOrthoFrustum();
    this.renderer.setSize(w, h);
  }

  _applyOrthoFrustum() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = w / h;
    const halfH = this._orthoHalfHeight || 10;
    this.orthoCamera.left = -halfH * aspect;
    this.orthoCamera.right = halfH * aspect;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.updateProjectionMatrix();
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this._stepPivot();
    this.controls.update();
    this.controlsOrtho.update();
    for (const cb of this.frameListeners) cb();
    this.renderer.render(this.scene, this.activeCamera);
  }

  // ------------------------------------------------------------ model loading

  get hasModels() {
    return this.models.size > 0;
  }

  get entries() {
    return [...this.models.values()];
  }

  /** Loads an IFC file and adds it alongside anything already open. */
  async load(file, onProgress = () => {}) {
    const url = URL.createObjectURL(file);
    try {
      this.loader.ifcManager.setOnProgress((e) => {
        onProgress(e.total ? (e.loaded / e.total) * 100 : 40);
      });

      // See `coordinationMatrix`: the first model establishes the datum, every
      // later model is placed against it instead of being re-centred on itself.
      const isFirst = !this.coordinationMatrix;
      await this.loader.ifcManager.applyWebIfcConfig({
        COORDINATE_TO_ORIGIN: isFirst,
        USE_FAST_BOOLS: true,
      });
      if (isFirst) this.loader.ifcManager.clearCoordinationMatrix();
      else this.loader.ifcManager.setupCoordinationMatrix(this.coordinationMatrix);

      const mesh = await this.loader.loadAsync(url);

      // Before any subset exists, so subsets (which share this attribute by
      // reference) pick up the compressed version automatically.
      if (COMPRESS_NORMALS) compressNormals(mesh.geometry);
      // Per-element extents, so framing can leave out stray far-away geometry.
      const boxes = elementBoxes(mesh.geometry);

      const baseMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const ghostMaterials = baseMaterials.map((m) => {
        const g = m.clone();
        g.transparent = true;
        g.opacity = 0.07;
        g.depthWrite = false;
        return g;
      });

      // web-ifc-three stamps the mesh from its own counter, but everything that
      // matters (subsets, close, the property API) is keyed by web-ifc's model
      // handle. They only coincide while every load succeeds, so resolve the
      // real handle rather than trusting the counter.
      const modelID = this._resolveModelID(mesh);
      mesh.modelID = modelID;

      // web-ifc only computes the coordination matrix while streaming geometry,
      // so it has to be read after the load completes, not right after opening.
      if (isFirst) {
        try {
          const m = this.api.GetCoordinationMatrix(modelID);
          if (m && m.length === 16 && Array.from(m).every(Number.isFinite)) {
            this.coordinationMatrix = new THREE.Matrix4().fromArray(Array.from(m));
          }
        } catch { /* no geometry to derive a datum from; later models keep world coords */ }
      }

      const entry = {
        modelID,
        name: file.name,
        // Kept because CORENET X caps each submitted file, and the source file
        // is gone by the time a check runs.
        bytes: file.size || 0,
        // The File itself costs nothing to hold (the browser reads it from disk
        // on demand) and is what editing and GUID lookup read from later.
        file,
        mesh,
        boxes,
        baseMaterials,
        ghostMaterials,
        visible: true,
        appliedHiddenVersion: -1,
        everHidden: false,
        released: false,
      };
      this.scene.add(mesh);
      this.models.set(entry.modelID, entry);
      this.refresh();
      return entry;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ------------------------------------------------------------ large models

  /** FragmentsModels, created on first use so small-model sessions never load it. */
  async _fragmentsModels() {
    if (this.fragments) return this.fragments;
    const FRAGS = await import('@thatopen/fragments');
    this._FRAGS = FRAGS;
    const fm = new FRAGS.FragmentsModels(FRAG_WORKER_URL);
    // Models are placed by this viewer's datum (see _placeFragments), not by
    // Fragments' own "relative to the first model".
    fm.settings.autoCoordinate = false;
    // Coplanar faces from different elements flicker; a small random offset per
    // material settles them (That Open's own examples do the same).
    fm.models.materials.list.onItemSet.add(({ value: material }) => {
      if (material.isLodMaterial) return;
      material.polygonOffset = true;
      material.polygonOffsetUnits = 1;
      material.polygonOffsetFactor = Math.random();
    });
    this.fragments = fm;
    return fm;
  }

  /**
   * Opens a converted model (js/frag/store.js) alongside anything already open.
   *
   * Fragments draws it and answers picks (see _probe). Its full geometry never
   * sits in this page: a large model's triangles run to tens of millions, which
   * Fragments only gets away with by instancing and level of detail. Instead
   * the geometry is streamed through once here and summarised per element: a
   * bounding box and a ground-plane convex hull. Those answer everything that
   * reads geometry rather than drawing it — framing, hulls, ground level, floor
   * sampling, model centres — exactly (a hull of the elements' hulls is the hull
   * of their vertices). Measuring fetches one element's triangles on demand.
   *
   * @param {Uint8Array} frag   the .frag bytes (Fragments takes the buffer over)
   * @param {{ name: string, file?: File|null, bytes?: number }} info
   *   `file` is the source IFC when there is one (editing needs it)
   * @param {(pct: number) => void} [onProgress]
   */
  async loadFragments(frag, { name, file = null, bytes = 0 }, onProgress = () => {}) {
    const fm = await this._fragmentsModels();
    const modelID = FRAG_ID_BASE + (++this._fragSeq);
    const fragSize = frag.byteLength;

    const t0 = performance.now();
    const model = await fm.load(frag, { modelId: `frag-${modelID}`, camera: this.activeCamera });
    await this._placeFragments(model);
    model.object.updateMatrixWorld(true);
    // Picks must not land on what a section or plan cut is hiding.
    model.getClippingPlanesEvent = () => this.renderer.clippingPlanes || [];
    this.scene.add(model.object);
    const openMs = performance.now() - t0;
    onProgress(20);

    const t1 = performance.now();
    const summary = await this._summarise(model, (p) => onProgress(20 + p * 0.8));
    const summaryMs = performance.now() - t1;

    const entry = {
      modelID,
      kind: 'frag',
      name,
      bytes: bytes || (file && file.size) || 0,
      file,
      fragModel: model,
      fragSize,
      mesh: null,
      geometryIds: summary.ids,
      boxes: summary.boxes,
      hulls: summary.hulls,
      minY: summary.minY,
      baseMaterials: [],
      ghostMaterials: [],
      visible: true,
      // Nothing of the IFC is open in this page to release.
      released: true,
      timings: { openMs, summaryMs, triangles: summary.triangles },
    };
    this.models.set(modelID, entry);
    this.refresh();
    await this._fragSync;
    return entry;
  }

  /**
   * Puts a Fragments model where an IFC loaded here would be. Fragments keeps
   * the model's own coordination matrix (raw IFC, Y up -> its scene); this
   * viewer's datum is `coordinationMatrix`, so the model is moved by
   * datum · own⁻¹. The first model of a session establishes the datum.
   */
  async _placeFragments(model) {
    let own = null;
    try { own = await model.getCoordinationMatrix(); } catch { own = null; }
    if (!own) return;
    if (!this.coordinationMatrix) {
      this.coordinationMatrix = own.clone();
      return;
    }
    const m = this.coordinationMatrix.clone().multiply(own.clone().invert());
    model.object.matrixAutoUpdate = false;
    model.object.matrix.copy(m);
    model.object.matrixWorldNeedsUpdate = true;
  }

  /**
   * Calls `cb(id, mesh, matrix)` for every mesh of the given elements, with
   * the matrix that takes its positions to scene coordinates.
   */
  async _eachFragMesh(model, ids, cb, onChunk = () => {}) {
    const world = model.object.matrixWorld;
    const m = new THREE.Matrix4();
    for (let c = 0; c < ids.length; c += FRAG_GEOMETRY_CHUNK) {
      const chunk = ids.slice(c, c + FRAG_GEOMETRY_CHUNK);
      const geoms = await model.getItemsGeometry(chunk);
      chunk.forEach((id, k) => {
        for (const mesh of geoms[k] || []) {
          if (!mesh.positions || !mesh.indices || !mesh.indices.length) continue;
          m.copy(mesh.transform || new THREE.Matrix4()).premultiply(world);
          cb(id, mesh, m);
        }
      });
      onChunk(Math.min(1, (c + chunk.length) / ids.length));
    }
  }

  /**
   * Per element of a Fragments model, in scene coordinates: its bounding box
   * ([minX, minY, minZ, maxX, maxY, maxZ], as elementBoxes) and the convex hull
   * of its vertices on the ground plane (flat [x, z, …]). See loadFragments.
   */
  async _summarise(model, onProgress) {
    const ids = await model.getItemsIdsWithGeometry();
    const boxes = new Map();
    const hulls = new Map();
    const v = new THREE.Vector3();
    let triangles = 0;
    let minY = Infinity;
    let current = null; // { id, b, pts }
    const flush = () => {
      if (!current) return;
      boxes.set(current.id, current.b);
      const hull = convexHull(current.pts);
      hulls.set(current.id, Float32Array.from(hull.flat()));
      if (current.b[1] < minY) minY = current.b[1];
      current = null;
    };
    await this._eachFragMesh(model, ids, (id, mesh, m) => {
      if (!current || current.id !== id) {
        flush();
        current = { id, b: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], pts: [] };
      }
      const { b, pts } = current;
      const p = mesh.positions;
      for (let i = 0, n = p.length / 3; i < n; i++) {
        v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]).applyMatrix4(m);
        if (v.x < b[0]) b[0] = v.x; if (v.y < b[1]) b[1] = v.y; if (v.z < b[2]) b[2] = v.z;
        if (v.x > b[3]) b[3] = v.x; if (v.y > b[4]) b[4] = v.y; if (v.z > b[5]) b[5] = v.z;
        pts.push([v.x, v.z]);
      }
      // Keep the point list short on heavy elements: the hull so far plus
      // whatever comes next is enough to finish the hull exactly.
      if (pts.length > 4096) current.pts = convexHull(pts);
      triangles += mesh.indices.length / 3;
    }, (f) => onProgress(f * 100));
    flush();
    return { ids: [...boxes.keys()], boxes, hulls, minY: Number.isFinite(minY) ? minY : 0, triangles };
  }

  /**
   * An element's triangles in scene coordinates (as elementTriangles), read
   * from Fragments and kept in a small cache, since measuring asks for the
   * element under the pointer on every move.
   */
  async _fetchFragTriangles(entry, expressID) {
    const key = `${entry.modelID}:${expressID}`;
    if (this._fragTris.has(key)) return this._fragTris.get(key);
    const parts = [];
    const v = new THREE.Vector3();
    await this._eachFragMesh(entry.fragModel, [expressID], (id, mesh, m) => {
      const p = mesh.positions;
      const ix = mesh.indices;
      const out = new Float32Array(ix.length * 3);
      for (let i = 0; i < ix.length; i++) {
        v.set(p[ix[i] * 3], p[ix[i] * 3 + 1], p[ix[i] * 3 + 2]).applyMatrix4(m);
        out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
      }
      parts.push(out);
    });
    const total = parts.reduce((n, a) => n + a.length, 0);
    const tris = total ? new Float32Array(total) : null;
    let o = 0;
    for (const a of parts) { tris.set(a, o); o += a.length; }
    this._fragTris.set(key, tris);
    while (this._fragTris.size > 64) this._fragTris.delete(this._fragTris.keys().next().value);
    return tris;
  }

  _hasFragments() {
    for (const e of this.models.values()) if (e.kind === 'frag') return true;
    return false;
  }

  /** The nearest Fragments element under a screen point, across the visible large models. */
  async _fragRaycast(x, y) {
    const mouse = new THREE.Vector2(x, y);
    const dom = this.renderer.domElement;
    let best = null;
    for (const e of this.models.values()) {
      if (e.kind !== 'frag' || !e.visible) continue;
      const hit = await e.fragModel.raycast({ camera: this.activeCamera, mouse, dom });
      if (hit && (!best || hit.distance < best.distance)) {
        best = { modelID: e.modelID, expressID: hit.localId, point: hit.point, normal: hit.normal || null, distance: hit.distance };
      }
    }
    return best;
  }

  /**
   * Raycasts the large models under the pointer in the background and keeps
   * the latest answer, for the synchronous callers (pickElement, raycastFace,
   * elementTriangles): measuring and the section preview ask on every pointer
   * move and get an answer at most a frame old. One raycast runs at a time;
   * moves made meanwhile collapse into the newest. Resolves with the probe.
   */
  _probe(event) {
    this._probeWanted = { x: event.clientX, y: event.clientY };
    if (!this._probeRun) {
      this._probeRun = (async () => {
        try {
          while (this._probeWanted) {
            const { x, y } = this._probeWanted;
            this._probeWanted = null;
            const cam = this._cameraVersion;
            const hit = await this._fragRaycast(x, y);
            this._probeHit = { x, y, cam, hit };
            if (hit) {
              const entry = this.models.get(hit.modelID);
              if (entry) this._fetchFragTriangles(entry, hit.expressID).catch(() => {});
            }
          }
        } catch (err) {
          console.warn('Could not raycast a large model', err);
        } finally {
          this._probeRun = null;
        }
        return this._probeHit;
      })();
    }
    return this._probeRun;
  }

  /** The background raycast's answer for this pointer position, if it is current. */
  _probeAt(event) {
    const p = this._probeHit;
    if (!p || p.cam !== this._cameraVersion) return null;
    if (Math.abs(p.x - event.clientX) > 3 || Math.abs(p.y - event.clientY) > 3) return null;
    return p.hit;
  }

  /** A pick for a click: waits for the large models to answer at exactly this point. */
  async _pickAtAsync(event) {
    if (this._hasFragments()) {
      this._probe(event);
      while (this._probeRun) await this._probeRun;
    }
    return this._pickAt(event);
  }

  /**
   * Brings every Fragments model in line with the hidden set, the query
   * groups, the context mode and the selection. Fragments applies each change
   * in its worker, so this runs asynchronously; calls made while it runs fold
   * into one more pass.
   */
  _syncFragments() {
    if (!this.fragments) return Promise.resolve();
    this._fragDirty = true;
    if (!this._fragSync) {
      this._fragSync = (async () => {
        try {
          while (this._fragDirty) {
            this._fragDirty = false;
            await this._applyFragments();
          }
        } catch (err) {
          console.warn('Could not update a large model', err);
        } finally {
          this._fragSync = null;
        }
      })();
    }
    return this._fragSync;
  }

  /** What one Fragments model should show: { hidden, groups: [{ids, colour}], contextHidden }. */
  _fragState(entry) {
    const hidden = this.hiddenByModel.get(entry.modelID);
    const grouped = new Set();
    const groups = this.groups.map((g) => {
      const ids = [];
      for (const el of g.elements) {
        if (el.modelID !== entry.modelID || this.isHidden(el)) continue;
        for (const id of this._geometryIds(el)) {
          if (hidden && hidden.has(id)) continue;
          ids.push(id);
          grouped.add(id);
        }
      }
      return { ids, colour: g.colour };
    });
    const contextHidden = this.groups.length && this.contextMode === 'hidden'
      ? entry.geometryIds.filter((id) => !grouped.has(id)) : [];
    return { hidden, groups, contextHidden };
  }

  /**
   * Applies only what changed since the last pass, per model: recolouring
   * every element (ghosting the context) costs about half a second on 100,000
   * elements, so a new selection or a hide must not redo it.
   *  - query groups or context mode changed: everything again;
   *  - the hidden set changed: visibility only;
   *  - otherwise: the previous selection is put back as it was, the new one lit.
   */
  async _applyFragments() {
    const FRAGS = this._FRAGS;
    const faces = FRAGS.RenderedFaces.TWO;
    const solid = (hex) => ({ color: new THREE.Color(hex), renderedFaces: faces, opacity: 1, transparent: false });
    const ghost = { color: new THREE.Color(0xb8c0cc), renderedFaces: faces, opacity: 0.07, transparent: true };
    for (const entry of this.models.values()) {
      if (entry.kind !== 'frag') continue;
      const model = entry.fragModel;
      model.object.visible = entry.visible;
      if (!entry.visible) {
        entry.fragApplied = null; // a hidden model is not kept up to date
        continue;
      }

      const { hidden, groups, contextHidden } = this._fragState(entry);
      const applied = entry.fragApplied;
      const look = applied && applied.groups === this.groups && applied.mode === this.contextMode;

      if (!look || applied.hidden !== this.hiddenVersion) {
        await model.resetVisible();
        if (hidden && hidden.size) await model.setVisible([...hidden], false);
        if (contextHidden.length) await model.setVisible(contextHidden, false);
      }

      const colourOf = new Map();
      for (const { ids, colour } of groups) for (const id of ids) colourOf.set(id, colour);
      if (!look) {
        await model.resetHighlight();
        if (groups.length && this.contextMode === 'ghost') await model.highlight(undefined, ghost);
        for (const { ids, colour } of groups) if (ids.length) await model.highlight(ids, solid(colour));
      } else if (applied.sel.length) {
        // Put the previous selection back to its group colour, the ghost, or plain.
        const plain = [];
        const ghosted = [];
        const byColour = new Map();
        for (const id of applied.sel) {
          if (colourOf.has(id)) {
            const c = colourOf.get(id);
            if (!byColour.has(c)) byColour.set(c, []);
            byColour.get(c).push(id);
          } else if (groups.length && this.contextMode === 'ghost') ghosted.push(id);
          else plain.push(id);
        }
        if (plain.length) await model.resetHighlight(plain);
        if (ghosted.length) await model.highlight(ghosted, ghost);
        for (const [c, ids] of byColour) await model.highlight(ids, solid(c));
      }

      const sel = this.selection;
      const selIds = sel && sel.modelID === entry.modelID
        ? this._geometryIds(sel).filter((id) => !hidden || !hidden.has(id)) : [];
      if (selIds.length) await model.highlight(selIds, solid(SELECTION_COLOUR));

      entry.fragApplied = { groups: this.groups, mode: this.contextMode, hidden: this.hiddenVersion, sel: selIds };
    }
    await this.fragments.update(true);
  }

  /** Points Fragments' level-of-detail and culling at whichever camera is active. */
  _fragCamera() {
    for (const e of this.models.values()) if (e.kind === 'frag') e.fragModel.useCamera(this.activeCamera);
    if (this.fragments) this.fragments.update(true);
  }

  /**
   * Frees the parsed IFC held in the wasm heap, keeping the rendered mesh.
   *
   * Call once the property index has been built. Everything the viewer does
   * afterwards — colour subsets, picking, hiding — runs off the three.js
   * geometry and the index map, so nothing reads the wasm model again. On a
   * 71 MB file this returns ~126 MB per model, which is what makes loading
   * several files at once affordable.
   *
   * The trade-off: any *new* property read (getItemProperties and friends) is
   * no longer possible for this model. Everything the mapping needs is already
   * captured in the index by then.
   */
  releaseModelData(modelID) {
    const entry = this.models.get(modelID);
    if (!entry || entry.released) return;
    try {
      this.api.CloseModel(modelID);
      entry.released = true;
    } catch {
      /* already closed, or the model never opened cleanly */
    }
  }

  removeModel(modelID) {
    const entry = this.models.get(modelID);
    if (!entry) return;
    this._clearOverlays();
    if (this.selection && this.selection.modelID === modelID) this.selection = null;
    this._clearSelectionMesh();
    this.models.delete(modelID);
    this.hiddenByModel.delete(modelID);

    if (entry.kind === 'frag') {
      this.scene.remove(entry.fragModel.object);
      this.fragments.disposeModel(entry.fragModel.modelId).catch(() => {});
      for (const key of [...this._fragTris.keys()]) if (key.startsWith(modelID + ':')) this._fragTris.delete(key);
      this._probeHit = null;
    } else if (entry.released) {
      // ifcManager.close would call CloseModel a second time; that throws, and
      // its catch-all would then skip disposing the mesh. Tear down directly.
      this.scene.remove(entry.mesh);
      entry.mesh.geometry?.dispose();
      entry.baseMaterials.forEach((m) => m.dispose());
      delete this.loader.ifcManager.state.models[modelID];
    } else {
      try {
        this.loader.ifcManager.close(modelID, this.scene);
      } catch {
        this.scene.remove(entry.mesh);
      }
    }

    // close() does not touch this, and it holds a full copy of the index buffer
    // (~147 MB on a large model), so drop it explicitly.
    if (entry.kind !== 'frag') delete this.loader.ifcManager.subsets.items.map[modelID];

    entry.ghostMaterials.forEach((m) => m.dispose());
    // Keep the datum while anything is still open so the remaining models do not
    // move; drop it once the scene is empty, so an unrelated project loaded next
    // establishes its own origin instead of inheriting this one.
    if (!this.models.size) this.coordinationMatrix = null;
    this.refresh();
  }

  setModelVisible(modelID, on) {
    const entry = this.models.get(modelID);
    if (!entry) return;
    entry.visible = on;
    this.refresh();
  }

  /** The raw web-ifc API, for the property index. */
  get api() {
    return this.loader.ifcManager.state.api;
  }

  // ------------------------------------------------------------------ memory

  /**
   * Bytes held in vertex and index buffers across every loaded model, its
   * overlay subsets, and web-ifc-three's per-model index caches.
   *
   * Subsets share the base mesh's position, normal and expressID attributes by
   * reference and only own their index, so attributes are counted once each.
   */
  geometryBytes() {
    const seen = new Set();
    let bytes = 0;
    const count = (attr) => {
      if (!attr || !attr.array || seen.has(attr)) return;
      seen.add(attr);
      bytes += attr.array.byteLength;
    };
    const countGeometry = (geometry) => {
      if (!geometry) return;
      for (const attr of Object.values(geometry.attributes)) count(attr);
      count(geometry.index);
    };

    for (const entry of this.models.values()) {
      // A large model's geometry lives in Fragments' worker; this page holds
      // only its per-element summaries (see loadFragments).
      if (entry.kind === 'frag') {
        for (const h of entry.hulls.values()) bytes += h.byteLength;
        bytes += entry.boxes.size * 6 * 8;
        continue;
      }
      countGeometry(entry.mesh.geometry);
    }
    for (const o of this.overlays) if (o.mesh) countGeometry(o.mesh.geometry);

    // The pristine index copy kept for hiding and subsets, per model.
    const maps = this.loader.ifcManager.subsets.items.map || {};
    for (const m of Object.values(maps)) {
      if (m && m.indexCache) bytes += m.indexCache.byteLength;
    }
    return bytes;
  }

  /**
   * Size of the web-ifc wasm heap. It grows to fit the largest file parsed and
   * is never returned to the browser, so this is a floor for the session.
   */
  wasmHeapBytes() {
    try {
      const mod = this.api && this.api.wasmModule;
      const heap = mod && (mod.HEAPU8 || mod.HEAP8);
      return heap ? heap.byteLength : 0;
    } catch {
      return 0;
    }
  }

  /** The web-ifc model handle backing a loaded mesh, found by identity. */
  _resolveModelID(mesh) {
    const models = this.loader.ifcManager.state.models;
    for (const k of Object.keys(models)) {
      if (models[k] && models[k].mesh === mesh) return Number(k);
    }
    return mesh.modelID;
  }

  /** `{ indexCache, map }` for a model: index ranges per expressID per material. */
  _itemsMap(modelID) {
    const entry = this.models.get(modelID);
    if (entry && entry.kind === 'frag') return null;
    const items = this.loader.ifcManager.subsets.items;
    items.generateGeometryIndexMap(modelID);
    return items.map[modelID];
  }

  /**
   * The expressIDs that draw an element: itself, plus the aggregated parts the
   * index resolved for a geometry-less container (a Revit stair's flights,
   * landings and railings). Every per-element operation on the mesh goes
   * through this, so a stair colours, hides and measures like any other element.
   */
  _geometryIds(el) {
    return el.parts && el.parts.length ? [el.expressID, ...el.parts] : [el.expressID];
  }

  // ------------------------------------------------------------- visibility

  hiddenSet(modelID) {
    let s = this.hiddenByModel.get(modelID);
    if (!s) {
      s = new Set();
      this.hiddenByModel.set(modelID, s);
    }
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

  /**
   * Replaces the hidden set wholesale. The app decides *what* is hidden (manual
   * hides, the space toggle); the viewer only knows how to not draw it.
   * @param {Iterable<{modelID:number, expressID:number}>} elements
   */
  setHidden(elements) {
    this.hiddenByModel.clear();
    for (const el of elements) {
      const set = this.hiddenSet(el.modelID);
      for (const id of this._geometryIds(el)) set.add(id);
    }
    this.hiddenVersion++;
    this.refresh();
  }

  showAll() {
    this.hiddenByModel.clear();
    this.hiddenVersion++;
    for (const entry of this.models.values()) entry.visible = true;
    this.refresh();
  }

  /**
   * Rewrites one model's index buffer so hidden elements draw nothing.
   * Restores from the pristine cache first, so this is also how elements
   * come back into view.
   */
  _applyHidden(entry) {
    // Rewriting the index means copying the whole buffer, so only do it when the
    // hidden set has actually moved since this model last had it applied.
    if (entry.appliedHiddenVersion === this.hiddenVersion) return;

    const hidden = this.hiddenByModel.get(entry.modelID);
    const nothingHidden = !hidden || hidden.size === 0;

    // Building the index map allocates a full duplicate of the index buffer
    // (~150 MB on a large model), so don't force it until this model actually
    // has something hidden. Once it does, the map stays and restores are cheap.
    if (nothingHidden && !entry.everHidden) return;

    entry.appliedHiddenVersion = this.hiddenVersion;
    if (!nothingHidden) entry.everHidden = true;

    const items = this._itemsMap(entry.modelID);
    if (!items) return;
    const index = entry.mesh.geometry.index;
    if (!index) return;

    index.array.set(items.indexCache);

    if (!nothingHidden) {
      const arr = index.array;
      for (const expressID of hidden) {
        const byMaterial = items.map.get(expressID);
        if (!byMaterial) continue;
        for (const ranges of Object.values(byMaterial)) {
          for (let p = 0; p < ranges.length; p += 2) {
            const start = ranges[p];
            const end = ranges[p + 1];
            // Collapse every triangle in the range onto a single vertex.
            const collapseTo = arr[start];
            for (let j = start; j <= end; j++) arr[j] = collapseTo;
          }
        }
      }
    }
    index.needsUpdate = true;
  }

  // --------------------------------------------------------------- overlays

  /** @param {Array<{elements: Array, colour: number}>} groups */
  setGroups(groups) {
    this.groups = groups || [];
    this.refresh();
  }

  /** Sets the overlay and the context mode together, in a single rebuild. */
  setQuery(groups, contextMode) {
    this.groups = groups || [];
    if (contextMode) this.contextMode = contextMode;
    this.refresh();
  }

  clearGroups() {
    this.groups = [];
    this.refresh();
  }

  setContextMode(mode) {
    this.contextMode = mode;
    this.refresh();
  }

  _clearOverlays() {
    for (const { modelID, material, customID } of this.overlays) {
      try {
        this.loader.ifcManager.removeSubset(modelID, material, customID);
      } catch { /* already gone */ }
      material.dispose();
    }
    this.overlays = [];
  }

  /**
   * Reconciles the scene with the current models, hidden set and query groups.
   * Cheap enough to call on every interaction.
   */
  refresh() {
    this._boxCache = null;
    this._clearOverlays();

    const hasQuery = this.groups.length > 0;

    for (const entry of this.models.values()) {
      // Fragments draws these itself; see _syncFragments, below.
      if (entry.kind === 'frag') continue;

      this._applyHidden(entry);

      if (!entry.visible) {
        entry.mesh.visible = false;
        continue;
      }

      // Colour overlays, one subset per group per model, skipping hidden members.
      const hidden = this.hiddenByModel.get(entry.modelID);
      this.groups.forEach((g, gi) => {
        const ids = [];
        for (const el of g.elements) {
          if (el.modelID !== entry.modelID) continue;
          if (this.isHidden(el)) continue;
          // A part the user hid on its own stays hidden under its host's colour.
          for (const id of this._geometryIds(el)) {
            if (!hidden || !hidden.has(id)) ids.push(id);
          }
        }
        if (!ids.length) return;

        const material = new THREE.MeshLambertMaterial({
          color: new THREE.Color(g.colour),
          side: THREE.DoubleSide,
        });
        const customID = `ifcsg-${gi}`;
        const mesh = this.loader.ifcManager.createSubset({
          modelID: entry.modelID,
          ids,
          material,
          scene: this.scene,
          removePrevious: true,
          customID,
        });
        this.overlays.push({ modelID: entry.modelID, material, customID, mesh });
      });

      // The base mesh is the context behind the overlay. Overlay subsets are
      // parented to the scene, so hiding the base mesh does not hide them.
      if (!hasQuery) {
        entry.mesh.visible = true;
        entry.mesh.material = entry.baseMaterials;
      } else if (this.contextMode === 'ghost') {
        entry.mesh.visible = true;
        entry.mesh.material = entry.ghostMaterials;
      } else if (this.contextMode === 'normal') {
        entry.mesh.visible = true;
        entry.mesh.material = entry.baseMaterials;
      } else {
        entry.mesh.visible = false;
      }
    }

    this._drawSelection();
  }

  // -------------------------------------------------------------- selection

  /**
   * Highlights one element and, unless told otherwise, glides the orbit pivot
   * onto its centre so the next drag turns around it, as in Forma. The camera
   * stays put; only where it looks moves. Pass null to clear the highlight —
   * the pivot is left where it is.
   *
   * @param {{modelID:number, expressID:number, parts?:number[]}|null} el
   * @param {{pivot?: boolean}} [opts]
   */
  setSelection(el, { pivot = true } = {}) {
    this.selection = el && this.models.has(el.modelID)
      ? { modelID: el.modelID, expressID: el.expressID, parts: el.parts }
      : null;
    this._drawSelection();
    if (this.selection && pivot) this._pivotTo(this.selection);
  }

  clearSelection() {
    this.setSelection(null);
  }

  _clearSelectionMesh() {
    if (!this.selectionMesh) return;
    try {
      this.loader.ifcManager.removeSubset(this.selectionMesh.modelID, this.selectionMaterial, SELECTION_ID);
    } catch { /* already gone with its model */ }
    this.selectionMesh = null;
  }

  /** Rebuilds the highlight subset, skipping anything the user has hidden. */
  _drawSelection() {
    this._clearSelectionMesh();
    // Fragments models draw their highlight themselves, with everything else.
    this._syncFragments();
    const sel = this.selection;
    if (!sel) return;
    const entry = this.models.get(sel.modelID);
    if (!entry || !entry.visible || entry.kind === 'frag') return;

    const hidden = this.hiddenByModel.get(sel.modelID);
    const ids = this._geometryIds(sel).filter((id) => !hidden || !hidden.has(id));
    if (!ids.length) return;

    const mesh = this.loader.ifcManager.createSubset({
      modelID: sel.modelID,
      ids,
      material: this.selectionMaterial,
      scene: this.scene,
      removePrevious: true,
      customID: SELECTION_ID,
    });
    if (mesh) {
      mesh.modelID = sel.modelID;
      this.selectionMesh = mesh;
    }
  }

  /** Bounding box of a set of elements, through their parts where they have them. */
  _elementsBox(elements) {
    const box = new THREE.Box3();
    for (const el of elements || []) {
      for (const p of this.elementPoints(el.modelID, el.expressID, 4000)) box.expandByPoint(p);
      for (const id of el.parts || []) {
        for (const p of this.elementPoints(el.modelID, id, 2000)) box.expandByPoint(p);
      }
    }
    return box;
  }

  _pivotTo(el) {
    // Plan view has no orbit to pivot, and moving its target would pan the plan.
    if (this.activeCamera !== this.camera) return;
    const box = this._elementsBox([el]);
    if (box.isEmpty()) return;
    const to = box.getCenter(new THREE.Vector3());
    // OrbitControls cannot look at a point it is standing on.
    if (to.distanceToSquared(this.camera.position) < 1e-4) return;
    this._pivotAnim = { from: this.controls.target.clone(), to, t0: performance.now() };
  }

  _stepPivot() {
    const a = this._pivotAnim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.t0) / PIVOT_MS);
    const k = 1 - Math.pow(1 - t, 3); // ease out
    this.controls.target.lerpVectors(a.from, a.to, k);
    if (t >= 1) this._pivotAnim = null;
  }

  // ------------------------------------------------------- geometry sampling

  /**
   * Scene-space vertices belonging to one element.
   *
   * Reads the same per-element index ranges the hiding uses, so it works after
   * the parsed IFC has been released — there is no other way to get an
   * element's geometry once the wasm model is closed.
   *
   * @returns {THREE.Vector3[]} deduplicated, capped at `limit`
   */
  elementPoints(modelID, expressID, limit = 20000) {
    const entry = this.models.get(modelID);
    if (!entry) return [];
    if (entry.kind === 'frag') {
      // The corners of its box: every caller wants extents, not the surface.
      const b = entry.boxes.get(expressID);
      if (!b) return [];
      const out = [];
      for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) out.push(new THREE.Vector3(x, y, z));
      return out;
    }
    const items = this._itemsMap(modelID);
    const byMaterial = items && items.map.get(expressID);
    if (!byMaterial) return [];

    const position = entry.mesh.geometry.attributes.position;
    const cache = items.indexCache;
    const seen = new Set();
    const points = [];

    for (const ranges of Object.values(byMaterial)) {
      for (let p = 0; p < ranges.length; p += 2) {
        for (let j = ranges[p]; j <= ranges[p + 1] && points.length < limit; j++) {
          const vi = cache[j];
          if (seen.has(vi)) continue;
          seen.add(vi);
          points.push(new THREE.Vector3(
            position.getX(vi), position.getY(vi), position.getZ(vi)));
        }
      }
    }
    return points;
  }

  /**
   * An element's triangles in scene coordinates, three vertices per triangle,
   * read through the pristine index so hiding other elements does not matter.
   * Null when the element draws nothing or has more than `maxTriangles`.
   * @returns {Float32Array|null}
   */
  elementTriangles(modelID, expressID, maxTriangles = Infinity) {
    const entry = this.models.get(modelID);
    if (!entry) return null;
    if (entry.kind === 'frag') {
      // Fetched from Fragments in the background (the pointer probe asks for
      // the element it lands on), so the first ask may come back empty.
      const key = `${modelID}:${expressID}`;
      if (!this._fragTris.has(key)) {
        this._fetchFragTriangles(entry, expressID).catch(() => {});
        return null;
      }
      const tris = this._fragTris.get(key);
      return tris && tris.length / 9 <= maxTriangles ? tris : null;
    }
    const items = this._itemsMap(modelID);
    const byMaterial = items && items.map.get(expressID);
    if (!byMaterial) return null;

    let count = 0;
    for (const ranges of Object.values(byMaterial)) {
      for (let p = 0; p < ranges.length; p += 2) count += ranges[p + 1] - ranges[p] + 1;
    }
    if (!count || count / 3 > maxTriangles) return null;

    const pos = entry.mesh.geometry.attributes.position;
    const cache = items.indexCache;
    const m = entry.mesh.matrixWorld;
    const v = new THREE.Vector3();
    const out = new Float32Array(count * 3);
    let o = 0;
    for (const ranges of Object.values(byMaterial)) {
      for (let p = 0; p < ranges.length; p += 2) {
        for (let j = ranges[p]; j <= ranges[p + 1]; j++) {
          v.fromBufferAttribute(pos, cache[j]).applyMatrix4(m);
          out[o++] = v.x; out[o++] = v.y; out[o++] = v.z;
        }
      }
    }
    return out;
  }

  /**
   * Which element is under the pointer, read from the GPU rather than by
   * raycasting. The raycaster tests every triangle of the model on the CPU,
   * which is far too slow to run as the pointer moves over a large file. This
   * draws one pixel instead, every visible mesh coloured by its expressID, and
   * reads that pixel back. Hidden elements (collapsed triangles) and anything
   * a section or plan cut discards draw nothing, so they are skipped as they
   * are on screen.
   * @returns {{modelID: number, expressID: number}|null}
   */
  pickElement(event) {
    if (!this.hasModels) return null;
    const ifcHit = this._pickIfc(event);
    // Large models answer from the background probe (see _probe).
    const frag = this._hasFragments() ? this._probeAt(event) : null;
    if (!frag) return ifcHit;
    const fragHit = { modelID: frag.modelID, expressID: frag.expressID };
    if (!ifcHit) return fragHit;
    // Both engines have something under the pointer: the nearer one is in front.
    const d = this._rayDistanceTo(event, ifcHit);
    return d != null && d < frag.distance ? ifcHit : fragHit;
  }

  /** How far along the pointer ray an element's nearest triangle is, or null. */
  _rayDistanceTo(event, el) {
    const tris = this.elementTriangles(el.modelID, el.expressID);
    if (!tris) return null;
    const ray = this._pointerRay(event).ray;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
    let best = Infinity;
    for (let i = 0; i < tris.length; i += 9) {
      a.fromArray(tris, i); b.fromArray(tris, i + 3); c.fromArray(tris, i + 6);
      if (ray.intersectTriangle(a, b, c, false, p)) best = Math.min(best, ray.origin.distanceTo(p));
    }
    return Number.isFinite(best) ? best : null;
  }

  /** pickElement for the web-ifc-three meshes only. */
  _pickIfc(event) {
    if (![...this.models.values()].some((e) => e.mesh)) return null;
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;

    if (!this._pickTarget) {
      this._pickTarget = new THREE.WebGLRenderTarget(1, 1);
      this._pickPixel = new Uint8Array(4);
      this._pickMaterials = [];
    }
    // Model handles are not small numbers, so each draw is tagged with its
    // position in this list (in the alpha channel) instead.
    const models = [];
    const meshes = [];
    const add = (mesh, modelID) => {
      if (!mesh || !mesh.visible || modelID == null) return;
      let i = models.indexOf(modelID);
      if (i < 0) i = models.push(modelID) - 1;
      if (i < 255) meshes.push({ mesh, i });
    };
    for (const entry of this.models.values()) if (entry.visible && entry.mesh) add(entry.mesh, entry.modelID);
    // Overlays and the highlight draw the same triangles as the base mesh, but
    // can be all that is drawn while context is hidden.
    for (const o of this.overlays) add(o.mesh, o.modelID);
    if (this.selectionMesh) add(this.selectionMesh, this.selectionMesh.modelID);
    if (!meshes.length) return null;

    const r = this.renderer;
    const camera = this.activeCamera;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;

    // Centred on the pointer, so the pixel read is the one the ray goes through.
    camera.setViewOffset(rect.width, rect.height, x - 0.5, y - 0.5, 1, 1);
    r.setRenderTarget(this._pickTarget);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.autoClear = false;
    for (const { mesh, i } of meshes) {
      const saved = mesh.material;
      mesh.material = this._pickMaterial(i);
      try {
        r.render(mesh, camera);
      } finally {
        mesh.material = saved;
      }
    }
    r.readRenderTargetPixels(this._pickTarget, 0, 0, 1, 1, this._pickPixel);
    r.autoClear = prevAuto;
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    camera.clearViewOffset();

    const [cr, cg, cb, ca] = this._pickPixel;
    if (!ca) return null;
    return { modelID: models[ca - 1], expressID: cr + cg * 256 + cb * 65536 };
  }

  /** The flat-colour material `pickElement` draws model `i` with. */
  _pickMaterial(i) {
    if (this._pickMaterials[i]) return this._pickMaterials[i];
    const m = new THREE.ShaderMaterial({
      uniforms: { modelTag: { value: (i + 1) / 255 } },
      // web-ifc-three stores expressIDs as a Uint32 attribute, which three
      // binds as an integer attribute: it must be declared uint here. The
      // colour is worked out per vertex with integer maths, so all 24 bits
      // survive (a float varying would round ids above 2^24).
      vertexShader: `
        in uint expressID;
        out vec3 vId;
        #include <clipping_planes_pars_vertex>
        void main() {
          vId = vec3(float(expressID & 255u), float((expressID >> 8) & 255u), float((expressID >> 16) & 255u)) / 255.0;
          #include <begin_vertex>
          #include <project_vertex>
          #include <clipping_planes_vertex>
        }`,
      fragmentShader: `
        uniform float modelTag;
        in vec3 vId;
        #include <clipping_planes_pars_fragment>
        void main() {
          #include <clipping_planes_fragment>
          gl_FragColor = vec4(vId, modelTag);
        }`,
      side: THREE.DoubleSide,
      clipping: true,
      blending: THREE.NoBlending,
    });
    this._pickMaterials[i] = m;
    return m;
  }

  /** Registers a callback run every frame after the controls update, before rendering. */
  onFrame(cb) { this.frameListeners.push(cb); }

  /**
   * Ground-plane convex hull over every vertex a callback yields, as `[[x, z], …]`
   * in scene coordinates.
   *
   * **Exact, not sampled.** An earlier version sampled every fourteenth vertex,
   * which is fine for drawing and wrong for a containment test: the hull of a
   * sample is contained by the true hull, so a corner poking over a boundary can
   * be missed entirely. A check that quietly under-reports is worse than none.
   *
   * Exactness is affordable because of the prefilter. One pass finds the extreme
   * point in eight directions; those eight are genuine hull vertices, so the
   * octagon they span lies inside the true hull and every point within it is
   * provably not a hull vertex. A second pass discards those — on building
   * geometry, virtually all of them — and only the survivors are sorted.
   */
  _groundHull(iterate) {
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const best = DIRS.map(() => ({ score: -Infinity, point: null }));

    iterate((x, z) => {
      for (let i = 0; i < 8; i++) {
        const score = DIRS[i][0] * x + DIRS[i][1] * z;
        if (score > best[i].score) {
          best[i].score = score;
          best[i].point = [x, z];
        }
      }
    });

    const extremes = best.map((b) => b.point).filter(Boolean);
    if (extremes.length < 3) return extremes;

    const octagon = convexHull(extremes);
    const candidates = extremes.slice();

    if (octagon.length >= 3) {
      // Strictly-inside test against a counter-clockwise convex polygon.
      const inside = (x, z) => {
        for (let i = 0, n = octagon.length; i < n; i++) {
          const [ax, az] = octagon[i];
          const [bx, bz] = octagon[(i + 1) % n];
          if ((bx - ax) * (z - az) - (bz - az) * (x - ax) < 0) return false;
        }
        return true;
      };
      iterate((x, z) => { if (!inside(x, z)) candidates.push([x, z]); });
    } else {
      iterate((x, z) => candidates.push([x, z]));
    }

    return convexHull(candidates);
  }

  /** Ground-plane hull of every visible model, in scene coordinates. */
  modelHull() {
    const meshes = [];
    const hulls = [];
    for (const entry of this.models.values()) {
      if (!entry.visible) continue;
      if (entry.kind === 'frag') hulls.push(...entry.hulls.values());
      else meshes.push(entry.mesh.geometry.attributes.position);
    }
    if (!meshes.length && !hulls.length) return [];

    return this._groundHull((cb) => {
      for (const position of meshes) {
        const arr = position.array;
        for (let i = 0, n = position.count; i < n; i++) cb(arr[i * 3], arr[i * 3 + 2]);
      }
      // A large model's per-element hulls: their hull is the hull of its vertices.
      for (const h of hulls) for (let i = 0; i < h.length; i += 2) cb(h[i], h[i + 1]);
    });
  }

  /** Ground-plane hull of specific elements, in scene coordinates. */
  elementHull(elements) {
    const perModel = new Map();
    for (const el of elements || []) {
      if (!perModel.has(el.modelID)) perModel.set(el.modelID, []);
      perModel.get(el.modelID).push(...this._geometryIds(el));
    }

    const sources = [];
    const hulls = [];
    for (const [modelID, ids] of perModel) {
      const entry = this.models.get(modelID);
      if (!entry) continue;
      if (entry.kind === 'frag') {
        for (const id of ids) if (entry.hulls.has(id)) hulls.push(entry.hulls.get(id));
        continue;
      }
      const items = this._itemsMap(modelID);
      if (!items) continue;
      sources.push({ position: entry.mesh.geometry.attributes.position, items, ids });
    }
    if (!sources.length && !hulls.length) return [];

    return this._groundHull((cb) => {
      for (const h of hulls) for (let i = 0; i < h.length; i += 2) cb(h[i], h[i + 1]);
      for (const { position, items, ids } of sources) {
        const arr = position.array;
        const cache = items.indexCache;
        for (const expressID of ids) {
          const byMaterial = items.map.get(expressID);
          if (!byMaterial) continue;
          for (const ranges of Object.values(byMaterial)) {
            for (let p = 0; p < ranges.length; p += 2) {
              for (let j = ranges[p]; j <= ranges[p + 1]; j++) {
                const vi = cache[j];
                cb(arr[vi * 3], arr[vi * 3 + 2]);
              }
            }
          }
        }
      }
    });
  }

  /** Lowest point of the visible models, where ground-plane overlays are drawn. */
  groundLevel() {
    let min = Infinity;
    for (const entry of this.models.values()) {
      if (!entry.visible) continue;
      if (entry.kind === 'frag') {
        if (entry.minY < min) min = entry.minY;
        continue;
      }
      const g = entry.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox && g.boundingBox.min.y < min) min = g.boundingBox.min.y;
    }
    return Number.isFinite(min) ? min : 0;
  }

  // -------------------------------------------------------- survey overlays

  /**
   * Draws flat polygons on the ground plane — the cadastral lot and the site
   * boundary the geo-referencing check compares.
   *
   * These are not model geometry: they are drawn from survey coordinates, sit
   * outside the hiding and colouring machinery entirely, and are never picked.
   *
   * @param {Array<{points: THREE.Vector3[], colour: number, opacity?: number,
   *                fill?: boolean, elevation?: number}>} polygons
   */
  setSurveyOverlays(polygons) {
    this.clearSurveyOverlays();
    if (!polygons || !polygons.length) return;

    for (const poly of polygons) {
      const pts = poly.points || [];
      if (pts.length < 3) continue;
      const y = poly.elevation !== undefined ? poly.elevation : this.groundLevel();

      // Outline. Drawn slightly above the fill so it is never z-fought away.
      const outline = new THREE.BufferGeometry().setFromPoints(
        pts.map((p) => new THREE.Vector3(p.x, y + 0.06, p.z)));
      const lineMaterial = new THREE.LineBasicMaterial({
        color: new THREE.Color(poly.colour), depthTest: false, transparent: true,
      });
      const line = new THREE.LineLoop(outline, lineMaterial);
      line.renderOrder = 999;
      this.scene.add(line);
      this.surveyOverlays.push({ object: line, geometry: outline, material: lineMaterial });

      if (poly.fill === false) continue;

      // Fill. Triangulated properly rather than fanned, because a cadastral lot
      // is routinely concave and a fan would spill outside it.
      const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
      let faces = [];
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        faces = [];
      }
      if (!faces.length) continue;

      const positions = new Float32Array(faces.length * 9);
      let k = 0;
      for (const [a, b, c] of faces) {
        for (const i of [a, b, c]) {
          positions[k++] = contour[i].x;
          positions[k++] = y + 0.02;
          positions[k++] = contour[i].y;
        }
      }
      const fillGeometry = new THREE.BufferGeometry();
      fillGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const fillMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(poly.colour),
        transparent: true,
        opacity: poly.opacity === undefined ? 0.25 : poly.opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(fillGeometry, fillMaterial);
      mesh.renderOrder = 998;
      this.scene.add(mesh);
      this.surveyOverlays.push({ object: mesh, geometry: fillGeometry, material: fillMaterial });
    }
  }

  clearSurveyOverlays() {
    for (const o of this.surveyOverlays) {
      this.scene.remove(o.object);
      o.geometry.dispose();
      o.material.dispose();
    }
    this.surveyOverlays = [];
  }

  get hasSurveyOverlays() {
    return this.surveyOverlays.length > 0;
  }

  /**
   * Frames the camera on the survey overlays plus the models. Overlays whose
   * centre lies more than `reach` from the models' centre are left out, so a
   * lot kilometres away (the wrong lot, or a mis-georeferenced model) does not
   * shrink the model to a dot.
   */
  fitSurvey(reach = Infinity) {
    if (!this.surveyOverlays.length) return this.fit();
    const box = new THREE.Box3();
    const models = this._visibleBox();
    const centre = models && models.getCenter(new THREE.Vector3());
    for (const o of this.surveyOverlays) {
      const b = new THREE.Box3().setFromObject(o.object);
      if (centre && b.getCenter(new THREE.Vector3()).distanceTo(centre) > reach) continue;
      box.union(b);
    }
    if (models) box.union(models);
    if (box.isEmpty()) return this.fit();

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 10;
    const dist = maxDim * 1.3;
    this.camera.position.set(center.x + dist * 0.6, center.y + dist, center.z + dist * 0.6);
    this.camera.near = maxDim / 200;
    this.camera.far = maxDim * 60;
    this.camera.updateProjectionMatrix();
    this._pivotAnim = null;
    this.controls.target.copy(center);
    this.controls.update();
    return undefined;
  }

  reset() {
    this.groups = [];
    this.contextMode = 'ghost';
    this.clearSurveyOverlays();
    this.refresh();
  }

  // ------------------------------------------------------------------ camera

  /** Union box of everything currently visible, or null if nothing is. */
  /** Frames a set of elements, using their parts where they draw through parts. */
  fitElements(elements) {
    const box = this._elementsBox(elements);
    if (box.isEmpty()) return false;
    if (this.activeCamera === this.orthoCamera) this.exitPlanView();
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
    return true;
  }

  /**
   * Where each model's geometry sits in its own IFC coordinates (metres, Z up):
   * the median of its element centres, so one stray object does not move it.
   * The scene is `M · (x, z, -y)` of those (see geo/georef.js), undone here.
   * @returns {Map<number, {x: number, y: number, z: number}>}
   */
  modelCentres() {
    const Minv = (this.coordinationMatrix || new THREE.Matrix4()).clone().invert();
    const out = new Map();
    for (const e of this.entries) {
      const boxes = [...(e.boxes || new Map()).values()];
      if (!boxes.length) continue;
      const median = (axis) => {
        const v = boxes.map((b) => (b[axis] + b[axis + 3]) / 2).sort((a, b) => a - b);
        return v[Math.floor(v.length / 2)];
      };
      const q = new THREE.Vector3(median(0), median(1), median(2)).applyMatrix4(Minv);
      out.set(e.modelID, { x: q.x, y: -q.z, z: q.y });
    }
    return out;
  }

  /**
   * The current camera as a BCF viewpoint: IFC project coordinates, metres,
   * Z up. The scene is `M · (x, z, -y)` of those (see geo/georef.js), so this
   * undoes the re-centring and the axis swap.
   */
  cameraViewpoint() {
    const Minv = (this.coordinationMatrix || new THREE.Matrix4()).clone().invert();
    const toIfc = (v) => {
      const s = v.clone().applyMatrix4(Minv);
      return { x: s.x, y: -s.z, z: s.y };
    };
    const toIfcDir = (v) => {
      const s = v.clone().transformDirection(Minv);
      return { x: s.x, y: -s.z, z: s.y };
    };
    const cam = this.activeCamera;
    const direction = new THREE.Vector3();
    cam.getWorldDirection(direction);
    // The camera's own Y axis in world space is its true up, whatever `up` was set to.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
    if (cam === this.orthoCamera) {
      return {
        type: 'orthogonal', position: toIfc(cam.position), direction: toIfcDir(direction),
        up: toIfcDir(up), scale: (cam.top - cam.bottom) || 1,
      };
    }
    return {
      type: 'perspective', position: toIfc(cam.position), direction: toIfcDir(direction),
      up: toIfcDir(up), fov: cam.fov,
    };
  }

  /** Moves the camera to a BCF viewpoint (the inverse of cameraViewpoint). */
  setViewpoint(vp) {
    if (!vp || !vp.position || !vp.direction) return false;
    const M = this.coordinationMatrix || new THREE.Matrix4();
    const fromIfc = (p) => new THREE.Vector3(p.x, p.z, -p.y).applyMatrix4(M);
    const fromIfcDir = (p) => new THREE.Vector3(p.x, p.z, -p.y).transformDirection(M).normalize();
    if (this.activeCamera === this.orthoCamera) this.exitPlanView();
    const position = fromIfc(vp.position);
    const direction = fromIfcDir(vp.direction);
    if (!Number.isFinite(position.x) || direction.lengthSq() < 1e-9) return false;
    this.camera.position.copy(position);
    if (vp.up) this.camera.up.copy(fromIfcDir(vp.up));
    if (vp.fov) this.camera.fov = vp.fov;
    this.camera.updateProjectionMatrix();
    // OrbitControls orbits about its target; put it a model's width ahead.
    const box = this._visibleBox();
    const reach = box ? box.getSize(new THREE.Vector3()).length() * 0.5 : 20;
    this._pivotAnim = null;
    this.controls.target.copy(position).addScaledVector(direction, reach);
    this.controls.update();
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
    // JPEG has no alpha: paint the scene background first so nothing goes black.
    ctx.fillStyle = '#' + this.scene.background.getHexString();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((blob) =>
      resolve(blob ? Object.assign(blob, { width: canvas.width, height: canvas.height }) : null), type, quality));
  }

  /**
   * The box the camera frames: every visible element except the far ones (see
   * FAR_FACTOR). The far ones are kept in `farElements` so the app can name
   * them, since geometry kilometres from the building is almost always an
   * export problem worth fixing at source.
   */
  _visibleBox() {
    const visible = this.entries.filter((e) => e.visible);
    const key = visible.map((e) => e.modelID).join(',');
    if (this._boxCache && this._boxCache.key === key) return this._boxCache.box;

    const all = [];
    for (const e of visible) for (const [id, b] of e.boxes || []) all.push({ modelID: e.modelID, expressID: id, b });

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
      // Too few elements to tell a stray from the model: frame everything.
      box = new THREE.Box3();
      for (const e of visible) box.union(e.kind === 'frag' ? e.fragModel.box : new THREE.Box3().setFromObject(e.mesh));
      if (box.isEmpty()) box = null;
    }
    far.sort((a, b) => b.distance - a.distance);
    this.farElements = far;
    this._boxCache = { key, box };
    return box;
  }

  fit() {
    if (this.activeCamera === this.orthoCamera) {
      this.enterPlanView();
      return;
    }

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
  }

  /** Enable/disable whichever OrbitControls belongs to the active camera. */
  setOrbitEnabled(on) {
    this.controls.enabled = on && this.activeCamera === this.camera;
    this.controlsOrtho.enabled = on && this.activeCamera === this.orthoCamera;
  }

  // -------------------------------------------------------------- plan views

  /** Switches to a straight-down orthographic camera framed on the model. */
  enterPlanView() {
    const box = this._visibleBox();
    if (!box) return false;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const halfH = (Math.max(size.x, size.z) / 2) * 1.08 || 10;
    this._orthoHalfHeight = halfH;
    this._applyOrthoFrustum();

    const above = Math.max(size.y, 10) + 20;
    this.orthoCamera.position.set(center.x, box.max.y + above, center.z);
    this.orthoCamera.up.set(0, 0, -1);
    this.orthoCamera.lookAt(center.x, box.min.y, center.z);
    this.orthoCamera.near = 0.1;
    this.orthoCamera.far = size.y + above + 100;
    this.orthoCamera.updateProjectionMatrix();

    this.controlsOrtho.target.set(center.x, box.min.y, center.z);
    this.controlsOrtho.update();

    this.activeCamera = this.orthoCamera;
    this.controls.enabled = false;
    this.controlsOrtho.enabled = true;
    this.groundY = box.min.y;
    this._fragCamera();
    return true;
  }

  exitPlanView() {
    this.activeCamera = this.camera;
    this.controlsOrtho.enabled = false;
    this.controls.enabled = true;
    this._fragCamera();
  }

  /** Horizontal clip plane: keeps geometry at or below `y`, hides above. */
  setPlanClip(y) {
    this.planClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), y);
    this._updateClipping();
  }

  clearPlanClip() {
    this.planClipPlane = null;
    this._updateClipping();
  }

  /**
   * The world-Y bounding box of one element, read straight from the rendered
   * mesh (position buffer + the pristine index cache), so it needs neither the
   * wasm model (already released by the time this is useful) nor any placement
   * math of our own — whatever the mesh actually shows is the ground truth.
   */
  elementYRange(modelID, expressID, expressIDs = [expressID]) {
    const entry = this.models.get(modelID);
    if (!entry) return null;
    if (entry.kind === 'frag') {
      // Exact: a large model's boxes are taken from its vertices.
      let min = Infinity, max = -Infinity;
      for (const id of expressIDs) {
        const b = entry.boxes.get(id);
        if (!b) continue;
        if (b[1] < min) min = b[1];
        if (b[4] > max) max = b[4];
      }
      return isFinite(min) ? { min, max } : null;
    }
    const items = this._itemsMap(modelID);
    if (!items) return null;

    const pos = entry.mesh.geometry.attributes.position;
    const idx = items.indexCache;
    let min = Infinity, max = -Infinity;
    for (const id of expressIDs) {
      const byMaterial = items.map.get(id);
      if (!byMaterial) continue;
      for (const ranges of Object.values(byMaterial)) {
        for (let p = 0; p < ranges.length; p += 2) {
          for (let j = ranges[p]; j <= ranges[p + 1]; j++) {
            const y = pos.getY(idx[j]);
            if (y < min) min = y;
            if (y > max) max = y;
          }
        }
      }
    }
    return isFinite(min) ? { min, max } : null;
  }

  /**
   * Median base height of a set of elements, e.g. everything on one storey —
   * used as that storey's floor reference for a plan cut. Sampling (rather than
   * every element) keeps this cheap on a storey with thousands of elements, and
   * the median shrugs off the odd multi-storey column or shaft.
   */
  sampleFloorY(elements, max = 60) {
    if (!elements || !elements.length) return null;
    const step = Math.max(1, Math.floor(elements.length / max));
    const mins = [];
    for (let i = 0; i < elements.length; i += step) {
      const e = elements[i];
      const r = this.elementYRange(e.modelID, e.expressID, this._geometryIds(e));
      if (r) mins.push(r.min);
    }
    if (!mins.length) return null;
    mins.sort((a, b) => a - b);
    return mins[Math.floor(mins.length / 2)];
  }

  // ------------------------------------------------------------ section cuts

  /**
   * The model face under the pointer, with its normal snapped to the nearest
   * world axis. Forma places a section on a clicked face; snapping keeps every
   * cut a clean X, Y or Z plane whatever the face was actually drawn at.
   * @returns {{point: THREE.Vector3, normal: THREE.Vector3, axis: 'x'|'y'|'z'}|null}
   */
  raycastFace(event) {
    let hit = this._raycastVisible(event);
    let normal = hit && hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    // Large models answer from the background probe (see _probe), normal included.
    const frag = this._hasFragments() ? this._probeAt(event) : null;
    if (frag && frag.normal && (!normal || frag.distance < hit.distance)) {
      hit = { point: frag.point };
      normal = frag.normal.clone().normalize();
    }
    if (!normal) return null;

    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    const axis = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';
    const snapped = new THREE.Vector3();
    snapped[axis] = Math.sign(normal[axis]) || 1;
    return { point: hit.point.clone(), normal: snapped, axis };
  }

  /**
   * Adds an axis-aligned cutting plane through a picked face, discarding the
   * half the camera is on — click the outside of a wall and the cut sits on
   * that wall, ready to be slid inward (flip it with `flipSectionPlane`).
   * @param {{point: THREE.Vector3, normal: THREE.Vector3, axis: string}} face
   */
  addSectionAtFace(face, cameraPos) {
    const normal = face.normal.clone().normalize();
    const toCam = new THREE.Vector3().subVectors(cameraPos, face.point);
    if (normal.dot(toCam) > 0) normal.negate();

    const id = ++this._sectionSeq;
    const entry = {
      id, axis: face.axis, normal, anchor: face.point.clone(),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, face.point),
      group: null,
    };
    entry.group = this._buildSectionHelper(entry);
    this.scene.add(entry.group);
    this.sectionPlanes.push(entry);
    this._updateClipping();
    return id;
  }

  flipSectionPlane(id) {
    const s = this.sectionPlanes.find((x) => x.id === id);
    if (!s) return;
    s.normal.negate();
    this._rebuildSection(s);
  }

  /** Re-derives a cut's clipping plane and helper after its normal or anchor moved. */
  _rebuildSection(s) {
    s.plane.setFromNormalAndCoplanarPoint(s.normal, s.anchor);
    this.scene.remove(s.group);
    s.group = this._buildSectionHelper(s);
    this.scene.add(s.group);
    this._updateClipping();
  }

  /**
   * Where the pointer sits along a cut's axis: the parameter t of the closest
   * point on the line `anchor + t·normal` to the pointer ray. Null when the
   * axis runs straight into the screen and has no usable direction.
   */
  _sectionAxisParam(s, event, origin = s.anchor) {
    const ray = this._pointerRay(event).ray;
    const d = s.normal, r = ray.direction;
    const w0 = new THREE.Vector3().subVectors(origin, ray.origin);
    const b = d.dot(r);
    const denom = 1 - b * b;
    if (denom < 1e-6) return null;
    return (b * r.dot(w0) - d.dot(w0)) / denom;
  }

  /**
   * Starts sliding a cut if the pointer is on one of the cut helpers.
   * @returns {number|null} the grabbed cut's id
   */
  /** True if the pointer is over a placed cut, where a click grabs it rather than placing one. */
  overSection(event) {
    if (!this.sectionPlanes.length) return false;
    return this._pointerRay(event).intersectObjects(this.sectionPlanes.map((s) => s.group), true).length > 0;
  }

  grabSection(event) {
    if (!this.sectionPlanes.length) return null;
    const targets = this.sectionPlanes.map((s) => s.group);
    const hits = this._pointerRay(event).intersectObjects(targets, true);
    if (!hits.length) return null;

    let obj = hits[0].object;
    while (obj && obj.userData.sectionId === undefined) obj = obj.parent;
    const s = obj && this.sectionPlanes.find((x) => x.id === obj.userData.sectionId);
    if (!s) return null;

    const t0 = this._sectionAxisParam(s, event);
    if (t0 === null) return null;
    this._sectionDrag = { id: s.id, anchor0: s.anchor.clone(), t0 };
    return s.id;
  }

  /** Slides the grabbed cut along its axis to follow the pointer. */
  dragSection(event) {
    const drag = this._sectionDrag;
    if (!drag) return;
    const s = this.sectionPlanes.find((x) => x.id === drag.id);
    if (!s) return;
    const t = this._sectionAxisParam(s, event, drag.anchor0);
    if (t === null) return;
    s.anchor.copy(drag.anchor0).addScaledVector(s.normal, t - drag.t0);
    this._rebuildSection(s);
  }

  endSectionDrag() {
    this._sectionDrag = null;
  }

  get sectionDragging() {
    return this._sectionDrag !== null;
  }

  removeSectionPlane(id) {
    const i = this.sectionPlanes.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.scene.remove(this.sectionPlanes[i].group);
    this.sectionPlanes.splice(i, 1);
    this._updateClipping();
  }

  clearSectionPlanes() {
    for (const s of this.sectionPlanes) this.scene.remove(s.group);
    this.sectionPlanes = [];
    this._updateClipping();
  }

  _updateClipping() {
    const planes = this.sectionPlanes.map((s) => s.plane);
    if (this.planClipPlane) planes.push(this.planClipPlane);
    this.renderer.clippingPlanes = planes;
  }

  /**
   * The cut drawn as a translucent rectangle where the plane slices the model's
   * bounding box, with an arrow at the anchor pointing into the kept half. The
   * rectangle is also the handle: dragging it slides the cut along its axis.
   */
  /**
   * The rectangle a cut draws: the model's bounds, padded a little, sliced at
   * the anchor along the cut's axis. Also returns the model's largest
   * dimension, which sizes the direction arrow.
   */
  _sectionRect({ axis, normal, anchor }, box = this._visibleBox()) {
    box = (box || new THREE.Box3(
      new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10))).clone();
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    box.expandByScalar(maxDim * 0.04);

    // The two in-plane axes, and the rectangle corners at the anchor's offset.
    const [u, v] = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
    const corner = (uMin, vMin) => {
      const p = new THREE.Vector3();
      p[axis] = anchor[axis];
      p[u] = uMin ? box.min[u] : box.max[u];
      p[v] = vMin ? box.min[v] : box.max[v];
      // Nudged into the kept half so the plane never clips its own handle.
      return p.addScaledVector(normal, 1e-3);
    };
    return {
      corners: [corner(true, true), corner(false, true), corner(false, false), corner(true, false)],
      arrowLen: Math.max(maxDim * 0.08, 0.6),
    };
  }

  /**
   * Shows where a cut would go if the face under the pointer were clicked: the
   * same rectangle and arrow a placed cut draws, fainter. Built once and moved,
   * since it follows the pointer every frame.
   * @param {{point: THREE.Vector3, normal: THREE.Vector3, axis: string}|null} face
   */
  previewSection(face, cameraPos) {
    if (!face) {
      this.hideSectionPreview();
      return;
    }
    const normal = face.normal.clone().normalize();
    if (normal.dot(new THREE.Vector3().subVectors(cameraPos, face.point)) > 0) normal.negate();

    // The model's bounds do not change while the pointer moves; measure them once.
    if (!this._previewBox) this._previewBox = this._visibleBox();
    const { corners, arrowLen } = this._sectionRect(
      { axis: face.axis, normal, anchor: face.point }, this._previewBox);

    let p = this._sectionPreview;
    if (!p) {
      const colour = 0xffcf5c;
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(corners),
        new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true, opacity: 0.75 }));
      const fill = new THREE.Mesh(
        new THREE.BufferGeometry().setFromPoints(
          [corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]),
        new THREE.MeshBasicMaterial({
          color: colour, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false,
        }));
      const arrow = new THREE.ArrowHelper(normal, face.point, arrowLen, colour);
      arrow.line.material.depthTest = false;
      arrow.cone.material.depthTest = false;
      for (const o of [outline, fill]) o.frustumCulled = false; // moved in place, bounds go stale
      outline.renderOrder = 999;
      fill.renderOrder = 998;
      arrow.renderOrder = 999;
      const group = new THREE.Group();
      group.add(outline, fill, arrow);
      this.scene.add(group);
      p = this._sectionPreview = { group, outline, fill, arrow };
    }

    const op = p.outline.geometry.attributes.position;
    corners.forEach((c, i) => op.setXYZ(i, c.x, c.y, c.z));
    op.needsUpdate = true;
    const fp = p.fill.geometry.attributes.position;
    [0, 1, 2, 0, 2, 3].forEach((ci, i) => fp.setXYZ(i, corners[ci].x, corners[ci].y, corners[ci].z));
    fp.needsUpdate = true;
    p.arrow.position.copy(face.point);
    p.arrow.setDirection(normal);
    p.arrow.setLength(arrowLen, arrowLen * 0.35, arrowLen * 0.2);
    p.group.visible = true;
  }

  hideSectionPreview() {
    if (this._sectionPreview) this._sectionPreview.group.visible = false;
  }

  /** Drops the preview entirely, when the section tool is put away. */
  endSectionPreview() {
    const p = this._sectionPreview;
    if (p) {
      this.scene.remove(p.group);
      p.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this._sectionPreview = null;
    this._previewBox = null;
  }

  _buildSectionHelper({ id, axis, normal, anchor }) {
    const group = new THREE.Group();
    group.userData.sectionId = id;

    const { corners, arrowLen: len } = this._sectionRect({ axis, normal, anchor });

    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(corners),
      new THREE.LineBasicMaterial({ color: 0xffcf5c, depthTest: false }));
    outline.renderOrder = 999;
    group.add(outline);

    const quad = new THREE.BufferGeometry().setFromPoints(
      [corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
    quad.computeVertexNormals();
    const fill = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({
      color: 0xffcf5c, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false,
    }));
    fill.renderOrder = 998;
    group.add(fill);

    const arrow = new THREE.ArrowHelper(
      normal.clone(), anchor.clone(), len, 0xffcf5c, len * 0.35, len * 0.2);
    arrow.line.material.depthTest = false;
    arrow.cone.material.depthTest = false;
    arrow.renderOrder = 999;
    group.add(arrow);

    return group;
  }

  /** A raycaster aimed through the pointer from whichever camera is active. */
  _pointerRay(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.activeCamera);
    return ray;
  }

  /**
   * The nearest model surface under the pointer that the renderer actually
   * draws. The raycaster sees the full, unclipped geometry, so the nearest hit
   * can be something a section or plan cut is hiding (the roof, from above a
   * plan cut) — skip past anything on the discarded side of an active plane.
   */
  _raycastVisible(event, includeOverlays = true) {
    if (!this.hasModels) return null;
    const targets = [];
    for (const entry of this.models.values()) if (entry.visible && entry.mesh) targets.push(entry.mesh);
    if (!targets.length) return null;
    // Overlay subsets live on the scene, not under a model, so both have to be
    // offered to the raycaster or picking would stop working during a query.
    if (includeOverlays) for (const o of this.overlays) if (o.mesh) targets.push(o.mesh);
    // The highlight can be all that draws a selected element when context is hidden.
    if (includeOverlays && this.selectionMesh) targets.push(this.selectionMesh);

    const hits = this._pointerRay(event).intersectObjects(targets, true).filter((h) => h.object.visible);
    if (!hits.length) return null;
    const planes = this.renderer.clippingPlanes;
    return planes && planes.length
      ? hits.find((h) => planes.every((p) => p.distanceToPoint(h.point) >= 0)) || null
      : hits[0];
  }

  // ----------------------------------------------------------------- picking

  onPick(cb) { this.pickListeners.push(cb); }
  onContextMenu(cb) { this.menuListeners.push(cb); }

  /** True if `button` moved more than a few px between its mousedown and `e`. */
  _wasDrag(button, e) {
    const start = this._downPos[button];
    if (!start) return false;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    return dx * dx + dy * dy > 25;
  }

  /** @returns {{modelID:number, expressID:number}|null} */
  _pickAt(event) {
    try {
      return this.pickElement(event);
    } catch (err) {
      console.warn('GPU picking failed; falling back to raycasting.', err);
    }
    const hit = this._raycastVisible(event);
    if (!hit) return null;

    try {
      const expressID = this.loader.ifcManager.getExpressId(hit.object.geometry, hit.faceIndex);
      if (expressID === undefined || expressID === null) return null;
      return { modelID: hit.object.modelID, expressID };
    } catch {
      return null;
    }
  }
}
