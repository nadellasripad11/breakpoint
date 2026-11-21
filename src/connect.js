import './connect.css';
import gsap from 'gsap';
import { deriveMapping } from './notionMapping.js';
import { api, apiEnabled, ensureSchedule, ensureSession, peekSession, completeSignIn, currentUser, savePreferences, friendlyError, returnError } from './api.js';

/**
 * The connector sheet: a small modal over the onboarding "Connect" step.
 *   .ics file     -> pick a file, preview what would be imported, import
 *   Google        -> sign in (guests) -> explicit read-only consent -> pick a calendar -> preview -> import
 *   Notion        -> sign in (guests) -> paste a read-only integration token -> pick a database -> preview -> import
 * Everything that comes from outside (calendar names, event titles, errors) is inserted with textContent only.
 * Nothing is ever written back to Google, Notion or the file: the API only reads, and says so.
 */

// the URL as it was when the page loaded, before anything cleans it (a redirect back from Google carries the result here)
const LANDED = { search: location.search, hash: location.hash };

const $ = (s, r = document) => r.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const PREVIEW_MSG = 'Connectors switch on once the Breakpoint server is connected to this site.';

/** Tiny DOM builder. Strings become text nodes, never HTML. */
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(2)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const icon = (id, cls = '') => {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', `ico ${cls}`.trim());
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', `#${id}`);
  s.append(u);
  return s;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const parts = (xs) => xs.map((x) => (Array.isArray(x) ? h('em', {}, x[1]) : x));

const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
function fmtWhen(it) {
  const d = new Date(it.start);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (it.allDay) return `${day} · all day`;
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${t} · ${fmtDur(it.durationMin)}`;
}
function fmtItem(it) {
  if (it.start) return fmtWhen(it);
  if (it.deadline) {
    const d = new Date(it.deadline);
    return `Due ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtDur(it.durationMin)}`;
  }
  return `Task · ${fmtDur(it.durationMin)}`;
}

function cleanLandedUrl() {
  const q = new URLSearchParams(location.search);
  ['ob', 'connected', 'auth_error', 'connect_error'].forEach((k) => q.delete(k));
  const s = q.toString();
  try { history.replaceState(null, '', location.pathname + (s ? `?${s}` : '')); } catch { /* ignore */ }
}

/** Did we just come back from Google? (?ob=… from sign-in/consent, or ?auth_error / ?connect_error from a refusal) */
export function readReturn() {
  const q = new URLSearchParams(LANDED.search);
  const ob = q.get('ob');
  const authErr = q.get('auth_error');
  const connErr = q.get('connect_error');
  if (!ob && !authErr && !connErr) return null;
  return { source: ob === 'notion' ? 'notion' : 'google', hasCode: /bp_code=/.test(LANDED.hash), connected: q.get('connected'), error: authErr || connErr || null };
}

export function initConnect({ ob, say, reduce, persist }) {
  const sheet = $('#sheet', ob);
  const card = $('.sheet__card', sheet);
  const scrim = $('.sheet__scrim', sheet);
  const bodyEl = $('#sheet-body', sheet);
  const frame = $('.ob__frame', ob);

  let caps = null;
  let online = false;
  let resolveFlow = null;
  let returnFocus = null;
  let token = 0; // bumped by every render: late answers from an old view are ignored
  let inFlight = false;
  let msgEl = null;
  let shown = false;

  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); }); // back button from Google

  /* ───────── sheet shell ───────── */
  function showSheet() {
    returnFocus = document.activeElement;
    sheet.hidden = false;
    frame.inert = true;
    shown = false;
    if (!reduce) {
      gsap.fromTo(scrim, { opacity: 0 }, { opacity: 1, duration: 0.3, clearProps: 'all' });
      gsap.fromTo(card, { y: 30, opacity: 0, scale: 0.98 }, { y: 0, opacity: 1, scale: 1, duration: 0.6, ease: 'expo.out', clearProps: 'all' });
    }
  }
  function hideSheet() {
    return new Promise((res) => {
      const end = () => {
        sheet.hidden = true;
        frame.inert = false;
        bodyEl.replaceChildren();
        gsap.set([scrim, card], { clearProps: 'all' });
        returnFocus && returnFocus.focus && returnFocus.focus({ preventScroll: true });
        res();
      };
      if (reduce) return end();
      gsap.to(card, { y: 18, opacity: 0, duration: 0.24, ease: 'power2.in' });
      gsap.to(scrim, { opacity: 0, duration: 0.28, onComplete: end });
    });
  }
  function openFlow() {
    showSheet();
    return new Promise((res) => { resolveFlow = res; });
  }
  async function finish(result) {
    if (!resolveFlow) return;
    const r = resolveFlow;
    resolveFlow = null;
    token++;
    await hideSheet();
    r(result);
  }
  const cancel = () => { if (!inFlight) finish({ advance: false }); };
  $$all('[data-sheet-close]', sheet).forEach((b) => b.addEventListener('click', cancel));
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (e.key !== 'Tab') return;
    e.stopPropagation();
    const f = $$all('button, [href], input, select, [tabindex]:not([tabindex="-1"])', card).filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === card || document.activeElement.id === 'sheet-title')) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ───────── view rendering ───────── */
  const setMsg = (text, tone = 'err') => {
    if (!msgEl) return;
    msgEl.className = `sh__msg sh__msg--${tone}`;
    msgEl.textContent = text || '';
    msgEl.hidden = !text;
    // on a short screen the message can sit below the fold of the card; bring it into view
    if (text && tone === 'err') requestAnimationFrame(() => msgEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  /**
   * view = { ico, title: [string | ['em', string]], sub, body: Node[], actions: Node[], foot, note: {text, tone}, focus }
   * Returns nothing; use setMsg() for errors afterwards.
   */
  function render(view) {
    token++;
    msgEl = h('p', { class: 'sh__msg', role: 'alert', hidden: true });
    const kids = [
      view.ico && h('div', { class: 'sh__badge' }, view.ico),
      h('h2', { class: 'sh__title', id: 'sheet-title', tabindex: '-1' }, parts(view.title)),
      view.sub && h('p', { class: 'sh__sub' }, view.sub),
      ...(view.body || []),
      msgEl,
      // the buttons stay in view while a long list scrolls
      h('div', { class: 'sh__bar' },
        view.actions && h('div', { class: 'sh__actions' }, view.actions),
        view.foot && h('p', { class: 'sh__foot' }, icon('i-lock', 'sh__lock'), h('span', {}, view.foot)),
      ),
    ];
    bodyEl.replaceChildren(...kids.filter(Boolean));
    bodyEl.scrollTop = 0;
    if (view.note) setMsg(view.note.text, view.note.tone || 'err');
    if (shown && !reduce) gsap.fromTo(bodyEl, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out', clearProps: 'all' });
    shown = true;
    const target = view.focus || $('#sheet-title', bodyEl);
    setTimeout(() => target && target.focus && target.focus({ preventScroll: true }), reduce ? 0 : 60);
  }

  const primary = (label, onClick, { arrow = true } = {}) =>
    h('button', { class: 'btn btn--cream ob__btn sh__primary', type: 'button', onclick: (e) => onClick(e.currentTarget) }, h('span', {}, label), arrow && icon('i-arrow'));
  const ghost = (label, onClick) => h('button', { class: 'sh__ghost', type: 'button', onclick: (e) => onClick(e.currentTarget) }, label);

  /** Disables a button while an async step runs, shows a spinner, and puts any error in the sheet. */
  async function run(btn, busyLabel, fn) {
    if (btn.disabled) return;
    const t = token;
    const span = btn.querySelector('span');
    const label = span ? span.textContent : '';
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    if (span && busyLabel) span.textContent = busyLabel;
    inFlight = true;
    setMsg('');
    try {
      await fn();
    } catch (e) {
      if (t === token) setMsg(friendlyError(e));
    } finally {
      inFlight = false;
      if (t === token) {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        if (span) span.textContent = label;
      }
    }
  }

  function loading(title, sub) {
    render({ title, sub, body: [h('div', { class: 'sh__wait', role: 'status' }, h('i', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, 'One moment…'))] });
  }

  function radioList(items, { label, cls = '', initial, onChange }) {
    let cur = null;
    const root = h('div', { class: `pick ${cls}`.trim(), role: 'radiogroup', 'aria-label': label });
    const rows = items.map((it) =>
      h('button', { type: 'button', class: 'pick__row', role: 'radio', 'aria-checked': 'false', 'data-v': it.value, onclick: () => set(it.value) },
        h('span', { class: 'pick__radio', 'aria-hidden': 'true' }),
        h('span', { class: 'pick__txt' }, h('b', {}, it.title), it.meta ? h('span', {}, it.meta) : null),
        it.tag ? h('i', { class: 'pick__tag' }, it.tag) : null,
      ),
    );
    const paint = (v, focus = false) => {
      cur = v;
      rows.forEach((r) => { const on = r.dataset.v === v; r.classList.toggle('is-on', on); r.setAttribute('aria-checked', String(on)); r.tabIndex = on ? 0 : -1; if (on && focus) r.focus(); });
    };
    const set = (v, focus = false) => { paint(v, focus); onChange && onChange(v); };
    rows.forEach((r, i) => r.addEventListener('keydown', (e) => {
      const k = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!k) return;
      e.preventDefault();
      set(rows[(i + k + rows.length) % rows.length].dataset.v, true);
    }));
    root.append(...rows);
    paint(initial ?? items[0]?.value); // the first paint is silent: callers read .value after building
    return { el: root, get value() { return cur; } };
  }

  /* ───────── shared: preview -> import ───────── */
  function viewPreview({ label, dry, back, commit, noun }) {
    const n = dry.wouldImport;
    const rows = dry.preview.slice(0, 5);
    const list = h('ul', { class: 'prev' }, rows.map((it) => h('li', {}, h('b', {}, it.title), h('span', {}, fmtItem(it)))));
    const more = n > rows.length ? h('p', { class: 'prev__more' }, `…and ${n - rows.length} more`) : null;
    const extras = [];
    if (dry.skipped) extras.push(`${plural(dry.skipped, 'item')} skipped (cancelled, finished or unreadable).`);
    (dry.warnings || []).slice(0, 2).forEach((w) => extras.push(w));
    render({
      title: n ? ['We found ', ['em', plural(n, noun)]] : ['Nothing to ', ['em', 'import']],
      sub: n ? `From ${label}. Here’s a peek before anything is saved.` : `We looked through ${label} and found nothing to bring in.`,
      body: [n ? list : null, more, extras.length ? h('ul', { class: 'prev__x' }, extras.map((x) => h('li', {}, x))) : null],
      actions: [
        ghost('Back', back),
        n ? primary(`Import ${plural(n, noun)}`, (btn) => run(btn, 'Importing…', async () => {
          const res = await commit();
          const done = (res.imported?.created || 0) + (res.imported?.updated || 0);
          await finish({ advance: true, imported: { ...res.imported, total: done, label, noun } });
        })) : null,
      ],
      foot: 'A read-only copy. Breakpoint never changes the original.',
    });
  }

  /* ───────── .ics ───────── */
  function viewIcs(note) {
    let allDay = false;
    const status = h('p', { class: 'drop__wait', role: 'status', hidden: true }, h('i', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, 'Reading your file…'));
    const input = h('input', { type: 'file', accept: '.ics,text/calendar', class: 'drop__input', 'aria-label': 'Choose an .ics file' });
    const zone = h('label', { class: 'drop' }, input, icon('i-cal-edit', 'drop__ico'),
      h('span', { class: 'drop__t' }, 'Drop an .ics file here or ', h('b', {}, 'browse')),
      h('span', { class: 'drop__s' }, 'Exports from Google, Apple Calendar and Outlook all work. Up to 2 MB.'),
    );
    const chk = h('input', { type: 'checkbox', class: 'chk__box', onchange: (e) => { allDay = e.currentTarget.checked; } });
    const handle = async (file) => {
      if (!file || inFlight) return;
      if (!/\.ics$/i.test(file.name) && !/calendar/i.test(file.type)) return setMsg('That doesn’t look like an .ics file. Export your calendar as .ics and try again.');
      if (file.size > 2 * 1024 * 1024) return setMsg('That file is over 2 MB. Export a shorter date range and try again.');
      const t = token;
      inFlight = true;
      setMsg('');
      zone.hidden = true;
      status.hidden = false;
      try {
        const text = await file.text();
        const id = await ensureSchedule();
        const dry = await api.importIcs(id, text, { dryRun: true, allDayBlocks: allDay });
        if (t !== token) return;
        inFlight = false;
        viewPreview({ label: file.name, dry, noun: 'item', back: () => viewIcs(), commit: () => api.importIcs(id, text, { allDayBlocks: allDay }) });
      } catch (e) {
        if (t === token) { zone.hidden = false; status.hidden = true; setMsg(friendlyError(e)); }
      } finally {
        inFlight = false;
      }
    };
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; handle(f); });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('is-over'); }));
    zone.addEventListener('drop', (e) => handle(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
    render({
      ico: icon('i-cal-edit'),
      title: ['Import an ', ['em', '.ics'], ' file'],
      sub: 'We read a copy into your Breakpoint schedule. Your file and your original calendar are never changed.',
      body: [zone, status, h('label', { class: 'chk' }, chk, h('span', {}, 'Treat all-day events as busy time'))],
      actions: [ghost('Not now', cancel)],
      foot: 'Nothing leaves your browser until you choose a file.',
      note,
    });
  }

  /* ───────── calendar links: Google "Secret address in iCal format", iCloud "Public Calendar" ───────── */
  // No OAuth app and no Google verification: the link already grants read access, and the server reads it once and never keeps it.
  const b = (t) => h('b', {}, t);
  const ext = (t, href) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, t);
  const LINKS = {
    google: {
      ico: 'i-gcal',
      label: 'Google Calendar',
      title: ['Connect ', ['em', 'Google Calendar']],
      steps: [
        ['Open ', ext('Google Calendar settings', 'https://calendar.google.com/calendar/u/0/r/settings'), ' on a computer and pick your calendar under ', b('Settings for my calendars'), '.'],
        ['Open ', b('Integrate calendar'), ' and copy the ', b('Secret address in iCal format'), '.'],
        ['Paste it below.'],
      ],
      placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
      foot: 'A private link: Breakpoint reads it once and never saves it. You can reset it in the same Google settings page at any time.',
    },
    apple: {
      ico: 'i-apple-cal',
      label: 'Apple Calendar',
      title: ['Connect ', ['em', 'Apple Calendar']],
      steps: [
        ['In the Calendar app (or at ', ext('iCloud.com', 'https://www.icloud.com/calendar'), '), open the sharing options of the calendar you want.'],
        ['Turn on ', b('Public Calendar'), ' and copy the link.'],
        ['Paste it below. You can switch Public Calendar off again right after importing.'],
      ],
      placeholder: 'webcal://p12-caldav.icloud.com/published/2/…',
      foot: 'Public means anyone holding the link can read that calendar, so Breakpoint reads it once and never saves it. Apple has no sign-in for calendars, so a link or a file is the safe way.',
    },
  };

  function viewCalendarLink(provider, note) {
    const cfg = LINKS[provider];
    const input = h('input', { type: 'text', class: 'sh__input', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `${cfg.label} link`, placeholder: cfg.placeholder });
    const preview = (btn) => run(btn, 'Reading…', async () => {
      const url = input.value.trim();
      if (url.length < 12 || !/^(https?|webcals?):\/\//i.test(url)) throw { message: 'Paste the whole link, starting with https:// or webcal://.' };
      const id = await ensureSchedule();
      const dry = await api.importLink(id, url, { provider, dryRun: true });
      // the link lives only in this closure, so Back and Import can reuse it; it is never written anywhere
      viewPreview({ label: cfg.label, dry, noun: 'event', back: () => viewCalendarLink(provider), commit: () => api.importLink(id, url, { provider }) });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('.sh__primary', bodyEl)?.click(); } });
    const alt = [h('button', { class: 'sh__linkbtn', type: 'button', onclick: () => viewIcs() }, 'I have an exported .ics file instead')];
    if (provider === 'google' && caps && caps.google) alt.push(h('button', { class: 'sh__linkbtn', type: 'button', onclick: () => gateGoogle() }, 'Connect with Google sign-in instead'));
    render({
      ico: icon(cfg.ico),
      title: cfg.title,
      body: [h('ol', { class: 'sh__steps' }, cfg.steps.map((st) => h('li', {}, st))), input, h('div', { class: 'sh__alts' }, alt)],
      actions: [ghost('Not now', cancel), primary('Preview', preview)],
      foot: cfg.foot,
      focus: input,
      note,
    });
  }

  /* ───────── sign-in gate (only Google sign-in needs an account) ───────── */
  function viewSignIn(source, note) {
    const g = source === 'google';
    const go = (btn) => run(btn, 'Opening Google…', async () => {
      const url = await api.googleSignInUrl(`/?ob=${source}`);
      persist && persist();
      location.assign(url);
      await new Promise(() => {}); // stay busy until the browser leaves the page
    });
    render({
      ico: icon(g ? 'i-gcal' : 'i-notion'),
      title: ['Sign in to ', ['em', 'connect'], g ? ' Google' : ' Notion'],
      sub: g
        ? 'Breakpoint keeps your connection safe in an account. Signing in shares only your name and email. Calendar access is a separate step that you choose.'
        : 'Breakpoint stores your Notion token encrypted, in an account. Sign in with Google to continue. It shares only your name and email.',
      body: [...(currentUser()?.isGuest ? [h('p', { class: 'sh__hint' }, 'Anything you’ve added so far comes with you.')] : []), ...(g && caps && caps.calendarLink ? [h('div', { class: 'sh__alts' }, h('button', { class: 'sh__linkbtn', type: 'button', onclick: () => viewCalendarLink('google') }, 'Use a private link instead (no sign-in)'))] : [])],
      actions: [ghost('Not now', cancel), primary('Continue with Google', go)],
      foot: 'You can delete your account and everything in it at any time.',
      note,
    });
  }

  function viewUnavailable(kind) {
    const copy = {
      google: ['Google Calendar isn’t ', 'switched on', ' here yet', 'This Breakpoint server hasn’t been given a Google app to connect with. You can still bring your calendar in: export it as an .ics file from Google Calendar and import that.'],
      notion: ['Notion needs an ', 'account', '', 'Connecting Notion stores a token, and that needs a Breakpoint account. Signing in isn’t switched on for this server yet. You can still import an .ics file.'],
    }[kind];
    render({
      title: [copy[0], ['em', copy[1]], copy[2]].filter(Boolean),
      sub: copy[3],
      actions: [ghost('Close', cancel), primary('Import an .ics file', () => viewIcs())],
    });
  }

  function viewFatal(e, retry) {
    render({
      title: ['That didn’t ', ['em', 'work']],
      sub: friendlyError(e),
      actions: [ghost('Close', cancel), retry ? primary('Try again', () => retry(), { arrow: false }) : null],
    });
  }

  /* ───────── Google ───────── */
  async function gateGoogle(note) {
    if (!caps.google) return viewUnavailable('google');
    loading(['Checking ', ['em', 'Google']]);
    const t = token;
    try {
      const u = await peekSession();
      const conns = u && !u.isGuest ? await api.listConnections() : [];
      if (t !== token) return;
      if (!u || u.isGuest) return viewSignIn('google', note);
      const c = conns.find((x) => x.provider === 'google');
      return c ? viewGooglePick(c, note) : viewGoogleConsent(note);
    } catch (e) {
      if (t === token) viewFatal(e, () => gateGoogle(note));
    }
  }

  function viewGoogleConsent(note) {
    const row = (ok, text) => h('li', { class: ok ? 'is-yes' : 'is-no' }, icon(ok ? 'i-check' : 'i-x', 'sh__mark'), h('span', {}, text));
    const go = (btn) => run(btn, 'Opening Google…', async () => {
      const url = await api.googleConnectUrl('/?ob=google');
      persist && persist();
      location.assign(url);
      await new Promise(() => {});
    });
    render({
      ico: icon('i-gcal'),
      title: ['Allow ', ['em', 'read-only'], ' access'],
      sub: 'Google will ask you to confirm this exact permission on the next screen.',
      body: [h('ul', { class: 'sh__list' },
        row(true, 'See the calendars you choose, and the titles and times of their events'),
        row(false, 'Create, change or delete anything in your calendar. Ever.'),
        row(false, 'Read your email, contacts or files'),
      )],
      actions: [ghost('Not now', cancel), primary('Allow read-only access', go)],
      foot: 'You can disconnect at any time. Breakpoint then forgets the connection.',
      note,
    });
  }

  async function viewGooglePick(conn, note) {
    loading(['Your ', ['em', 'calendars']]);
    const t = token;
    let cals;
    try {
      cals = await api.googleCalendars(conn.id);
    } catch (e) {
      if (t !== token) return;
      if (e.code === 'reconnect_required' || e.code === 'google_unauthorized') return viewGoogleConsent({ text: 'Google needs you to reconnect.', tone: 'err' });
      return viewFatal(e, () => viewGooglePick(conn, note));
    }
    if (t !== token) return;
    if (!cals.length) return viewFatal({ message: 'Google didn’t list any calendars for that account.' }, () => viewGooglePick(conn, note));
    const primaryCal = cals.find((c) => c.primary) || cals[0];
    const list = radioList(cals.map((c) => ({ value: c.id, title: c.name, meta: c.timezone || null, tag: c.primary ? 'Primary' : null })), { label: 'Which calendar?', initial: primaryCal.id });
    const range = radioList([{ value: '14', title: '2 weeks' }, { value: '30', title: '1 month' }, { value: '90', title: '3 months' }], { label: 'How far ahead?', cls: 'pick--seg', initial: '30' });
    const win = () => {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + Number(range.value) * 86_400_000);
      return { from: from.toISOString(), to: to.toISOString() };
    };
    const preview = (btn) => run(btn, 'Looking…', async () => {
      const id = await ensureSchedule();
      const base = { connectionId: conn.id, calendarId: list.value, ...win() };
      const dry = await api.importGoogle(id, { ...base, dryRun: true });
      const cal = cals.find((c) => c.id === list.value);
      viewPreview({ label: cal ? cal.name : 'Google Calendar', dry, noun: 'event', back: () => viewGooglePick(conn), commit: () => api.importGoogle(id, base) });
    });
    const disconnect = (btn) => run(btn, 'Disconnecting…', async () => {
      await api.disconnect(conn.id);
      say('Disconnected from Google Calendar.');
      viewGoogleConsent();
    });
    render({
      title: ['Pick a ', ['em', 'calendar']],
      sub: conn.accountLabel ? `Connected to ${conn.accountLabel}, read-only.` : 'Connected, read-only.',
      body: [list.el, h('p', { class: 'sh__label' }, 'How far ahead?'), range.el],
      actions: [ghost('Disconnect', disconnect), primary('Preview', preview)],
      foot: 'Breakpoint only reads. It can’t add, edit or delete events.',
      note,
    });
  }

  /* ───────── Notion ───────── */
  /** Notion needs no sign-in. With "Log in with Notion" set up it is two clicks; otherwise a pasted token still works. */
  async function gateNotion(note) {
    loading(['Checking ', ['em', 'Notion']]);
    const t = token;
    try {
      await ensureSession();
      const conns = await api.listConnections();
      if (t !== token) return;
      const c = conns.find((x) => x.provider === 'notion');
      if (c) return viewNotionPick(c, note);
      return caps && caps.notionLogin ? viewNotionLogin(note) : viewNotionToken(note);
    } catch (e) {
      if (t === token) viewFatal(e, () => gateNotion(note));
    }
  }

  function viewNotionLogin(note) {
    const go = (btn) => run(btn, 'Opening Notion…', async () => {
      const url = await api.notionLoginUrl('/?ob=notion');
      persist && persist();
      location.assign(url);
      await new Promise(() => {});
    });
    render({
      ico: icon('i-notion'),
      title: ['Log in with ', ['em', 'Notion']],
      sub: 'Notion will ask which pages and databases to share. Breakpoint can only read what you choose. It never changes anything.',
      body: [h('div', { class: 'sh__alts' }, h('button', { class: 'sh__linkbtn', type: 'button', onclick: () => viewNotionToken() }, 'I’d rather paste a token instead'))],
      actions: [ghost('Not now', cancel), primary('Log in with Notion', go)],
      foot: 'No password is shared with Breakpoint. You can remove the connection in Notion at any time.',
      note,
    });
  }

  function viewNotionToken(note) {
    const input = h('input', { type: 'password', class: 'sh__input', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Notion integration token', placeholder: 'Paste your integration token' });
    const connect = (btn) => run(btn, 'Connecting…', async () => {
      const v = input.value.trim();
      if (v.length < 20) throw { message: 'That token looks too short. Copy the whole “Internal Integration Secret” from Notion.' };
      const r = await api.connectNotion(v);
      input.value = '';
      viewNotionPick(r.connection, { text: 'Notion connected, read-only.', tone: 'ok' });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('.sh__primary', bodyEl)?.click(); } });
    render({
      ico: icon('i-notion'),
      title: ['Connect ', ['em', 'Notion'], ' (read-only)'],
      sub: null,
      body: [
        h('ol', { class: 'sh__steps' },
          h('li', {}, 'Open ', h('a', { href: 'https://www.notion.so/profile/integrations', target: '_blank', rel: 'noopener noreferrer' }, 'Notion → Integrations'), ' and create an internal integration.'),
          h('li', {}, 'Under Capabilities, tick ', h('b', {}, 'Read content'), ' only.'),
          h('li', {}, 'On your task database, open ••• → Connections and add the integration.'),
          h('li', {}, 'Paste the token here.'),
        ),
        input,
      ],
      actions: [ghost('Not now', cancel), primary('Connect read-only', connect)],
      foot: 'Stored encrypted and only used to read the databases you share. Deleted when you disconnect or your guest session ends (24 hours).',
      focus: input,
      note,
    });
  }

  async function viewNotionPick(conn, note) {
    loading(['Your ', ['em', 'databases']]);
    const t = token;
    let dbs;
    try {
      dbs = await api.notionDatabases(conn.id);
    } catch (e) {
      if (t !== token) return;
      if (e.code === 'reconnect_required' || e.code === 'notion_unauthorized') return viewNotionToken({ text: 'Notion no longer accepts that token. Paste a new one.', tone: 'err' });
      return viewFatal(e, () => viewNotionPick(conn, note));
    }
    if (t !== token) return;
    const disconnect = (btn) => run(btn, 'Disconnecting…', async () => {
      await api.disconnect(conn.id);
      say('Disconnected from Notion. Remove the integration in Notion to revoke the token there too.');
      viewNotionToken();
    });
    if (!dbs.length) {
      return render({
        ico: icon('i-notion'),
        title: ['Nothing is ', ['em', 'shared'], ' yet'],
        sub: 'Your integration can’t see any databases. In Notion, open your task database, choose ••• → Connections, and add the integration. Then check again.',
        actions: [ghost('Disconnect', disconnect), primary('Check again', (btn) => run(btn, 'Checking…', async () => viewNotionPick(conn, note)), { arrow: false })],
        note,
      });
    }
    const byId = Object.fromEntries(dbs.map((d) => [d.id, d]));
    const list = radioList(dbs.map((d) => ({ value: d.id, title: d.title, meta: plural(d.properties.length, 'property', 'properties') })), { label: 'Which database?', onChange: () => paintMap() });
    const mapLine = h('p', { class: 'sh__map' });
    const dateSel = h('select', { class: 'sh__select', 'aria-label': 'Which date property is the deadline?', onchange: () => paintMap() });
    const dateWrap = h('label', { class: 'sh__field', hidden: true }, h('span', {}, 'Deadline column'), dateSel);
    let override = null;
    const currentMap = () => {
      const db = byId[list.value];
      const m = deriveMapping(db);
      if (override && db.properties.some((p) => p.name === override)) m.date = override;
      return m;
    };
    function paintMap() {
      const db = byId[list.value];
      const dates = db.properties.filter((p) => p.type === 'date');
      dateWrap.hidden = dates.length < 2;
      if (dates.length >= 2) {
        const keep = override && dates.some((p) => p.name === override) ? override : deriveMapping(db).date;
        dateSel.replaceChildren(...dates.map((p) => h('option', { value: p.name, selected: p.name === keep }, p.name)));
        override = dateSel.value || keep;
      } else override = null;
      const m = currentMap();
      const bits = [];
      if (m.title) bits.push(`title from “${m.title}”`);
      if (m.date) bits.push(`deadline from “${m.date}”`); else bits.push('no deadline column found');
      if (m.duration) bits.push(`estimate from “${m.duration}”`);
      mapLine.textContent = `Reading ${bits.join(', ')}. Finished tasks are skipped.`;
    }
    dateSel.addEventListener('change', () => { override = dateSel.value; paintMap(); });
    paintMap();
    const preview = (btn) => run(btn, 'Looking…', async () => {
      const id = await ensureSchedule();
      const base = { connectionId: conn.id, databaseId: list.value, mapping: currentMap() };
      const dry = await api.importNotion(id, { ...base, dryRun: true });
      viewPreview({ label: byId[list.value].title, dry, noun: 'task', back: () => viewNotionPick(conn), commit: () => api.importNotion(id, base) });
    });
    render({
      title: ['Pick a ', ['em', 'database']],
      sub: conn.accountLabel ? `Connected to ${conn.accountLabel}, read-only.` : 'Connected, read-only.',
      body: [list.el, dateWrap, mapLine],
      actions: [ghost('Disconnect', disconnect), primary('Preview', preview)],
      foot: 'Breakpoint only reads. It can’t add, edit or delete pages.',
      note,
    });
  }

  /* ───────── entry points ───────── */
  // Google: sign in with Google when the server has it (fewest steps), otherwise the private link (nothing to approve).
  // Apple has no sign-in for calendars, so it is always the link.
  const FLOWS = {
    ics: viewIcs,
    google: (note) => (caps && caps.google ? gateGoogle(note) : caps && caps.calendarLink ? viewCalendarLink('google', note) : gateGoogle(note)),
    apple: (note) => (caps && caps.calendarLink ? viewCalendarLink('apple', note) : viewIcs(note)),
    notion: gateNotion,
  };

  async function checkServer() {
    try {
      caps = await api.capabilities();
      online = true;
      return true;
    } catch {
      online = false;
      return false;
    }
  }

  /** Continue on the Connect step. Resolves { advance } once the user is done (or has cancelled). */
  async function start(source) {
    if (!apiEnabled) { say(PREVIEW_MSG); return { advance: true, preview: true }; }
    if (!(await checkServer())) { say('Couldn’t reach the Breakpoint server, so nothing was imported. You can connect later.'); return { advance: true, offline: true }; }
    if (source === 'scratch') {
      try {
        await ensureSchedule();
        return { advance: true, imported: { scratch: true } };
      } catch (e) {
        say(friendlyError(e));
        return { advance: false };
      }
    }
    const p = openFlow();
    (FLOWS[source] || viewIcs)();
    return p;
  }

  /** Back from Google (sign-in or consent, or a refusal): reopen the sheet where the user left off. */
  async function resume(ret) {
    if (!apiEnabled) return { advance: false };
    let note = null;
    if (ret.hasCode) {
      try {
        const u = await completeSignIn();
        if (u) note = { text: `Signed in${u.email ? ` as ${u.email}` : ''}. One more step.`, tone: 'ok' };
      } catch (e) {
        note = { text: returnError(e.code), tone: 'err' };
      }
    }
    if (ret.error) note = { text: returnError(ret.error), tone: 'err' };
    else if (ret.connected === 'google') note = { text: 'Google Calendar connected, read-only.', tone: 'ok' };
    else if (ret.connected === 'notion') note = { text: 'Notion connected, read-only. Pick the database to bring in.', tone: 'ok' };
    cleanLandedUrl();
    if (!(await checkServer())) { say('Couldn’t reach the Breakpoint server. Try again in a moment.'); return { advance: false }; }
    const p = openFlow();
    (ret.source === 'notion' ? gateNotion : gateGoogle)(note);
    return p;
  }

  /** Customize -> Continue: store the choices on the schedule. Never blocks the flow for long. */
  async function savePrefs(choices) {
    if (!apiEnabled || !online) return { saved: false };
    if (!currentUser()) return { saved: false };
    try {
      await Promise.race([savePreferences(choices), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
      return { saved: true };
    } catch (e) {
      say('Couldn’t save your preferences just now. You can set them again later.');
      return { saved: false, error: e };
    }
  }

  return { start, resume, savePrefs, get isOpen() { return !sheet.hidden; } };
}

function $$all(s, r = document) { return [...r.querySelectorAll(s)]; }
