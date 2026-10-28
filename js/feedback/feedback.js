/**
 * The Feedback tab: bug reports, ideas and questions, filed as GitHub issues
 * on the app's repository.
 *
 * The app has no server and holds no GitHub token, so it never posts anything
 * itself. It writes the report and opens GitHub's own "new issue" page with it
 * filled in; the reader signs in there and submits. Anyone without a GitHub
 * account copies the same report instead and sends it on.
 *
 * Reports carry the app's state (models loaded, checks run, recent errors) so
 * a bug can be reproduced. File and project names stay out unless the reader
 * ticks them in, since a submission's name can be confidential.
 */

import { esc } from '../util/dom.js';

const REPO = 'samuelooi/rsp-cx-radar';
const NEW_ISSUE = `https://github.com/${REPO}/issues/new`;
/** GitHub turns away very long URLs; the report is trimmed to stay under this. */
const MAX_URL = 7500;

const KINDS = {
  bug: { label: 'Bug', template: 'bug_report.md', tag: 'bug',
    what: 'What happened?', whatHint: 'What you did, and what went wrong' },
  idea: { label: 'Idea', template: 'idea.md', tag: 'enhancement',
    what: 'What would help?', whatHint: 'What you are trying to do, and what would make it easier' },
  question: { label: 'Question', template: 'question.md', tag: 'question',
    what: 'Your question', whatHint: 'What you want to know' },
};

/** The report being written, kept across visits to the tab. */
const draft = { kind: 'bug', title: '', what: '', expected: '', steps: '', details: true, names: false };

// ------------------------------------------------------------- error log

/** The last few errors the app hit, attached to bug reports. */
const errors = [];

function logError(message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return;
  const last = errors[errors.length - 1];
  if (last && last.text === text) { last.n++; return; }
  errors.push({ at: new Date(), text, n: 1 });
  if (errors.length > 8) errors.shift();
}

function describe(arg) {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg).slice(0, 200); } catch { return String(arg); }
  }
  return String(arg);
}

/**
 * Starts recording errors: uncaught ones, and the ones the app catches and
 * reports with console.error. Call once, as early as possible.
 */
export function installErrorLog() {
  window.addEventListener('error', (e) => logError(e.error ? describe(e.error) : e.message));
  window.addEventListener('unhandledrejection', (e) => logError(describe(e.reason)));
  const original = console.error.bind(console);
  console.error = (...args) => {
    logError(args.map(describe).join(' '));
    original(...args);
  };
}

// ----------------------------------------------------------------- report

function browserName() {
  const ua = navigator.userAgent;
  const m = ua.match(/Edg\/(\d+)/) ? ['Edge', ua.match(/Edg\/(\d+)/)[1]]
    : ua.match(/Chrome\/(\d+)/) ? ['Chrome', ua.match(/Chrome\/(\d+)/)[1]]
      : ua.match(/Firefox\/(\d+)/) ? ['Firefox', ua.match(/Firefox\/(\d+)/)[1]]
        : ua.match(/Version\/(\d+).*Safari/) ? ['Safari', ua.match(/Version\/(\d+)/)[1]] : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  return `${m ? m.join(' ') : 'unknown browser'} on ${os}`;
}

/** The app details attached to a report, as [label, value] rows. */
function details(api) {
  const rows = [
    ['Browser', browserName()],
    ['Window', `${innerWidth} × ${innerHeight} at ${devicePixelRatio}×`],
    ...api.context({ names: draft.names }),
  ];
  if (errors.length) {
    rows.push(['Recent errors', errors.map((e) =>
      `${e.at.toTimeString().slice(0, 8)} ${e.text}${e.n > 1 ? ` (×${e.n})` : ''}`).join('\n')]);
  }
  return rows;
}

function detailsText(api) {
  return details(api).map(([k, v]) => v.includes('\n')
    ? `- **${k}:**\n${v.split('\n').map((l) => `  - ${l}`).join('\n')}`
    : `- **${k}:** ${v}`).join('\n');
}

function reportBody(api, { trimDetails = false } = {}) {
  const k = KINDS[draft.kind];
  const parts = [`### ${k.what}\n\n${draft.what || '_Not given_'}`];
  if (draft.kind === 'bug') {
    parts.push(`### What I expected\n\n${draft.expected || '_Not given_'}`);
    if (draft.steps) parts.push(`### Steps to make it happen again\n\n${draft.steps}`);
  }
  if (draft.details) {
    parts.push(`### App details\n\n${trimDetails
      ? '_Too long to fit in the link. The reporter can paste them from "Copy report"._'
      : detailsText(api)}`);
  }
  parts.push('_Sent from the Feedback tab in RSP CX Radar._');
  return parts.join('\n\n');
}

function issueUrl(api) {
  const k = KINDS[draft.kind];
  const url = (body) => `${NEW_ISSUE}?${new URLSearchParams({
    template: k.template, labels: k.tag, title: draft.title, body,
  })}`;
  const full = url(reportBody(api));
  return full.length <= MAX_URL ? full : url(reportBody(api, { trimDetails: true }));
}

function plainReport(api) {
  return `[${KINDS[draft.kind].label}] ${draft.title}\n\n${reportBody(api)}`;
}

// ---------------------------------------------------------- recent reports

let recent = null; // null: not asked yet; a Promise while loading; then {items} or {error}

