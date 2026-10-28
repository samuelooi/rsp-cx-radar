/**
 * The User Guide tab: step-by-step guides, each step with a small drawing of
 * the controls it uses and a "Show me" that points at the real one.
 *
 * The guide never touches the app's state itself. Everything it wants to do —
 * switch tab, light up a control — goes through the `api` handed to
 * renderGuide, so the shell stays the only thing that drives the UI.
 */

import { SECTIONS } from './content.js';
import { figure } from './figures.js';
import { esc } from '../util/dom.js';

/** Which guides are open, kept across re-renders and visits to the tab. */
const open = new Set();
let query = '';
/** A guide to bring into view on the next render, set by a tab's "?" link. */
let focusId = null;

/** Opens one guide, on its own, ready for the next renderGuide. */
export function focusGuide(id) {
  open.clear();
  open.add(id);
  query = '';
  focusId = id;
}

/**
 * The guide's own light markup, applied after escaping: **bold**, and [[Name]]
 * for the label of a real control, drawn like a key cap so it can be spotted
 * on screen.
 */
const rich = (s) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/\[\[(.+?)\]\]/g, '<span class="g-ui">$1</span>');

/** Every word a search should find a guide by. */
function haystack(s) {
  return [s.title, s.summary, s.intro, s.keywords || '',
    ...s.steps.flatMap((st) => [st.title, st.text]),
    ...(s.trouble || []).flatMap((t) => [t.q, t.a])].join(' ').toLowerCase();
}

function matches(s) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = haystack(s);
  return words.every((w) => text.includes(w));
}

function renderStep(sectionId, step, i) {
  return `
    <li class="g-step">
      <div class="g-step-head">
        <span class="g-num">${i + 1}</span>
        <span class="g-step-title">${rich(step.title)}</span>
        ${step.show ? `<button class="g-show" data-show="${esc(sectionId)}:${i}"
          title="Go to this control and highlight it">Show me</button>` : ''}
      </div>
      <div class="g-step-text">${rich(step.text)}</div>
      ${step.fig ? `<div class="g-fig">${figure(step.fig)}</div>` : ''}
    </li>`;
}

function renderSection(s, n) {
  const isOpen = open.has(s.id) || !!query;
  return `
    <section class="g-card${isOpen ? ' open' : ''}" data-id="${esc(s.id)}">
      <button class="g-card-head" aria-expanded="${isOpen}">
        <span class="g-badge">${n}</span>
        <span class="g-card-title">${esc(s.title)}<small>${esc(s.summary)}</small></span>
        <span class="g-chev">&#9656;</span>
      </button>
      <div class="g-card-body">
        <p class="g-intro">${rich(s.intro)}</p>
        ${s.needs ? `<p class="g-needs"><b>You need:</b> ${rich(s.needs)}</p>` : ''}
        ${s.steps.length ? `<ol class="g-steps">${s.steps.map((st, i) => renderStep(s.id, st, i)).join('')}</ol>` : ''}
        ${s.result ? `<div class="g-result"><b>What you'll see</b>${rich(s.result)}</div>` : ''}
        ${s.trouble && s.trouble.length ? `<div class="g-trouble"><b>If it doesn't work</b>
          <dl>${s.trouble.map((t) => `<dt>${rich(t.q)}</dt><dd>${rich(t.a)}</dd>`).join('')}</dl></div>` : ''}
      </div>
    </section>`;
}

/**
 * Draws the guide into `host`.
 * @param {HTMLElement} host
 * @param {{ showMe: (show: {tab?: string, target: string, hint?: string}) => void }} api
 */
export function renderGuide(host, api) {
  if (!host.querySelector('.g-search')) {
    host.innerHTML = `
      <div class="g-top">
        <input type="search" class="g-search" placeholder="Search the guide…" />
      </div>
      <div class="scroll g-list"></div>`;
    host.querySelector('.g-search').addEventListener('input', (e) => {
      query = e.target.value.trim();
      renderList(host, api);
    });
  }
  host.querySelector('.g-search').value = query;
  renderList(host, api);
  if (focusId) {
    const card = host.querySelector(`.g-card[data-id="${focusId}"]`);
    if (card) card.scrollIntoView({ block: 'start' });
    focusId = null;
  }
}

function renderList(host, api) {
  const list = host.querySelector('.g-list');
  const shown = SECTIONS.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => matches(s));
  list.innerHTML = shown.length
    ? shown.map(({ s, n }) => renderSection(s, n)).join('')
    : `<div class="empty-note">No guide mentions “${esc(query)}”. Try a shorter word.</div>`;

  list.querySelectorAll('.g-card-head').forEach((head) => {
    head.addEventListener('click', () => {
      const card = head.closest('.g-card');
      const isOpen = card.classList.toggle('open');
      head.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) open.add(card.dataset.id);
      else open.delete(card.dataset.id);
    });
  });
  list.querySelectorAll('[data-show]').forEach((b) => {
    b.addEventListener('click', () => {
      const [id, i] = b.dataset.show.split(':');
      const step = SECTIONS.find((s) => s.id === id).steps[+i];
      api.showMe(step.show);
    });
  });
}
