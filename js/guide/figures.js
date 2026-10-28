/**
 * Drawings for the User Guide: simplified pictures of the app's own controls,
 * built from a few shapes in the app's colours, with numbered markers that
 * match the steps.
 *
 * Drawn rather than screenshotted so they stay sharp at any width and do not
 * go stale every time a control moves. Colours go through `style` rather than
 * presentation attributes because only `style` resolves CSS variables, which is
 * what keeps the drawings in the app's palette.
 */

import { esc } from '../util/dom.js';

const C = {
  canvas: 'var(--canvas)', panel: 'var(--panel)', panel2: 'var(--panel-2)', border: 'var(--border)',
  text: 'var(--text)', muted: 'var(--text-muted)', dim: 'var(--text-dim)',
  accent: 'var(--accent)', accentDim: 'var(--accent-dim)',
  ok: '#5aa65a', warn: '#d4a13c', danger: '#d16a4f', sel: '#f044c8',
  q1: '#4fa3d1', q2: '#e0a458', q3: '#77b255', grey: '#9aa3ae',
};

// ------------------------------------------------------------------ primitives

const W = 300;
/** Rough width of a label at the drawings' type size. */
const tw = (s, size = 10) => s.length * size * 0.56;

function svg(h, body, label) {
  return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">
    <rect width="${W}" height="${h}" style="fill:${C.canvas}"/>${body}</svg>`;
}
function rect(x, y, w, h, { fill = C.panel, stroke = C.border, r = 3, sw = 1, dash = '' } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"
    style="fill:${fill};stroke:${stroke};stroke-width:${sw}${dash ? `;stroke-dasharray:${dash}` : ''}"/>`;
}
function text(x, y, s, { size = 10, fill = C.text, weight = 400, anchor = 'start', mono = false } = {}) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" style="fill:${fill};font-size:${size}px;font-weight:${weight};${
    mono ? 'font-family:ui-monospace,monospace;' : ''}">${esc(s)}</text>`;
}
/** A small caps section heading, like the panel's own. */
const head = (x, y, s) => text(x, y, s.toUpperCase(), { size: 8, fill: C.dim, weight: 600 });