function loadRecent() {
  if (!recent) {
    recent = fetch(`https://api.github.com/repos/${REPO}/issues?state=all&sort=updated&per_page=10`,
      { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub answered ${r.status}`))))
      .then((list) => ({ items: list.filter((i) => !i.pull_request).slice(0, 8) }))
      .catch((err) => ({ error: err.message }));
  }
  return recent;
}

function renderRecent(box) {
  box.innerHTML = '<div class="fb-muted">Loading…</div>';
  loadRecent().then((r) => {
    if (r.error) {
      box.innerHTML = `<div class="fb-muted">Could not reach GitHub (${esc(r.error)}).
        <a href="https://github.com/${REPO}/issues" target="_blank" rel="noopener">Open the list on GitHub</a>.</div>`;
      return;
    }
    box.innerHTML = r.items.length
      ? r.items.map((i) => `
        <a class="fb-issue" href="${esc(String(i.html_url).startsWith('https://github.com/') ? i.html_url : '#')}"
           target="_blank" rel="noopener">
          <span class="fb-state ${i.state === 'open' ? 'open' : 'closed'}">${i.state === 'open' ? 'Open' : 'Done'}</span>
          <span class="fb-ititle">${esc(i.title)}<small>#${i.number}${i.labels.length
            ? ' · ' + esc(i.labels.map((l) => l.name).join(', ')) : ''}</small></span>
        </a>`).join('') +
        `<a class="fb-all" href="https://github.com/${REPO}/issues" target="_blank" rel="noopener">See all on GitHub</a>`
      : '<div class="fb-muted">No reports yet. Yours could be the first.</div>';
  });
}

// ------------------------------------------------------------------- tab

/**
 * Draws the Feedback tab into `host`.
 * @param {HTMLElement} host
 * @param {{ context: (o: {names: boolean}) => [string, string][], toast: (msg: string) => void }} api
 */
export function renderFeedback(host, api) {
  const k = KINDS[draft.kind];
  host.innerHTML = `
    <div class="scroll fb">
      <p class="fb-intro">Found a bug, or have an idea? Reports go to the app's
        <b>issue list on GitHub</b>, where you can follow what happens to them.</p>

      <div class="fb-kinds">${Object.entries(KINDS).map(([id, kk]) =>
        `<button class="bubble${id === draft.kind ? ' active' : ''}" data-kind="${id}">${kk.label}</button>`).join('')}
      </div>

      <label class="fb-field"><span>Title</span>
        <input data-f="title" maxlength="120" placeholder="One line, e.g. Set value… does nothing on walls" /></label>
      <label class="fb-field"><span>${esc(k.what)}</span>
        <textarea data-f="what" rows="4" placeholder="${esc(k.whatHint)}"></textarea></label>
      ${draft.kind === 'bug' ? `
      <label class="fb-field"><span>What did you expect?</span>
        <textarea data-f="expected" rows="2"></textarea></label>
      <label class="fb-field"><span>Steps to make it happen again <small>optional</small></span>
        <textarea data-f="steps" rows="3" placeholder="1. Load the model&#10;2. …"></textarea></label>` : ''}

      <label class="fb-check"><input type="checkbox" data-f="details" /> Attach app details
        <small>browser, models loaded, checks run, recent errors</small></label>
      <label class="fb-check fb-sub"><input type="checkbox" data-f="names" /> Include file and project names
        <small>off by default, as they can be confidential</small></label>
      <details class="fb-preview"><summary>See exactly what is attached</summary><pre></pre></details>

      <div class="fb-actions">
        <button class="btn primary" data-act="github">Open on GitHub…</button>
        <button class="btn" data-act="copy">Copy report</button>
        <span class="spacer"></span>
        <button class="link-btn" data-act="clear">Clear</button>
      </div>
      <p class="fb-muted">GitHub opens in a new tab with the report filled in: sign in and press
        <b>Create</b>. No GitHub account? Press <b>Copy report</b> and send it to whoever looks after the app.</p>

      <div class="fb-head">Recent reports</div>
      <div class="fb-recent"></div>
    </div>`;

  const field = (f) => host.querySelector(`[data-f="${f}"]`);
  const preview = host.querySelector('.fb-preview pre');
  const github = host.querySelector('[data-act="github"]');
  const sync = () => {
    preview.textContent = draft.details ? detailsText(api) : 'Nothing: app details are off.';
    field('names').disabled = !draft.details;
    github.disabled = !draft.title.trim();
    github.title = github.disabled ? 'Give the report a title first' : '';
  };

  for (const f of ['title', 'what', 'expected', 'steps']) {
    const box = field(f);
    if (!box) continue;
    box.value = draft[f];
    box.addEventListener('input', () => { draft[f] = box.value; if (f === 'title') sync(); });
  }
  for (const f of ['details', 'names']) {
    field(f).checked = draft[f];
    field(f).addEventListener('change', () => { draft[f] = field(f).checked; sync(); });
  }
  host.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
    draft.kind = b.dataset.kind;
    renderFeedback(host, api);
  }));
  // Rebuilt on open, so the details describe the app as it is now.
  host.querySelector('.fb-preview').addEventListener('toggle', sync);

  github.addEventListener('click', () => {
    window.open(issueUrl(api), '_blank', 'noopener');
    api.toast('Finish on GitHub: check the report, then press Create.');
  });
  host.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(plainReport(api));
      api.toast('Report copied. Paste it into an email or chat.');
    } catch {
      api.toast('Could not copy. Open "See exactly what is attached" and copy it from there.');
    }
  });
  host.querySelector('[data-act="clear"]').addEventListener('click', () => {
    Object.assign(draft, { title: '', what: '', expected: '', steps: '' });
    renderFeedback(host, api);
  });

  sync();
  renderRecent(host.querySelector('.fb-recent'));
}
