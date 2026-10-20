/**
 * Point-to-point measuring with snapping, after Forma's measure tool.
 *
 * The pointer snaps, in order of preference, to an edge's endpoint, its
 * midpoint, anywhere along it, or else to the face under the cursor. Edges are
 * the element's *feature* edges — where neighbouring faces meet at more than a
 * few degrees — so the diagonals that split a flat face into triangles are
 * never offered. They are worked out the first time the pointer is over an
 * element and kept, so hovering stays cheap.
 *
 * Click two points to measure between them. Shift locks the second point to
 * the X, Y or Z axis through the first, so a height or a straight run can be
 * read off without finding a point exactly above or across. Measurements stay
 * until removed with their ×, Backspace (the last one) or Clear.
 *
 * Distances are in metres: web-ifc has already applied each file's length unit.
 */

import * as THREE from 'three';

/** How close, in screen pixels, the pointer must be to snap to each kind. */
const SNAP_PX = { vertex: 12, midpoint: 10, edge: 8 };
/** Faces meeting at more than this many degrees share a feature edge. */
const EDGE_ANGLE_DEG = 20;
/** Elements with more triangles than this snap to the triangle under the pointer only. */
const MAX_TRIANGLES = 60000;
/** Elements whose triangles and edges are kept, most recently used last. */
const CACHE_SIZE = 300;
/** ...and the most floats they may hold between them (about 48 MB). */
const CACHE_FLOATS = 12e6;

const COLOUR = 0xffc94a;
const PREVIEW_COLOUR = 0xffe9a8;
const EDGE_COLOUR = 0x3fd0ff;
const AXIS_COLOUR = { x: 0xf0625a, y: 0x6ad16a, z: 0x4f9cf0 };
const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
const AXIS_NAME = { x: 'X', y: 'Z (height)', z: 'Y' }; // the scene is Y-up; IFC is Z-up
const KIND_LABEL = { vertex: 'Endpoint', midpoint: 'Midpoint', edge: 'Edge', face: 'Face', point: 'Point' };

/** Metres to a display string: millimetre precision, as drawings are dimensioned. */
export function formatLength(m) {
  return `${m.toFixed(3)} m`;
}

/**
 * Feature edges of a triangle soup: `[ax, ay, az, bx, by, bz, …]`.
 * Uses three's EdgesGeometry, which welds coincident vertices first, so faces
 * exported as separate triangles still find their neighbours.
 */
export function featureEdges(triangles, angleDeg = EDGE_ANGLE_DEG) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(triangles, 3));
  const edges = new THREE.EdgesGeometry(geo, angleDeg);
  const out = edges.attributes.position.array.slice();
  geo.dispose();
  edges.dispose();
  return out;
}

/** The three sides of one triangle (at float offset `i`) as edge segments. */
function triangleEdges(tris, i) {
  const out = new Float32Array(18);
  if (i < 0) return new Float32Array(0);
  [[0, 3], [3, 6], [6, 0]].forEach(([p, q], k) => {
    for (let j = 0; j < 3; j++) {
      out[k * 6 + j] = tris[i + p + j];
      out[k * 6 + 3 + j] = tris[i + q + j];
    }
  });
  return out;
}