/** A filter bubble; returns [svg, width]. */
function pill(x, y, label, { active = false, count = null, hot = false } = {}) {
  const w = tw(label, 9) + (count !== null ? tw(String(count), 9) + 5 : 0) + 14;
  return [`${rect(x, y, w, 15, {
    fill: active ? C.accentDim : C.panel2, stroke: active || hot ? C.accent : C.border, r: 7.5, sw: hot ? 1.5 : 1,
  })}${text(x + 7, y + 10.5, label, { size: 9, fill: active ? '#fff' : C.muted })}${
    count !== null ? text(x + w - 7, y + 10.5, String(count), { size: 9, fill: active ? '#d8e8f2' : C.dim, anchor: 'end' }) : ''}`, w];
}
/** A row of bubbles that wraps at the panel edge; returns [svg, positions]. */
function pills(x, y, items, maxX = W - 10) {
  let cx = x;
  let cy = y;
  const out = [];
  const at = [];
  for (const it of items) {
    const [, w] = pill(0, 0, it.label, it);
    if (cx + w > maxX) { cx = x; cy += 20; }
    out.push(pill(cx, cy, it.label, it)[0]);
    at.push({ x: cx, y: cy, w });
    cx += w + 5;
  }
  return [out.join(''), at];
}
function button(x, y, label, { primary = false, hot = false, w = null } = {}) {
  // Never narrower than its label.
  const bw = Math.max(w || 0, tw(label, 9.5) + 16);
  return rect(x, y, bw, 18, { fill: primary ? C.accentDim : C.panel2, stroke: primary || hot ? C.accent : C.border, sw: hot ? 1.5 : 1 }) +
    text(x + bw / 2, y + 12.5, label, { size: 9.5, anchor: 'middle', fill: primary ? '#fff' : C.text });
}
function checkbox(x, y, on = true) {
  return rect(x, y, 10, 10, { fill: on ? C.accent : C.panel2, stroke: on ? C.accent : C.border, r: 2 }) +
    (on ? `<path d="M${x + 2.2} ${y + 5.2}l2.2 2.2 3.6-4.4" style="fill:none;stroke:#fff;stroke-width:1.5"/>` : '');
}
/** A numbered marker matching a step. */
function mark(x, y, n) {
  return `<circle cx="${x}" cy="${y}" r="8" style="fill:${C.accent};stroke:${C.canvas};stroke-width:2"/>` +
    text(x, y + 3.5, String(n), { size: 9.5, weight: 700, anchor: 'middle', fill: '#fff' });
}
/** The mouse pointer, tip at (x, y). */
function cursor(x, y) {
  return `<path d="M${x} ${y}l0 13 3.3-3.1 2.4 5.3 2.2-1-2.4-5.2 4.6-.3z"
    style="fill:#fff;stroke:#111;stroke-width:1;stroke-linejoin:round"/>`;
}
function arrow(x1, y1, x2, y2, colour = C.accent) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = (d) => `${x2 - 6 * Math.cos(a + d)},${y2 - 6 * Math.sin(a + d)}`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${colour};stroke-width:1.5"/>
    <polygon points="${x2},${y2} ${h(0.45)} ${h(-0.45)}" style="fill:${colour}"/>`;
}

/**
 * A box drawn in isometric view, footprint w × d, height h, with its front-left
 * corner on the ground at (x, y). Sides are the top colour darkened.
 */
function iso(x, y, w, d, h, colour) {
  const c = 0.866;
  const s = 0.5;
  const p = (a, b, z) => `${x + (a - b) * c},${y + (a + b) * s * -1 + 0 - z}`;
  // Ground corners: front (0,0), right (w,0), back (w,d), left (0,d) in plan.
  const top = [p(0, 0, h), p(w, 0, h), p(w, d, h), p(0, d, h)].join(' ');
  const right = [p(0, 0, 0), p(w, 0, 0), p(w, 0, h), p(0, 0, h)].join(' ');
  const left = [p(0, 0, 0), p(0, d, 0), p(0, d, h), p(0, 0, h)].join(' ');
  return `<polygon points="${left}" style="fill:${colour};filter:brightness(.62)"/>
    <polygon points="${right}" style="fill:${colour};filter:brightness(.8)"/>
    <polygon points="${top}" style="fill:${colour}"/>`;
}

/**
 * A small building: a slab, walls, a roof and a few doors, each part coloured
 * by `paint` (part name -> colour), grey where unpainted.
 */
function building(x, y, paint = {}, scale = 1) {
  const g = (k) => paint[k] || C.grey;
  const S = (n) => n * scale;
  return `<g>
    ${iso(x, y, S(70), S(50), S(4), paint.slab || '#59616c')}
    ${iso(x, y - S(4), S(70), S(6), S(34), g('wall'))}
    ${iso(x + S(4) * 0.866, y - S(4) - S(4) * 0.5, S(6), S(44), S(34), g('wall2'))}
    ${iso(x + S(22) * 0.866, y - S(4) - S(22) * 0.5 + 0, S(12), S(1), S(20), g('door'))}
    ${iso(x + S(46) * 0.866, y - S(4) - S(46) * 0.5, S(12), S(1), S(20), g('door2'))}
    ${iso(x - S(2) * 0.866, y - S(38), S(74), S(54), S(4), g('roof'))}
  </g>`;
}

/** The colour key card. rows: [{colour, label, n, muted}] */
function colourKey(x, y, w, title, sub, rows, { setValue = false, hot = '' } = {}) {
  const h = 34 + rows.length * 15 + 6;
  let s = rect(x, y, w, h);
  s += text(x + 8, y + 13, title, { size: 9.5, weight: 600 });
  s += text(x + 8, y + 24, sub, { size: 8, fill: C.dim });
  let bx = x + w - 8;
  bx -= tw('Clear', 9.5) + 16;
  s += button(bx, y + 6, 'Clear');
  if (setValue) {
    const sw = tw('Set value…', 9.5) + 16;
    bx -= sw + 5;
    s += button(bx, y + 6, 'Set value…', { hot: hot === 'set' });
  }
  s += `<line x1="${x}" y1="${y + 30}" x2="${x + w}" y2="${y + 30}" style="stroke:${C.border}"/>`;
  rows.forEach((r, i) => {
    const ry = y + 36 + i * 15;
    s += `<g style="opacity:${r.muted ? 0.35 : 1}">${rect(x + 8, ry + 2, 8, 8, { fill: r.colour, stroke: r.colour, r: 1.5 })}
      ${text(x + 22, ry + 9.5, r.label, { size: 9.5 })}${text(x + w - 8, ry + 9.5, String(r.n), { size: 9, fill: C.muted, anchor: 'end' })}</g>`;
  });
  return s;
}

/** The left panel's frame, so a drawing reads as "this part of the panel". */
function panelFrame(x, y, w, h) {
  return rect(x, y, w, h, { fill: C.panel });
}

// --------------------------------------------------------------------- figures

/** A two-button mouse, the named button (left, right, wheel) lit. */
function mouse(x, y, lit) {
  const on = (k) => (k === lit ? C.accent : C.panel2);
  return `<path d="M${x} ${y + 12}a14 14 0 0 1 28 0v14a14 14 0 0 1-28 0z" style="fill:${C.panel2};stroke:${C.border}"/>
    <path d="M${x} ${y + 12}a14 14 0 0 1 14-14v20h-14z" style="fill:${on('left')};stroke:${C.border}"/>
    <path d="M${x + 28} ${y + 12}a14 14 0 0 0-14-14v20h14z" style="fill:${on('right')};stroke:${C.border}"/>
    ${rect(x + 12, y + 2, 4, 9, { fill: on('wheel'), stroke: C.border, r: 2 })}`;
}

/** A labelled input box, as in a form. */
function field(x, y, w, label, value, { dim = false, hot = false } = {}) {
  return text(x, y, label, { size: 8.5, fill: C.muted }) +
    rect(x, y + 4, w, 15, { fill: C.panel2, stroke: hot ? C.accent : C.border, sw: hot ? 1.5 : 1 }) +
    text(x + 5, y + 14.5, value, { size: 9, fill: dim ? C.dim : C.text });
}

const FIGS = {
  // ---- Start here
  'o-layout'() {
    let s = rect(8, 8, 284, 14, { fill: C.panel }) + text(14, 18, 'Add IFC file ▾   Project ▾   Dashboard', { size: 8, fill: C.muted });
    s += rect(8, 26, 10, 116, { fill: C.panel });
    [30, 46, 62, 78, 94].forEach((y) => { s += rect(10, y, 6, 13, { fill: C.panel2, stroke: 'none', r: 1 }); });
    s += rect(20, 26, 78, 116, { fill: C.panel });
    s += text(26, 40, 'The tab you', { size: 8, fill: C.muted }) + text(26, 50, 'picked', { size: 8, fill: C.muted });
    s += rect(102, 30, 10, 76, { fill: C.panel });
    [34, 46, 58, 70, 82, 94].forEach((y) => { s += rect(104, y, 6, 8, { fill: C.panel2, stroke: 'none', r: 1 }); });
    s += building(146, 118, { door: C.sel }, 0.8);
    s += rect(228, 26, 64, 116, { fill: C.panel });
    s += text(234, 40, 'ELEMENT', { size: 7.5, fill: C.dim, weight: 600 });
    s += text(234, 54, 'D-201', { size: 8.5 }) + text(234, 66, 'its details', { size: 8, fill: C.muted });
    s += mark(200, 15, 1) + mark(13, 112, 2) + mark(59, 90, 3) + mark(107, 118, 4) + mark(176, 132, 5) + mark(260, 90, 6);
    return svg(150, s, 'The screen: top bar, tabs, the tab\'s panel, the tool rail, the 3D view and the element panel');
  },

  // ---- Finding your way around
  'f-mouse'() {
    let s = '';
    [['left', 'Drag: turn', 'Click: select'], ['right', 'Drag: slide', 'Click: menu'], ['wheel', 'Roll: zoom', 'Drag: slide']]
      .forEach(([k, a, b], i) => {
        const x = 26 + i * 96;
        s += mouse(x, 16, k);
        s += text(x + 14, 66, a, { size: 9, anchor: 'middle' }) + text(x + 14, 78, b, { size: 8.5, fill: C.muted, anchor: 'middle' });
      });
    return svg(90, s, 'Left drag turns the model, right drag slides it, the wheel zooms; click to select, right-click for a menu');
  },
  'f-rail'() {
    const tools = [['Fit to View', 'whole model'], ['Plan View', 'look down on a level'], ['Show IfcSpaces', 'rooms on / off'],
      ['View Context', 'ghost the rest'], ['Show All', 'undo every hide'], ['Section Cut', 'slice the model'], ['Measure', 'point to point']];
    let s = panelFrame(8, 8, 284, 130);
    tools.forEach(([t, d], i) => {
      const col = i < 4 ? 0 : 1;
      const row = i < 4 ? i : i - 4;
      const x = 16 + col * 140;
      const y = 16 + row * 30;
      s += rect(x, y, 18, 18, { fill: C.panel2, r: 4, stroke: t === 'Show All' ? C.accent : C.border, sw: t === 'Show All' ? 1.5 : 1 });
      s += text(x + 25, y + 8, t, { size: 9, weight: 600 }) + text(x + 25, y + 18, d, { size: 8, fill: C.dim });
    });
    return svg(146, s, 'The tool rail: Fit to View, Plan View, Show IfcSpaces, View Context, Show All, Section Cut and Measure');
  },
  'f-ctx'() {
    let s = building(56, 116, { door: C.sel }, 0.9) + cursor(88, 62);
    s += rect(150, 8, 142, 128);
    s += text(158, 22, 'D-201 Single Leaf', { size: 9, weight: 600 }) + text(158, 32, 'IfcDoor · Level 2', { size: 7.5, fill: C.dim });
    ['Hide element', 'Hide all IfcDoor', 'Isolate element', '—', 'Show properties', '—', 'Show all', 'Fit view'].reduce((y, t) => {
      if (t === '—') {
        s += `<line x1="150" y1="${y - 4}" x2="292" y2="${y - 4}" style="stroke:${C.border}"/>`;
        return y + 4;
      }
      s += text(158, y + 6, t, { size: 9 });
      return y + 13;
    }, 42);
    return svg(144, s, 'Right-click an element for Hide, Isolate, Show properties, Show all and Fit view');
  },

  // ---- Loading and project setup
  'l-load'() {
    let s = rect(8, 8, 284, 20, { fill: C.panel });
    s += button(14, 9, 'Add IFC file ▾', { hot: true }) + mark(98, 10, 1);
    s += rect(14, 32, 186, 64);
    [['Block A.ifc', '412 mapped elements'], ['Block B.ifc', '388 mapped elements · large model']].forEach(([a, b], i) => {
      const y = 36 + i * 22;
      s += text(22, y + 9, '◉', { size: 9, fill: C.accent }) + text(36, y + 9, a, { size: 9 }) + text(36, y + 18, b, { size: 7.5, fill: C.dim });
      s += text(192, y + 11, '×', { size: 10, fill: C.muted, anchor: 'end' });
    });
    s += text(22, 91, '+ Add IFC file', { size: 8.5, fill: C.accent });
    // A file dragged in from outside.
    s += rect(232, 52, 26, 32, { fill: C.panel2, stroke: C.accent, dash: '3 2' }) + text(245, 72, 'IFC', { size: 8, anchor: 'middle', weight: 600 });
    s += arrow(230, 80, 206, 90) + mark(266, 50, 2);
    s += text(150, 112, 'Several files open together as one model.', { size: 8.5, fill: C.muted, anchor: 'middle' });
    return svg(122, s, 'Add IFC file in the top bar lists the open models; or drag a file onto the window');
  },
  'l-project'() {
    let s = rect(8, 8, 284, 160);
    s += text(16, 22, 'PROJECT SETUP', { size: 8, fill: C.dim, weight: 600 });
    s += field(16, 34, 84, 'Project code', '250008') + field(108, 34, 176, 'Name', 'Tampines Ave 9');
    s += text(16, 70, 'Cadastral lot GeoJSON', { size: 8.5, fill: C.muted });
    s += button(16, 74, 'Choose file…', { hot: true }) + text(120, 86, 'MK28-01234V.geojson', { size: 8.5, fill: C.muted });
    s += field(16, 104, 120, 'Submission gateway', 'Construction ▾');
    s += text(150, 104, 'Authorities in scope', { size: 8.5, fill: C.muted });
    s += pills(150, 108, [{ label: 'BCA', active: true }, { label: 'URA', active: true }, { label: 'LTA' }])[0];
    s += button(196, 144, 'Save as…') + button(250, 144, 'Save', { primary: true, w: 36 });
    s += mark(286, 32, 1) + mark(106, 83, 2) + mark(132, 104, 3) + mark(284, 108, 4) + mark(250, 142, 5);
    return svg(176, s, 'Project setup: code and name, the cadastral lot, the gateway, the authorities, then Save');
  },

  // ---- Checking one element
  'e-panel'() {
    let s = rect(8, 8, 284, 140);
    s += text(16, 22, 'ELEMENT', { size: 8, fill: C.dim, weight: 600 });
    s += text(16, 36, 'D-201 Single Leaf', { size: 9.5, weight: 600 }) + button(234, 25, 'Rename', { w: 50 });
    s += text(16, 50, 'IfcDoor · Level 2', { size: 8.5, fill: C.muted });
    s += head(16, 66, 'IFC values');
    const row = (y, colour, label, value, fix) => {
      let r = `<circle cx="20" cy="${y - 3}" r="3.2" style="fill:${colour}"/>` + text(28, y, label, { size: 8.5 });
      r += text(fix ? 196 : 284, y, value, { size: 8.5, fill: C.muted, anchor: 'end' });
      if (fix) r += button(202, y - 12, 'Fix', { w: 30 }) + button(236, y - 12, 'All…', { w: 46 });
      return r;
    };
    s += row(82, C.danger, 'SGPset_Door.FireRating', 'not set', true);
    s += row(100, C.ok, 'SGPset_Door.ClearWidth', '1000', false);
    s += row(118, C.ok, 'SGPset_Door.IsExternal', 'FALSE', false);
    s += head(16, 138, 'Property sets in model ▾');
    s += mark(10, 78, 1) + mark(216, 66, 2) + mark(268, 66, 3);
    return svg(156, s, 'The element panel: each requirement with a pass or fail dot, and Fix or All… on failures');
  },
  'e-fix'() {
    let s = rect(8, 8, 284, 58);
    s += text(16, 22, 'SGPset_Door.FireRating', { size: 8.5, fill: C.muted }) + text(284, 22, 'Type: IfcLabel', { size: 8, fill: C.dim, anchor: 'end' });
    s += rect(16, 28, 150, 18, { fill: C.panel2, stroke: C.accent, sw: 1.5 }) + text(22, 40.5, '60 min', { size: 9.5 }) +
      text(160, 40, '▾', { size: 8, fill: C.muted, anchor: 'end' });
    s += button(174, 28, 'Save', { primary: true, w: 44 }) + button(224, 28, 'Cancel', { w: 52 });
    s += text(16, 60, 'Choices come from the IFC-SG mapping.', { size: 8, fill: C.dim });
    s += mark(166, 26, 1) + mark(218, 26, 2);
    s += rect(26, 76, 248, 26, { stroke: C.warn });
    s += text(36, 92, '1 edit pending', { size: 9.5 });
    s += button(126, 80, 'Discard') + button(184, 80, 'Export IFC', { primary: true });
    s += mark(253, 78, 3);
    return svg(110, s, 'Fix opens a box with the accepted values; Save, then Export IFC writes the corrected file');
  },

  // ---- Dashboard
  'd-cards'() {
    let s = rect(8, 8, 284, 22, { fill: C.panel });
    s += text(14, 22, 'Project Dashboard', { size: 9.5, weight: 600 });
    s += rect(132, 12, 116, 14, { fill: C.panel2, r: 3 }) + rect(132, 12, 40, 14, { fill: C.accentDim, stroke: 'none', r: 3 }) +
      text(152, 22, 'By level', { size: 7.5, anchor: 'middle', fill: '#fff' }) + text(192, 22, 'By file', { size: 7.5, anchor: 'middle', fill: C.muted }) +
      text(228, 22, 'Totals', { size: 7.5, anchor: 'middle', fill: C.muted });
    s += button(254, 11, 'Close', { w: 34 }) + mark(190, 10, 1);
    const card = (x, title, val, unit, flag, flagColour) =>
      rect(x, 38, 136, 92) + text(x + 8, 52, title, { size: 9, weight: 600 }) +
      text(x + 128, 52, flag, { size: 7.5, fill: flagColour, anchor: 'end' }) +
      text(x + 8, 74, val, { size: 15, weight: 600, fill: val === '—' ? C.dim : C.text }) + text(x + 8 + tw(val, 15) + 2, 74, unit, { size: 8, fill: C.muted });
    s += card(8, 'Gross Floor Area', '12,480', 'm²', 'OK', C.ok);
    [['Level 1', '4,210'], ['Level 2', '8,270']].forEach(([a, b], i) => {
      s += text(16, 88 + i * 11, a, { size: 8, fill: C.muted }) + text(136, 88 + i * 11, b + ' m²', { size: 8, anchor: 'end' });
    });
    s += card(156, 'Parking Lots', '—', '', 'Not found', C.warn);
    s += text(164, 92, 'No element matches.', { size: 8, fill: C.muted }) + text(164, 103, 'Open the card for why.', { size: 8, fill: C.muted });
    s += button(16, 106, 'Show in model');
    s += mark(144, 40, 2) + mark(292, 40, 3) + mark(104, 108, 4);
    return svg(138, s, 'Dashboard cards: a total with its breakdown by level, and a card for a quantity not found');
  },

  // ---- CX Queries
  'q-authority'() {
    let s = panelFrame(8, 8, 284, 104);
    s += head(18, 24, 'Authority');
    const [a, at] = pills(18, 30, [
      { label: 'All', count: 158 }, { label: 'BCA', count: 57, active: true }, { label: 'LTA', count: 24 },
      { label: 'NEA', count: 21 }, { label: 'NPARKS', count: 17 }, { label: 'PUB', count: 4 },
    ], 282);
    s += a;
    s += head(18, 82, 'Priority');
    const [p, pt] = pills(18, 88, [{ label: 'All', count: 57 }, { label: 'High', count: 31, active: true }, { label: 'Medium', count: 20 }]);
    s += p;
    s += mark(at[1].x + at[1].w - 2, at[1].y - 1, 1) + cursor(at[1].x + at[1].w / 2, at[1].y + 13);
    s += mark(pt[1].x + pt[1].w - 2, pt[1].y - 1, 2);
    return svg(120, s, 'Authority and priority filter bubbles, with BCA and High chosen');
  },
  'q-component'() {
    let s = panelFrame(8, 8, 150, 124);
    s += head(16, 24, 'Components');
    const [c, ct] = pills(16, 30, [
      { label: 'Door', count: 14 }, { label: 'Roof', count: 2, active: true }, { label: 'Wall', count: 31 },
      { label: 'Staircase', count: 4 }, { label: 'Railing', count: 6 },
    ], 152);
    s += c + mark(ct[1].x + ct[1].w - 2, ct[1].y - 1, 1) + cursor(ct[1].x + ct[1].w / 2, ct[1].y + 13);
    s += building(196, 112, { roof: C.q1 }, 1);
    s += text(226, 128, 'Roof coloured', { size: 8.5, fill: C.muted, anchor: 'middle' });
    return svg(140, s, 'Clicking the Roof component colours the roof in the model');
  },
  'q-property'() {
    let s = panelFrame(8, 8, 150, 124);
    s += head(16, 24, 'Properties · Door');
    const [c, ct] = pills(16, 30, [
      { label: 'FireRating', active: true }, { label: 'Width' }, { label: 'IsExternal' },
    ], 152);
    s += c + mark(ct[0].x + ct[0].w - 2, ct[0].y - 1, 1) + cursor(ct[0].x + ct[0].w / 2, ct[0].y + 13);
    s += text(16, 82, 'Each value gets', { size: 9, fill: C.muted });
    s += text(16, 94, 'its own colour.', { size: 9, fill: C.muted });
    s += text(16, 110, 'Red = not filled in.', { size: 9, fill: C.danger });
    s += building(196, 112, { door: C.q1, door2: C.danger }, 1);
    return svg(140, s, 'Clicking a property colours each door by its value, red where it is missing');
  },
  'q-legend'() {
    let s = colourKey(14, 10, 272, 'FireRating', 'Door · SGPset_Door · 18 elements', [
      { colour: C.q1, label: '60 min', n: 9 }, { colour: C.q2, label: '120 min', n: 5 },
      { colour: C.danger, label: '(not set)', n: 4 },
    ]);
    s += mark(276, 81, 1) + cursor(150, 82);
    s += text(150, 112, 'Click a row to show only that value. Click it again to show all.', { size: 8.5, fill: C.muted, anchor: 'middle' });
    return svg(120, s, 'The colour key lists each value, its colour and how many elements have it');
  },
  'q-setvalue'() {
    let s = colourKey(14, 8, 272, 'FireRating', 'Door · SGPset_Door · 18 elements', [
      { colour: C.danger, label: '(not set)', n: 4 },
    ], { setValue: true, hot: 'set' });
    s += mark(186, 11, 1);
    // The bulk edit row that opens under the key's title.
    s += rect(14, 66, 272, 24);
    s += rect(22, 70, 120, 16, { fill: C.panel2, stroke: C.accent }) + text(28, 81, '60 min', { size: 9.5 }) +
      text(134, 81, '▾', { size: 8, fill: C.muted, anchor: 'end' });
    s += button(148, 69, 'Set on 4', { primary: true }) + button(212, 69, 'Cancel');
    s += mark(150, 68, 2);
    // The edits bar.
    s += rect(26, 102, 248, 26, { stroke: C.warn });
    s += text(36, 118, '4 edits pending', { size: 9.5 });
    s += button(126, 106, 'Discard') + button(184, 106, 'Export IFC', { primary: true });
    s += mark(253, 104, 3);
    return svg(136, s, 'Set value… opens a box to choose the value, then Export IFC saves the edited file');
  },

  // ---- Searching
  's-tree'() {
    let s = panelFrame(8, 8, 284, 112);
    const rows = [
      [0, '▾', 'Block A.ifc', '412'], [1, '▾', 'Level 2', '96'], [2, '▸', 'IfcDoor', '14'],
      [2, '▸', 'IfcWall', '31'], [2, '▸', 'IfcSpace', '18'], [1, '▸', 'Level 3', '88'],
    ];
    rows.forEach(([d, tw_, label, n], i) => {
      const y = 18 + i * 16;
      if (i === 2) s += rect(10, y - 2, 280, 15, { fill: C.panel2, stroke: 'none', r: 2 });
      s += text(18 + d * 14, y + 9, tw_, { size: 8, fill: C.dim }) + text(28 + d * 14, y + 9, label, { size: 9.5 });
      s += text(i === 2 ? 146 : 282, y + 9, n, { size: 8.5, fill: C.dim, anchor: 'end' });
    });
    // Point at a row to get its buttons.
    s += button(152, 47, 'Zoom') + button(193, 47, 'Isolate') + button(250, 47, 'Hide');
    s += mark(14, 42, 1) + mark(219, 40, 2) + cursor(110, 56);
    return svg(128, s, 'The model tree by file, level and class, with Zoom, Isolate and Hide on each row');
  },
  's-search'() {
    let s = panelFrame(8, 8, 284, 118);
    s += rect(16, 16, 268, 18, { fill: C.panel2, stroke: C.accent }) + text(22, 28, 'door level 2', { size: 9.5 });
    s += mark(282, 16, 1);
    s += checkbox(16, 40, false) + text(31, 49, 'Include property values', { size: 9, fill: C.muted });
    s += mark(140, 44, 2);
    s += text(16, 68, '14 results', { size: 8.5, fill: C.dim });
    s += button(141, 58, 'Show in model') + button(231, 58, 'Isolate');
    // The matched words are highlighted, as in the app.
    s += rect(15, 73, 34, 12, { fill: '#6b5a1e', stroke: 'none', r: 1 });
    [['D-201 Single Leaf', 'IfcDoor · Level 2'], ['D-202 Double Leaf', 'IfcDoor · Level 2']].forEach(([a, b], i) => {
      const y = 82 + i * 20;
      s += text(16, y, a, { size: 9.5 }) + text(16, y + 10, b, { size: 8, fill: C.dim });
    });
    s += mark(282, 86, 3) + cursor(110, 86);
    return svg(134, s, 'Typing in the search box lists matching elements; click one to go to it');
  },
  's-result'() {
    let s = building(70, 112, { door: C.sel }, 1.05);
    s += arrow(110, 66, 168, 52);
    s += rect(170, 12, 122, 112);
    s += text(178, 26, 'ELEMENT', { size: 8, fill: C.dim, weight: 600 });
    s += text(178, 42, 'D-201 Single Leaf', { size: 9.5, weight: 600 });
    [['Entity', 'IfcDoor'], ['Storey', 'Level 2'], ['FireRating', '60 min']].forEach(([k, v], i) => {
      const y = 60 + i * 16;
      s += text(178, y, k, { size: 9, fill: C.muted }) + text(284, y, v, { size: 9, anchor: 'end' });
    });
    s += text(178, 112, 'All its properties', { size: 8.5, fill: C.dim });
    s += text(70, 128, 'Selected: magenta', { size: 8.5, fill: C.sel, anchor: 'middle' });
    return svg(134, s, 'The chosen door turns magenta in the model and its details open on the right');
  },

  // ---- Warnings
  'w-list'() {
    let s = panelFrame(8, 8, 284, 112);
    s += rect(16, 16, 62, 15, { fill: '#5a2a22', stroke: 'none', r: 7.5 }) + text(47, 26.5, '2 will fail', { size: 9, fill: '#ffb4a3', anchor: 'middle' });
    s += rect(82, 16, 62, 15, { fill: '#4a3d1e', stroke: 'none', r: 7.5 }) + text(113, 26.5, '1 to review', { size: 9, fill: '#f2cf7a', anchor: 'middle' });
    s += head(16, 46, 'Will fail');
    [['Not georeferenced (no IfcMapConversion)', C.danger], ['2 GlobalIds shared by more than one element', C.danger]]
      .forEach(([t, c], i) => {
        const y = 58 + i * 16;
        s += `<circle cx="20" cy="${y - 3}" r="3" style="fill:${c}"/>` + text(28, y, t, { size: 9 });
      });
    s += head(16, 98, 'Review');
    s += `<circle cx="20" cy="107" r="3" style="fill:${C.warn}"/>` + text(28, 110, 'Geometry is 41.2 km from the file\'s origin', { size: 9 });
    s += mark(272, 52, 1) + mark(272, 102, 2);
    return svg(128, s, 'The Warnings list: problems that will fail first, then ones to review');
  },
  'w-open'() {
    let s = panelFrame(8, 8, 284, 122);
    s += `<circle cx="20" cy="22" r="3" style="fill:${C.warn}"/>` + text(28, 25, 'Geometry is 41.2 km from the file\'s origin', { size: 9, weight: 600 });
    ['Something in the file sits far from the rest —', 'usually a stray element or a linked file left', 'in the wrong place.'].forEach((t, i) => {
      s += text(28, 42 + i * 12, t, { size: 8.5, fill: C.muted });
    });
    s += text(28, 84, 'Related check:', { size: 8.5, fill: C.muted }) + text(92, 84, 'Geo-referencing', { size: 8.5, fill: C.accent });
    s += button(28, 96, 'Show in model', { hot: true }) + button(118, 96, 'Zoom to');
    s += mark(113, 96, 1) + mark(180, 105, 2) + mark(172, 80, 3);
    return svg(138, s, 'An opened warning explains the problem, with Show in model, Zoom to and a related check');
  },
  'w-model'() {
    let s = building(60, 112, {}, 0.9);
    s += `<line x1="128" y1="70" x2="232" y2="40" style="stroke:${C.warn};stroke-width:1;stroke-dasharray:4 3"/>`;
    s += iso(236, 52, 10, 10, 12, C.warn);
    s += text(234, 70, 'stray element', { size: 8.5, fill: C.warn, anchor: 'middle' });
    s += text(180, 112, '41 km away', { size: 9, fill: C.muted, anchor: 'middle' });
    return svg(124, s, 'A stray element far from the building, which Zoom to brings into view');
  },

  // ---- Compliance
  'c-pick'() {
    let s = panelFrame(8, 8, 284, 124);
    s += head(16, 22, 'IFC-SG');
    s += checkbox(16, 28) + text(32, 37, 'IFC values', { size: 9.5 });
    s += checkbox(16, 44) + text(32, 53, 'Space geometry', { size: 9.5 });
    s += head(16, 72, 'URA');
    s += checkbox(16, 78) + text(32, 87, 'Geo-referencing', { size: 9.5 });
    s += text(32, 98, 'Cadastral lot: set in project setup', { size: 8, fill: C.dim });
    s += checkbox(16, 104, false) + text(32, 113, 'URA requirements', { size: 9.5, fill: C.muted });
    s += mark(96, 33, 1);
    s += button(196, 104, 'Run 3 checks', { primary: true, w: 88 }) + mark(284, 104, 2);
    return svg(140, s, 'Tick the checks to run, then press Run');
  },
  'c-score'() {
    let s = panelFrame(8, 8, 284, 74);
    s += rect(16, 16, 268, 6, { fill: C.panel2, stroke: 'none', r: 3 });
    s += rect(16, 16, 102, 6, { fill: C.ok, stroke: 'none', r: 3 }) + rect(116, 16, 168, 6, { fill: C.danger, stroke: 'none', r: 0 });
    s += text(16, 38, '38% of requirements met', { size: 9.5, fill: C.ok, weight: 600 });
    s += text(16, 54, '69 issues', { size: 9.5, fill: C.danger, weight: 600 });
    s += `<line x1="16" y1="57" x2="62" y2="57" style="stroke:${C.danger};stroke-dasharray:1.5 2"/>`;
    s += text(66, 54, '· 20 elements checked', { size: 9.5, fill: C.muted });
    s += mark(152, 34, 1) + mark(190, 50, 2) + cursor(40, 50);
    s += text(16, 74, 'Point at the % to see what it counts.', { size: 8, fill: C.dim });
    return svg(90, s, 'The score line: share of requirements met, the number of issues, and elements checked');
  },
  'c-results'() {
    let s = panelFrame(8, 8, 156, 118);
    [['Roof', 'BCA · IfcRoof · 2', 2], ['Staircase', 'BCA · IfcStairFlight · 4', 8], ['Site', 'URA · IfcSite · 1', 1]].forEach(([a, b, n], i) => {
      const y = 16 + i * 30;
      if (i === 0) s += rect(10, y - 4, 152, 28, { fill: C.panel2, stroke: C.accent, r: 2 });
      s += text(16, y + 8, a, { size: 9.5, weight: 600 }) + text(16, y + 19, b, { size: 8, fill: C.dim });
      s += rect(140, y + 2, 16, 12, { fill: '#5a2a22', stroke: 'none', r: 6 }) + text(148, y + 11, String(n), { size: 8.5, fill: '#ffb4a3', anchor: 'middle' });
    });
    s += mark(160, 14, 1) + cursor(90, 28);
    s += building(200, 112, { roof: C.danger, wall: C.ok, wall2: C.ok }, 0.95);
    s += text(232, 128, 'green passes · red fails', { size: 8, fill: C.muted, anchor: 'middle' });
    return svg(134, s, 'Clicking a result colours its elements green where they pass and red where they fail');
  },
  'c-stale'() {
    let s = rect(8, 10, 284, 30, { fill: '#4a3d1e', stroke: 'none' });
    s += text(16, 23, 'Out of date. The model has been edited', { size: 9, fill: '#f2cf7a', weight: 600 });
    s += text(16, 34, 'since these checks ran.', { size: 9, fill: '#f2cf7a' });
    s += button(232, 16, 'Re-run', { primary: true, w: 52 }) + mark(284, 14, 1);
    s += button(8, 52, 'Colour') + button(62, 52, 'To BCF') + button(116, 52, 'PDF report', { hot: true });
    s += mark(56, 50, 2) + mark(110, 50, 3) + mark(185, 50, 4);
    return svg(80, s, 'An out-of-date note with Re-run, and the Colour, To BCF and PDF report buttons');
  },

  // ---- Issues
  'i-flow'() {
    const box = (x, label, sub) => rect(x, 30, 84, 44) + text(x + 42, 50, label, { size: 9.5, weight: 600, anchor: 'middle' }) +
      text(x + 42, 63, sub, { size: 8, fill: C.dim, anchor: 'middle' });
    let s = box(8, 'RSP CX Radar', 'raise & review');
    s += rect(118, 36, 64, 32, { fill: C.panel2, stroke: C.accent, dash: '3 2' }) + text(150, 50, '.bcf file', { size: 9.5, anchor: 'middle' }) +
      text(150, 61, 'issues + views', { size: 7.5, fill: C.dim, anchor: 'middle' });
    s += box(208, 'Revit · ACC', 'Model Checker');
    s += arrow(94, 46, 116, 46) + arrow(182, 46, 206, 46) + arrow(206, 60, 184, 60) + arrow(116, 60, 94, 60);
    s += text(150, 92, 'Everyone opens the same issues, at the same view.', { size: 8.5, fill: C.muted, anchor: 'middle' });
    return svg(102, s, 'BCF files carry issues between RSP CX Radar, Revit and the CORENET X Model Checker');
  },
  'i-actions'() {
    let s = panelFrame(8, 8, 284, 58);
    s += button(16, 16, 'Import BCF…') + button(95, 16, 'New topic') + button(215, 16, 'Export BCF', { primary: true });
    s += text(16, 52, 'Author', { size: 9, fill: C.muted }) + rect(52, 42, 232, 16, { fill: C.panel2 }) + text(58, 53, 'Your name', { size: 9, fill: C.dim });
    s += mark(90, 14, 1) + mark(159, 14, 2) + mark(284, 14, 4) + mark(284, 42, 3);
    return svg(74, s, 'The Issues tab buttons: Import BCF, New topic, Export BCF, and your name as author');
  },
  'i-new'() {
    let s = building(56, 112, { door: C.sel }, 0.85);
    s += rect(130, 8, 162, 128);
    s += text(138, 22, 'New topic on D-201', { size: 9.5, weight: 600 });
    const field = (y, k, v) => text(138, y + 10, k, { size: 8.5, fill: C.muted }) + rect(178, y, 106, 15, { fill: C.panel2 }) + text(183, y + 10.5, v, { size: 8.5, fill: v === '…' ? C.dim : C.text });
    s += field(30, 'Title', 'Fire rating missing') + field(50, 'Type', 'Issue ▾') + field(70, 'Details', '…');
    s += text(138, 96, '1 element attached, with', { size: 8, fill: C.dim }) + text(138, 105, 'a snapshot of the view.', { size: 8, fill: C.dim });
    s += button(186, 114, 'Create', { primary: true }) + button(238, 114, 'Cancel');
    s += mark(58, 40, 1) + mark(290, 34, 2) + mark(232, 113, 3);
    return svg(144, s, 'Select an element, then New topic: give it a title and press Create');
  },
  'i-topic'() {
    let s = panelFrame(8, 8, 284, 124);
    s += text(16, 22, 'Fire rating missing', { size: 9.5, weight: 600 });
    const field = (y, k, v) => text(16, y + 10, k, { size: 8.5, fill: C.muted }) + rect(70, y, 140, 15, { fill: C.panel2 }) + text(75, y + 10.5, v, { size: 8.5 });
    s += field(30, 'Status', 'Active ▾') + field(50, 'Assigned', 'jane@studio.sg');
    s += rect(16, 72, 268, 22, { fill: C.panel2, stroke: C.border }) + text(22, 86, 'Updated in Revit, please re-check', { size: 8.5, fill: C.muted });
    s += button(16, 102, 'Show in model') + button(106, 102, 'Comment', { hot: true });
    s += mark(212, 36, 1) + mark(284, 74, 2) + mark(160, 100, 3);
    return svg(140, s, 'A topic: set its status and who it is assigned to, add comments, and show it in the model');
  },
};

/** The drawing named `id`, as an SVG string, or nothing if there is none. */
export function figure(id) {
  const f = FIGS[id];
  return f ? f() : '';
}