export class MeasureTool {
  /** @param {import('./viewer.js').Viewer} viewer */
  constructor(viewer, { onChange = () => {} } = {}) {
    this.viewer = viewer;
    this.onChange = onChange;
    this.active = false;
    /** @type {Array<{id: number, a: THREE.Vector3, b: THREE.Vector3, line: THREE.Line, label: HTMLElement}>} */
    this.measurements = [];
    this._nextId = 1;
    this.start = null;      // first point of the measurement being placed
    this.current = null;    // the snapped point under the pointer
    this.shift = false;
    this._edgeCache = new Map();
    this._lastEvent = null;
    this._framePending = false;

    this.group = new THREE.Group();
    this.group.renderOrder = 1000;
    viewer.scene.add(this.group);

    const lineMat = (colour, opacity = 1) => new THREE.LineBasicMaterial({
      color: colour, depthTest: false, depthWrite: false, transparent: true, opacity,
    });
    this._lineMaterial = lineMat(COLOUR);
    this._previewLine = new THREE.Line(new THREE.BufferGeometry(), lineMat(PREVIEW_COLOUR, 0.9));
    this._edgeLine = new THREE.Line(new THREE.BufferGeometry(), lineMat(EDGE_COLOUR));
    for (const l of [this._previewLine, this._edgeLine]) {
      l.renderOrder = 1001;
      l.visible = false;
      l.frustumCulled = false;
      this.group.add(l);
    }

    // HTML layer for markers and labels: crisp at any zoom, and the labels can
    // carry a remove button.
    this.layer = document.createElement('div');
    this.layer.className = 'measure-layer';
    this.layer.innerHTML = `
      <div class="m-snap" hidden><i></i><span></span></div>
      <div class="m-dot m-start" hidden></div>
      <div class="m-label m-live" hidden></div>
      <div class="m-hint" hidden>
        <span class="m-hint-text">Click two points to measure</span>
        <span class="m-keys"><kbd>Shift</kbd> lock axis · <kbd>Esc</kbd> cancel</span>
        <button class="m-clear" type="button" disabled>Clear</button>
      </div>`;
    viewer.container.appendChild(this.layer);
    this._snapEl = this.layer.querySelector('.m-snap');
    this._startEl = this.layer.querySelector('.m-start');
    this._liveEl = this.layer.querySelector('.m-live');
    this._hintEl = this.layer.querySelector('.m-hint');
    this._hintText = this.layer.querySelector('.m-hint-text');
    this._clearBtn = this.layer.querySelector('.m-clear');
    this._clearBtn.addEventListener('click', () => this.clear());

    const canvas = viewer.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
    canvas.addEventListener('pointerleave', () => { if (this.active) this._setCurrent(null); });
    canvas.addEventListener('click', (e) => this._onClick(e));
    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));

    viewer.onFrame(() => this._layout());
  }

  // ------------------------------------------------------------------ state

  setActive(on) {
    if (this.active === on) return;
    this.active = on;
    this.viewer.renderer.domElement.style.cursor = on ? 'crosshair' : '';
    // Leaving the tool keeps the measurements on screen, so the model can be
    // clicked and inspected as usual with them still showing; Clear removes them.
    if (!on) {
      this.start = null;
      this._setCurrent(null);
      this.invalidate();
    }
    this._refreshHint();
  }

  /** Removes every measurement (and any half-placed one). */
  clear() {
    for (const m of this.measurements) this._dispose(m);
    this.measurements = [];
    this.start = null;
    this._updatePreview();
    this._refreshHint();
    this.onChange();
  }

  remove(id) {
    const i = this.measurements.findIndex((m) => m.id === id);
    if (i < 0) return;
    this._dispose(this.measurements[i]);
    this.measurements.splice(i, 1);
    this._refreshHint();
    this.onChange();
  }

  /** Forgets cached edges, e.g. after a model is closed. */
  invalidate() {
    this._edgeCache.clear();
    this._cachedFloats = 0;
  }

  _dispose(m) {
    this.group.remove(m.line);
    m.line.geometry.dispose();
    m.label.remove();
  }

  _refreshHint() {
    const n = this.measurements.length;
    this._hintEl.hidden = !this.active && !n;
    this._hintEl.classList.toggle('idle', !this.active);
    this._clearBtn.disabled = !n && !this.start;
    if (!this.active) {
      this._hintText.textContent = `${n} measurement${n === 1 ? '' : 's'}`;
      return;
    }
    this._hintText.textContent = this.start
      ? (this.shift ? 'Locked to an axis: click the second point' : 'Click the second point')
      : 'Click two points to measure';
  }

  // ----------------------------------------------------------------- events

  _onMove(e) {
    if (!this.active) return;
    this._lastEvent = e;
    if (this._framePending) return;
    this._framePending = true;
    requestAnimationFrame(() => {
      this._framePending = false;
      const ev = this._lastEvent;
      // A held button is an orbit or a pan, not aiming.
      if (!this.active || !ev || ev.buttons) {
        this._setCurrent(null);
        return;
      }
      this._setCurrent(this._resolve(ev));
    });
  }

  _onClick(e) {
    if (!this.active || this.viewer._wasDrag(0, e)) return;
    const p = this._resolve(e);
    if (!p) return;
    if (!this.start) {
      this.start = p;
    } else {
      if (p.point.distanceToSquared(this.start.point) > 1e-10) this._add(this.start.point, p.point);
      this.start = null;
    }
    this._setCurrent(p.axis ? null : p);
    this._refreshHint();
  }

  _onKey(e, down) {
    if (!this.active) return;
    if (e.key === 'Shift') {
      if (this.shift !== down) {
        this.shift = down;
        if (this._lastEvent) this._setCurrent(this._resolve(this._lastEvent));
        this._refreshHint();
      }
      return;
    }
    if (!down) return;
    const typing = e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if (typing) return;
    if ((e.key === 'Backspace' || e.key === 'Delete') && !this.start && this.measurements.length) {
      e.preventDefault();
      this.remove(this.measurements[this.measurements.length - 1].id);
    }
  }

  /**
   * Escape: drops a half-placed measurement first. Returns true if it did,
   * so the shell knows to leave the tool on.
   */
  cancel() {
    if (!this.start) return false;
    this.start = null;
    this._updatePreview();
    this._refreshHint();
    return true;
  }

  // ---------------------------------------------------------------- snapping

  /** The point a click here would place, with how it was found. */
  _resolve(event) {
    const snapped = this.snap(event);
    if (!this.start || !this.shift) return snapped;
    return this._lockToAxis(event, snapped);
  }

  /**
   * Snaps the pointer to the nearest endpoint, midpoint or edge of the element
   * under it, or to the face itself.
   * @returns {{point: THREE.Vector3, kind: string, edge?: [THREE.Vector3, THREE.Vector3]}|null}
   */
  snap(event) {
    const viewer = this.viewer;
    const hit = this._hitAt(event);
    if (!hit) return null;

    const camera = viewer.activeCamera;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const toScreen = (v) => {
      const p = v.clone().project(camera);
      return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height, z: p.z };
    };
    const px = (v) => {
      const s = toScreen(v);
      return s.z > 1 ? Infinity : Math.hypot(s.x - mx, s.y - my);
    };

    // Something hidden behind the face under the pointer must not be snapped
    // to through it. Compare view depths, with slack for points on the same
    // face seen at a grazing angle.
    const view = camera.matrixWorldInverse;
    const depth = (v) => -v.clone().applyMatrix4(view).z;
    const hitDepth = depth(hit.point);
    const slack = 0.05 + hitDepth * 0.02;
    const planes = viewer.renderer.clippingPlanes || [];
    const visible = (v) => depth(v) <= hitDepth + slack &&
      planes.every((pl) => pl.distanceToPoint(v) >= -1e-4);

    const edges = hit.edges;
    const candidates = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const onRay = new THREE.Vector3();
    const onSeg = new THREE.Vector3();
    const ray = viewer._pointerRay(event).ray;

    for (let i = 0; i < edges.length; i += 6) {
      a.fromArray(edges, i);
      b.fromArray(edges, i + 3);
      const da = px(a);
      const db = px(b);
      if (da <= SNAP_PX.vertex && visible(a)) candidates.push({ kind: 'vertex', d: da, point: a.clone(), edge: [a.clone(), b.clone()] });
      if (db <= SNAP_PX.vertex && visible(b)) candidates.push({ kind: 'vertex', d: db, point: b.clone(), edge: [a.clone(), b.clone()] });
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dm = px(mid);
      if (dm <= SNAP_PX.midpoint && visible(mid)) candidates.push({ kind: 'midpoint', d: dm, point: mid, edge: [a.clone(), b.clone()] });
      ray.distanceSqToSegment(a, b, onRay, onSeg);
      const de = px(onSeg);
      if (de <= SNAP_PX.edge && visible(onSeg)) candidates.push({ kind: 'edge', d: de, point: onSeg.clone(), edge: [a.clone(), b.clone()] });
    }

    // The ends of measurements already placed are worth coming back to.
    for (const m of this.measurements) {
      for (const v of [m.a, m.b]) {
        const d = px(v);
        if (d <= SNAP_PX.vertex && visible(v)) candidates.push({ kind: 'vertex', d, point: v.clone() });
      }
    }

    const rank = { vertex: 0, midpoint: 1, edge: 2 };
    candidates.sort((p, q) => rank[p.kind] - rank[q.kind] || p.d - q.d);
    if (candidates.length) {
      const { kind, point, edge } = candidates[0];
      return { kind, point, edge };
    }
    return { kind: 'face', point: hit.point.clone() };
  }

  /**
   * The exact point under the pointer. The GPU says which element it is (see
   * Viewer.pickElement), and only that element's triangles are tested against
   * the pointer's ray, so the cost does not grow with the size of the model.
   * @returns {{point: THREE.Vector3, edges: Float32Array}|null}
   */
  _hitAt(event) {
    const viewer = this.viewer;
    const picked = viewer.pickElement(event);
    if (!picked) return null;
    const el = this._element(picked.modelID, picked.expressID);
    const tris = el && el.tris;
    if (!tris) return null;

    const ray = viewer._pointerRay(event).ray;
    const planes = viewer.renderer.clippingPlanes || [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const p = new THREE.Vector3();
    let best = Infinity;
    let bestTri = -1;
    const point = new THREE.Vector3();
    for (let i = 0; i < tris.length; i += 9) {
      a.fromArray(tris, i); b.fromArray(tris, i + 3); c.fromArray(tris, i + 6);
      if (!ray.intersectTriangle(a, b, c, false, p)) continue;
      const d = ray.origin.distanceToSquared(p);
      if (d >= best || !planes.every((pl) => pl.distanceToPoint(p) >= -1e-4)) continue;
      best = d;
      bestTri = i;
      point.copy(p);
    }
    // The pixel's centre can graze past a silhouette the ray just misses:
    // take the element's vertex nearest the ray instead.
    if (bestTri < 0) {
      for (let i = 0; i < tris.length; i += 3) {
        a.fromArray(tris, i);
        const d = ray.distanceSqToPoint(a);
        if (d < best) { best = d; bestTri = i - (i % 9); point.copy(a); }
      }
    }
    return { point, edges: el.edges || triangleEdges(tris, bestTri) };
  }

  /** An element's triangles and feature edges, made on first hover and kept. */
  _element(modelID, expressID) {
    const key = `${modelID}:${expressID}`;
    let el = this._edgeCache.get(key);
    if (el) {
      // Refresh its place as most recently used.
      this._edgeCache.delete(key);
      this._edgeCache.set(key, el);
      return el;
    }
    const tris = this.viewer.elementTriangles(modelID, expressID);
    el = { tris, edges: tris && tris.length / 9 <= MAX_TRIANGLES ? featureEdges(tris) : null };
    this._edgeCache.set(key, el);
    this._cachedFloats = (this._cachedFloats || 0) + (tris ? tris.length : 0) + (el.edges ? el.edges.length : 0);
    while (this._edgeCache.size > 1 && (this._edgeCache.size > CACHE_SIZE || this._cachedFloats > CACHE_FLOATS)) {
      const [oldKey, old] = this._edgeCache.entries().next().value;
      this._edgeCache.delete(oldKey);
      this._cachedFloats -= (old.tris ? old.tris.length : 0) + (old.edges ? old.edges.length : 0);
    }
    return el;
  }

  /**
   * Holds the second point on the X, Y or Z line through the first. With a
   * snapped point, the axis is the one it lies furthest along and the point
   * is projected onto it, so a roof edge gives its height above the start.
   * With nothing under the pointer, the point is wherever the pointer's ray
   * passes closest to the line.
   */
  _lockToAxis(event, snapped) {
    const origin = this.start.point;
    let axis = this._axis || 'y';
    if (snapped) {
      const d = snapped.point.clone().sub(origin);
      const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
      if (ax + ay + az > 1e-6) axis = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';
    }
    this._axis = axis;
    const dir = AXES[axis];
    let point;
    if (snapped) {
      point = origin.clone().addScaledVector(dir, snapped.point.clone().sub(origin).dot(dir));
    } else {
      const ray = this.viewer._pointerRay(event).ray;
      const far = 1e5;
      point = new THREE.Vector3();
      ray.distanceSqToSegment(origin.clone().addScaledVector(dir, -far), origin.clone().addScaledVector(dir, far), null, point);
    }
    return { kind: snapped ? snapped.kind : 'point', point, axis, snappedTo: snapped ? snapped.point : null };
  }

  // -------------------------------------------------------------- drawing

  _setCurrent(p) {
    this.current = p;
    const edge = p && p.edge && !p.axis ? p.edge : null;
    this._edgeLine.visible = !!edge;
    if (edge) this._edgeLine.geometry.setFromPoints(edge);
    this._updatePreview();
  }

  _updatePreview() {
    const show = !!(this.start && this.current);
    this._previewLine.visible = show;
    if (show) {
      this._previewLine.geometry.setFromPoints([this.start.point, this.current.point]);
      this._previewLine.material.color.setHex(this.current.axis ? AXIS_COLOUR[this.current.axis] : PREVIEW_COLOUR);
    }
  }

  _add(a, b) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), this._lineMaterial);
    line.renderOrder = 1000;
    line.frustumCulled = false;
    this.group.add(line);
    const id = this._nextId++;
    const label = document.createElement('div');
    label.className = 'm-label';
    label.innerHTML = `${labelHtml(a, b)}<button type="button" title="Remove this measurement">&times;</button>`;
    label.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      this.remove(id);
    });
    this.layer.appendChild(label);
    this.measurements.push({ id, a: a.clone(), b: b.clone(), line, label });
    this.onChange();
  }

  /** Puts the HTML markers and labels over their 3D points; runs every frame. */
  _layout() {
    if (!this.active && !this.measurements.length) return;
    const camera = this.viewer.activeCamera;
    const canvas = this.viewer.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const place = (node, v) => {
      const p = v.clone().project(camera);
      const off = p.z > 1 || p.z < -1;
      node.style.display = off ? 'none' : '';
      if (!off) node.style.transform = `translate(${(p.x + 1) / 2 * w}px, ${(1 - p.y) / 2 * h}px) translate(-50%, -50%)`;
    };

    for (const m of this.measurements) place(m.label, m.a.clone().add(m.b).multiplyScalar(0.5));

    const cur = this.current;
    this._snapEl.hidden = !cur;
    if (cur) {
      this._snapEl.className = `m-snap ${cur.kind}${cur.axis ? ' axis-' + cur.axis : ''}`;
      this._snapEl.querySelector('span').textContent = cur.axis
        ? `${AXIS_NAME[cur.axis]} axis`
        : KIND_LABEL[cur.kind];
      place(this._snapEl, cur.point);
    }

    this._startEl.hidden = !this.start;
    if (this.start) place(this._startEl, this.start.point);

    const live = this.start && cur;
    this._liveEl.hidden = !live;
    if (live) {
      this._liveEl.innerHTML = labelHtml(this.start.point, cur.point);
      place(this._liveEl, this.start.point.clone().add(cur.point).multiplyScalar(0.5));
    }
  }
}

/** The label text: the distance, and its vertical and horizontal parts when both exist. */
function labelHtml(a, b) {
  const d = b.clone().sub(a);
  const total = d.length();
  const vertical = Math.abs(d.y);
  const horizontal = Math.hypot(d.x, d.z);
  const parts = vertical > 0.0005 && horizontal > 0.0005
    ? `<small>↕ ${vertical.toFixed(3)} · ↔ ${horizontal.toFixed(3)}</small>` : '';
  return `<b>${formatLength(total)}</b>${parts}`;
}
