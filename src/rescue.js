import './rescue.css';
import { h, icon, emphasize } from './dom.js';

/** element.append, but a missing card (null) adds nothing, instead of the text "null". */
const put = (el, ...kids) => el.append(...kids.filter((k) => k != null && k !== false));

/**
 * rescue my day + "can you save this day?"
 *
 * everything on this screen is computed by the real scheduling engine (server/src/engine), which is bundled into the
 * page, so it works on the static site with no account and no server. nothing here is hardcoded: the days are generated
 * from a seed, the disruptions are yours, and every number, conflict and sentence is read from the engine's result.
 */

let enginePromise = null;
const loadEngine = () => (enginePromise ||= import('../server/src/engine/index.ts'));

const SNAP = 5;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function initRescue({ getLenis, say, onSetup }) {
  const root = document.querySelector('#rescue');
  const body = root.querySelector('#rs-body');
  const tabBtns = [...root.querySelectorAll('[data-tab]')];
  const pageRegions = ['#main', '#nav'].map((s) => document.querySelector(s)).filter(Boolean);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let E = null;
  let isOpen = false;
  let tab = 'rescue';
  let returnFocus = null;
  let cleanup = () => {};
  let opened = 0; // bumps on every open/tab change so late async work can tell it is stale
  let startOnMine = false; // set by open(…, { mine: true }): after onboarding, start on the visitor's own schedule

  /** clock times are shown in the day's own timezone: utc for the generated days, the schedule's timezone for yours. */
  let TZ = 'UTC';
  const fmt = (m) => E.fmtClock(m, TZ);
  const dur = (m) => E.fmtDuration(m);

  /* ═════════════ timeline pieces ═════════════ */

  /** the day's visible span: every block (and every replay frame), 30 minutes either side, on whole hours. */
  const rangeFor = (plan, ...lists) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of lists.flat()) { lo = Math.min(lo, b.start); hi = Math.max(hi, b.end); }
    if (!Number.isFinite(lo)) for (const a of plan.settings.availability) { lo = Math.min(lo, a.start); hi = Math.max(hi, a.end); }
    // whole local hours (not whole utc hours: some timezones are offset by 30 or 45 minutes)
    const minute = (t) => E.localParts(t, TZ).minute;
    const a = lo - 30;
    const b = hi + 30;
    return { lo: a - minute(a), hi: b + ((60 - minute(b)) % 60) };
  };
  const pct = (m, r) => ((m - r.lo) / (r.hi - r.lo)) * 100;
  const place = (el, start, end, r) => { el.style.left = `${pct(start, r)}%`; el.style.width = `${((end - start) / (r.hi - r.lo)) * 100}%`; };

  const axisEl = (r) => {
    const el = h('div', { class: 'axis', 'aria-hidden': 'true' });
    for (let t = r.lo; t <= r.hi; t += 60) {
      const hour = E.localParts(t, TZ).hour;
      if (hour % 2 === 0 || r.hi - r.lo <= 600) el.append(h('span', { style: { left: `${pct(t, r)}%` } }, fmt(t).replace(':00', '')));
    }
    return el;
  };

  const kindOf = (b) => (b.injected ? 'injected' : b.protectedBreak || b.kind === 'break' ? 'break' : b.locked ? 'locked' : 'task');

  const tipFor = (b, plan) => {
    const src = plan.items.find((i) => i.id === b.id);
    const bits = [`${b.title}: ${fmt(b.start)} to ${fmt(b.end)} (${dur(b.end - b.start)})`];
    if (b.locked && !b.injected) bits.push('locked: it never moves');
    if (b.injected) bits.push('unexpected');
    if (src && src.deadline !== undefined && src.kind !== 'break') bits.push(`due ${fmt(src.deadline)}`);
    if (b.protectedBreak && b.release != null && b.deadline != null) bits.push(`protected: must stay between ${fmt(b.release)} and ${fmt(b.deadline)}`);
    return bits.join(' · ');
  };

  const blockClasses = (b, i, focus) =>
    `blk blk--${kindOf(b)}${b.state === 'conflict' ? ' is-conflict' : ''}${b.state === 'moved' ? ' is-moved' : ''}${b.state === 'shifted' ? ' is-shifted' : ''}${i > 0 ? ' is-cont' : ''}${focus ? ' is-focus' : ''}`;

  const blockInner = (b, p, i) => {
    if (i > 0) return [];
    return [b.locked && !b.injected ? icon('i-lock', 'blk__lock') : null, h('b', {}, b.title), h('span', {}, `${fmt(b.start)}–${fmt(b.end)}`)];
  };

  const trackBase = (r, plan, windows) => {
    const track = h('div', { class: 'track' });
    for (let t = r.lo; t <= r.hi; t += 60) track.append(h('i', { class: 'tick', style: { left: `${pct(t, r)}%` } }));
    for (const w of windows) if (w.release != null && w.deadline != null) track.append(h('i', { class: 'win', style: { left: `${pct(w.release, r)}%`, width: `${((w.deadline - w.release) / (r.hi - r.lo)) * 100}%` }, title: `${w.title} must stay inside ${fmt(w.release)} to ${fmt(w.deadline)}` }));
    return track;
  };

  /**
   * one lane of the day. with `from` (the previous lane's blocks) its blocks can glide from where they were to where they
   * are now: rewind() puts them back, play() lets them glide, finish() puts them in place at once.
   */
  const laneEl = ({ title, sub, tone, blocks, r, plan, from }) => {
    const track = trackBase(r, plan, blocks.filter((b) => b.protectedBreak));
    for (const b of blocks) {
      const src = plan.items.find((i) => i.id === b.id);
      if (src && src.deadline !== undefined && src.kind !== 'break' && !b.locked) track.append(h('i', { class: 'due', style: { left: `${pct(src.deadline, r)}%` }, title: `${b.title} is due ${fmt(src.deadline)}` }));
    }
    const was = new Map((from || []).map((b) => [b.id, b]));
    const moving = [];
    for (const b of blocks) {
      const pieces = b.pieces && b.pieces.length ? b.pieces : [{ start: b.start, end: b.end }];
      pieces.forEach((p, i) => {
        const el = h('div', { class: blockClasses(b, i, false), title: tipFor(b, plan), 'data-id': b.id }, blockInner(b, p, i));
        place(el, p.start, p.end, r);
        const w = was.get(b.id);
        if (w && i === 0) moving.push({ el, from: w, to: p });
        track.append(el);
      });
    }
    const section = h('section', { class: `lane lane--${tone || 'plain'}` }, h('header', { class: 'lane__head' }, h('b', {}, title), h('span', {}, sub || '')), track);
    const quiet = (fn) => { moving.forEach((m) => { m.el.style.transition = 'none'; }); fn(); void track.offsetWidth; moving.forEach((m) => { m.el.style.transition = ''; }); };
    section.rewind = () => quiet(() => moving.forEach((m) => place(m.el, m.from.start, m.from.end, r)));
    section.finish = () => quiet(() => moving.forEach((m) => place(m.el, m.to.start, m.to.end, r)));
    section.play = () => moving.forEach((m) => place(m.el, m.to.start, m.to.end, r));
    return section;
  };

  /* ═════════════ shared small widgets ═════════════ */

  let activeSay = null;

  /**
   * pip talking. the portrait sits on the left, the words appear in a dialogue box, typed out, one short message at a time.
   * click the box (or press enter) for the next message; left alone, it moves on by itself.
   */
  const pipSay = (messages, { auto = true, start = 0 } = {}) => {
    if (activeSay) activeSay.stop();
    const text = h('p', { class: 'say__text', 'aria-hidden': 'true' });
    const sr = h('span', { class: 'sr-only', role: 'status' });
    const next = h('i', { class: 'say__next', 'aria-hidden': 'true' });
    const box = h('div', { class: 'say__box', tabindex: 0, role: 'button', 'aria-label': 'next message' }, h('span', { class: 'say__name' }, 'pip'), text, sr, next);
    const pip = h('img', { class: 'say__pip', src: '/art/pip-cutout.webp', alt: '', width: 124, height: 137, draggable: 'false' });
    const el = h('div', { class: 'say' }, h('div', { class: 'say__who' }, pip), box);
    let i = 0;
    let n = 0;
    let typing = null;
    let wait = null;
    let touched = false;
    const clear = () => { clearInterval(typing); clearTimeout(wait); typing = null; wait = null; };
    const finish = () => {
      el.classList.remove('is-talking');
      box.classList.add('is-done');
      next.hidden = i >= messages.length - 1;
      if (auto && !touched && i < messages.length - 1) wait = setTimeout(() => show(i + 1), 2300);
    };
    function show(k) {
      clear();
      i = k;
      n = 0;
      const msg = String(messages[i] || '').trim();
      sr.textContent = msg;
      box.classList.remove('is-done');
      next.hidden = true;
      if (reduce) { text.textContent = msg; finish(); return; }
      text.textContent = '';
      el.classList.add('is-talking');
      typing = setInterval(() => {
        n++;
        text.textContent = msg.slice(0, n);
        if (n >= msg.length) { clearInterval(typing); typing = null; finish(); }
      }, 26);
    }
    const advance = () => {
      touched = true;
      if (typing) { clear(); text.textContent = String(messages[i] || '').trim(); finish(); }
      else if (i < messages.length - 1) show(i + 1);
      else { touched = false; show(0); }
    };
    box.addEventListener('click', advance);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); advance(); } });
    el.stop = clear;
    activeSay = el;
    if (messages.length) show(Math.min(start, messages.length - 1));
    return el;
  };

  /** the first sentence of each of pip's longer lines, three at most: for places that only have the long version */
  const brief = (lines) => lines.slice(0, 3).map((l) => { const t = l.text.split(/(?<=[.!?])\s/)[0]; return t.length > 120 ? `${t.slice(0, 117)}…` : t; });

  const pipCard = (lines) => h("section", { class: "pipc2" }, pipSay(brief(lines)));

  /** a wide timeline inside a narrow screen scrolls sideways on its own, while the text around it stays put. */
  const scrollX = (...kids) => h('div', { class: 'rtl' }, h('div', { class: 'rtl__in' }, kids));

  const seg = (name, options, value, onChange) => {
    const wrap = h('div', { class: 'rseg', role: 'radiogroup', 'aria-label': name });
    const paint = (v) => [...wrap.children].forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    for (const [v, label] of options) wrap.append(h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => { paint(v); onChange(v); } }, label));
    paint(value);
    return wrap;
  };

  const TYPE_LABEL = { overrun: 'runs long', delay: 'starts late', unexpected: 'surprise commitment', lost_time: 'lost time' };

  /** the "what goes wrong?" form. builds real engine disruptions from whatever the visitor chooses. */
  const disruptionForm = (plan, onAdd, atTime) => {
    const tasks = plan.items.filter((i) => i.blocking && !i.locked && i.kind !== 'break');
    // with nothing movable (an import where every event is locked), "runs long" and "starts late" have no task to pick
    const kinds = Object.entries(TYPE_LABEL).filter(([v]) => tasks.length > 0 || (v !== 'overrun' && v !== 'delay'));
    const type = h('select', { 'aria-label': 'what goes wrong?' }, kinds.map(([v, l]) => h('option', { value: v }, l)));
    const target = h('select', { 'aria-label': 'which task?' }, tasks.map((t) => h('option', { value: t.id }, t.title)));
    const minutes = h('input', { type: 'number', min: 5, max: 480, step: 5, value: 45, 'aria-label': 'how many minutes?' });
    const time = h('input', { type: 'time', value: '15:00', 'aria-label': 'at what time?' });
    const name = h('input', { type: 'text', maxlength: 40, placeholder: 'surprise meeting', 'aria-label': 'what is it?' });
    const err = h('p', { class: 'form__err', role: 'alert', hidden: true });
    const rows = {
      target: h('label', { class: 'f' }, h('span', {}, 'task'), target),
      minutes: h('label', { class: 'f f--sm' }, h('span', {}, 'minutes'), minutes, h('em', { class: 'unit' }, 'min')),
      time: h('label', { class: 'f f--sm' }, h('span', {}, 'at'), time),
      name: h('label', { class: 'f' }, h('span', {}, 'what'), name),
    };
    const sync = () => {
      const t = type.value;
      rows.target.hidden = !(t === 'overrun' || t === 'delay');
      rows.time.hidden = !(t === 'unexpected' || t === 'lost_time');
      rows.name.hidden = t !== 'unexpected';
    };
    type.addEventListener('change', sync);
    sync();
    const add = h('button', {
      class: 'btn-s', type: 'button',
      onclick: () => {
        const m = Math.round(Number(minutes.value));
        if (!(m >= 5 && m <= 480)) { err.textContent = 'use between 5 and 480 minutes.'; err.hidden = false; return; }
        err.hidden = true;
        const [hh, mm] = time.value.split(':').map(Number);
        const at = atTime(hh || 0, mm || 0);
        const t = type.value;
        if (t === 'overrun' || t === 'delay') onAdd({ type: t, targetId: target.value, minutes: m });
        else if (t === 'unexpected') onAdd({ type: 'unexpected', start: at, duration: m, title: name.value.trim() || 'Surprise meeting', priority: 5 });
        else onAdd({ type: 'lost_time', minutes: m, start: at });
      },
    }, icon('i-plus'), 'add');
    return h('div', { class: 'form' }, h('div', { class: 'form__row' }, h('label', { class: 'f' }, h('span', {}, 'what goes wrong?'), type), rows.target, rows.minutes, rows.time, rows.name, add), err);
  };

  const chips = (plan, disruptions, onRemove) =>
    disruptions.length
      ? h('ul', { class: 'chips', 'aria-label': 'disruptions' }, disruptions.map((d, i) => h('li', { class: 'chip' }, h('span', {}, cap(E.describeDisruption(d, plan))), h('button', { type: 'button', 'aria-label': `remove: ${E.describeDisruption(d, plan)}`, onclick: () => onRemove(i) }, icon('i-x')))))
      : null;

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /** which day of the visitor's schedule to open first: the next day with at least two items, else the busiest. */
  const pickDay = (items, tz) => {
    const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const byDay = new Map();
    for (const it of items) {
      if (!it.start || it.blocking === false || it.allDay) continue;
      const d = fmtDay.format(new Date(it.start));
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    if (!byDay.size) return null;
    const today = fmtDay.format(new Date());
    const days = [...byDay.entries()];
    const upcoming = days.filter(([d, n]) => d >= today && n >= 2).sort((a, b) => a[0].localeCompare(b[0]));
    if (upcoming.length) return upcoming[0][0];
    return days.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  };

  /** the api's /plan answer (iso times) -> the engine's own plan (epoch minutes). */
  const planFromApi = (res) => {
    const mn = (v) => (v ? E.isoToMin(v) : undefined);
    const horizon = { start: mn(res.settings.horizon.start), end: mn(res.settings.horizon.end) };
    const items = [];
    for (const i of res.items) {
      if (i.start == null && i.blocking) continue; // could not be placed on this day: counted in res.unscheduled
      items.push({
        id: i.id, title: i.title, kind: i.kind, start: i.start ? mn(i.start) : horizon.start, duration: i.durationMin,
        locked: i.locked, priority: i.priority, deferrable: i.deferrable, critical: i.critical, blocking: i.blocking,
        ...(i.category ? { category: i.category } : {}), ...(i.deadline ? { deadline: mn(i.deadline) } : {}), ...(i.release ? { release: mn(i.release) } : {}),
      });
    }
    return { items, settings: { horizon, availability: res.settings.availability.map((a) => ({ start: mn(a.start), end: mn(a.end) })), mobility: res.settings.mobility, criticalPriority: res.settings.criticalPriority, timezone: res.timezone } };
  };

  /* ═════════════ tab 1: rescue my day ═════════════ */

  function renderRescue() {
    const token = ++opened;
    // mode 'sample' = a generated day; mode 'mine' = the visitor's own imported schedule (needs the api)
    const S = { mode: 'sample', seed: 0, ch: null, disruptions: [], mobility: 'balanced', result: null, timers: [], mine: { status: 'idle', message: '', date: '', info: null, token: 0 }, note: '', option: null, optKey: '', adopted: null, say: null };
    const stop = () => { if (S.say) S.say.stop(); S.timers.forEach(clearTimeout); S.timers = []; };
    const later = (fn, ms) => { S.timers.push(setTimeout(fn, ms)); };
    // which generated day opens first: day 0, or ?day=n so a particular day can be linked to
    const firstDay = () => { const n = Number(new URLSearchParams(location.search).get('day')); return Number.isInteger(n) && n >= 0 && n < 1000 ? n : 0; };
    cleanup = stop;

    const loadSeed = (seed) => {
      S.mode = 'sample';
      S.seed = seed;
      S.ch = E.makeChallenge(seed);
      S.disruptions = [];
      S.mobility = 'balanced';
      S.note = '';
      S.adopted = null;
      TZ = 'UTC';
      draw(false);
    };

    /** the visitor's own schedule: read from the api (read-only), turned into an engine plan, then run in the browser. */
    const loadMine = async (date) => {
      S.mode = 'mine';
      S.note = '';
      S.mine.status = 'loading';
      draw(false);
      const my = ++S.mine.token;
      const fail = (status, message) => { if (my === S.mine.token) { S.mine.status = status; S.mine.message = message; draw(false); } };
      try {
        const mod = await import('./api.js');
        if (!mod.apiEnabled) return fail('unavailable', 'this copy of the site is not connected to a breakpoint server, so there is no schedule of yours to read yet. the sample days work everywhere.');
        try { await mod.api.capabilities(); } catch { return fail('unavailable', 'couldn’t reach the breakpoint server. try again in a moment.'); }
        const id = await mod.findSchedule();
        if (!id) return fail('empty', 'you haven’t set up a schedule yet. connect a calendar or import an .ics file first, then come back.');
        const sched = await mod.api.getSchedule(id);
        const tz = sched.timezone || 'UTC';
        const items = await mod.api.listItems(id);
        const day = date || pickDay(items, tz);
        if (!day) return fail('empty', 'your schedule has nothing on a calendar day yet. import some events or tasks, then come back.');
        const res = await mod.api.plan(id, { date: day });
        const plan = planFromApi(res);
        if (my !== S.mine.token) return;
        const blocking = plan.items.filter((i) => i.blocking);
        if (!blocking.length) return fail('empty', `nothing is scheduled on ${day}. pick another day.`);
        TZ = plan.settings.timezone;
        S.mine = { ...S.mine, status: 'ready', date: day, token: my, info: { id, name: sched.name, tz, plan, unscheduled: (res.unscheduled || []).length, total: items.length } };
        S.disruptions = [];
        S.adopted = null;
        S.mobility = plan.settings.mobility;
        draw(false);
      } catch (e) {
        fail('error', e && e.message ? e.message : 'something went wrong reading your schedule.');
      }
    };

    const src = () => {
      if (S.mode === 'mine' && S.mine.status === 'ready') {
        const plan = S.adopted || S.mine.info.plan;
        const blocking = plan.items.filter((i) => i.blocking);
        const locked = blocking.filter((i) => i.locked && i.kind !== 'break').length;
        const due = blocking.filter((i) => i.deadline !== undefined && i.kind !== 'break').length;
        const breaks = blocking.filter((i) => i.kind === 'break').length;
        return { plan, title: S.mine.info.name || 'your schedule', story: `${blocking.length} items on ${S.mine.date}: ${locked} locked, ${due} with deadlines, ${breaks} protected ${breaks === 1 ? 'break' : 'breaks'}.`, atTime: (hh, mm) => { const [y, mo, d] = S.mine.date.split('-').map(Number); return E.zonedToMin(y, mo, d, hh, mm, plan.settings.timezone); } };
      }
      return { plan: S.adopted || S.ch.plan, title: S.ch.title, story: S.ch.story, atTime: (hh, mm) => E.CHALLENGE_DAY + hh * 60 + mm };
    };
    const resetAdopted = () => {
      S.adopted = null;
      S.option = null;
      if (S.mode === 'mine') { S.disruptions = []; draw(false); } else loadSeed(S.seed);
    };

    const planNow = () => ({ ...src().plan, settings: { ...src().plan.settings, mobility: S.mobility } });

    /** probe every item with the engine, find the one with the least slack, and break it just past what it can take. */
    const stressTest = () => {
      const plan = planNow();
      if (!plan.items.some((i) => i.blocking && !i.locked && i.kind !== 'break')) { S.note = 'every item here is locked, so nothing can move. add a surprise commitment to see what it does.'; draw(false); return; }
      if (plan.items.filter((i) => i.blocking).length > 30) { S.note = 'this day has a lot of items. add one disruption yourself.'; draw(false); return; }
      const prof = E.weakLinkProfile(plan, 240);
      const w = prof.weakest;
      if (!w) { S.note = 'nothing here breaks within 4 hours of delay. very resilient. add a disruption yourself.'; draw(false); return; }
      const useDelay = (w.delayTolerance ?? Infinity) < (w.overrunTolerance ?? Infinity);
      const tol = useDelay ? w.delayTolerance : w.overrunTolerance;
      const minutes = Math.min(480, Math.max(5, Math.ceil((tol + 15) / 5) * 5));
      S.disruptions = [{ type: useDelay ? 'delay' : 'overrun', targetId: w.itemId, minutes }];
      draw(true);
    };
    // "break my day": the sample day's own suggestion, or the weakest link of whatever day this is
    const breakDay = () => {
      if (S.mode === 'sample' && !S.adopted) { S.disruptions = [...S.ch.suggested]; draw(true); } else stressTest();
    };

    function draw(animate = true) {
      if (token !== opened) return;
      stop();
      const mine = S.mode === 'mine';
      const page = (...kids) => body.replaceChildren(h('div', { class: 'rv' }, ...kids));
      const sourceSwitch = seg('which day?', [['sample', 'sample day'], ['mine', 'my schedule']], S.mode, (v) => (v === 'mine' ? loadMine(S.mine.date || undefined) : loadSeed(S.seed)));

      if (mine && S.mine.status !== 'ready') {
        const m = S.mine;
        const lines = m.status === 'loading' ? ['reading your schedule…'] : [m.status === 'empty' ? 'nothing to rescue yet.' : m.status === 'unavailable' ? 'your own schedule needs the server.' : 'couldn’t read your schedule.', m.message];
        S.say = pipSay(lines, { auto: false });
        page(S.say, m.status === 'loading' ? null : h('div', { class: 'acts' },
          h('div', { class: 'acts__l' }, sourceSwitch),
          h('div', { class: 'acts__r' },
            h('button', { class: 'solid', type: 'button', onclick: () => loadSeed(S.seed) }, 'use a sample day'),
            m.status === 'empty' && onSetup ? h('button', { class: 'ghost', type: 'button', onclick: () => { close(); onSetup(); } }, 'set up my schedule') : null,
            m.status === 'error' ? h('button', { class: 'ghost', type: 'button', onclick: () => loadMine(S.mine.date || undefined) }, 'try again') : null)));
        return;
      }

      const s = src();
      const plan = planNow();
      let result = null;
      let error = null;
      try { result = S.disruptions.length ? E.rescueDay(plan, S.disruptions) : null; } catch (e) { error = e; }
      S.result = result;
      const optKey = JSON.stringify([S.mode, S.seed, S.mobility, S.disruptions, !!S.adopted, S.mine.date]);
      if (optKey !== S.optKey) { S.optKey = optKey; S.option = null; } // a new disruption starts again from the smallest change
      const picked = result && S.option ? result.options.find((o) => o.strategy === S.option && o.feasible) : null;
      if (picked) {
        const v = picked.view;
        result = { ...result, strategy: picked.strategy, status: v.status, headline: v.headline, lanes: { ...result.lanes, repaired: v.lane }, changes: v.changes, deferred: v.deferred, metrics: v.metrics, guarantees: v.guarantees, pip: v.pip, brief: v.brief, replay: v.replay, optimal: v.optimal };
      }

      // what pip says: short, typed out, one message at a time
      const lines = error ? ['that doesn’t work.', error.message]
        : !result ? [`this is ${s.title}.`, s.story.replace(/ Then: .*$/, ''), S.note || 'what could go wrong?']
          : [...(S.adopted ? ['your repaired day, tested again.'] : []), ...result.brief];
      S.note = '';
      S.say = pipSay(lines, { start: animate === 'repair' && result ? lines.length - 1 : 0 }); // picking a way: pip goes straight to the fix

      // one quiet line for what goes wrong
      const fm = h('div', { class: 'fm' },
        disruptionForm(plan, (d) => { S.disruptions.push(d); draw(true); }, s.atTime),
        chips(plan, S.disruptions, (i) => { S.disruptions.splice(i, 1); draw(true); }));

      // the day, as lanes that glide: original -> after -> repaired
      let laneEls = [];
      let l2 = null;
      let l3 = null;
      let r = null;
      if (!error && !result) {
        const blocks0 = s.plan.items.filter((i) => i.blocking).map((i) => ({ id: i.id, title: i.title, kind: i.kind, start: i.start, end: i.start + i.duration, pieces: [{ start: i.start, end: i.start + i.duration }], locked: i.locked, injected: false, protectedBreak: i.kind === 'break', deadline: i.deadline ?? null, release: i.release ?? null, state: 'ok', shiftedBy: 0, conflictCodes: [] }));
        r = rangeFor(plan, blocks0);
        laneEls = [laneEl({ title: 'your day', tone: 'original', blocks: blocks0, r, plan })];
      } else if (result) {
        r = rangeFor(plan, result.lanes.original.blocks, result.lanes.disrupted.blocks, result.lanes.repaired ? result.lanes.repaired.blocks : []);
        const nc = result.conflicts.length;
        const l1 = laneEl({ title: 'original', tone: 'original', blocks: result.lanes.original.blocks, r, plan });
        l2 = laneEl({ title: 'after', sub: nc ? `${nc} ${nc === 1 ? 'conflict' : 'conflicts'}` : 'no conflicts', tone: 'disrupted', blocks: result.lanes.disrupted.blocks, r, plan, from: result.lanes.original.blocks });
        l3 = result.lanes.repaired
          ? laneEl({ title: 'repaired', sub: `${result.metrics.moved} moved · ${dur(result.metrics.totalMinutes)}`, tone: 'repaired', blocks: result.lanes.repaired.blocks, r, plan, from: result.lanes.disrupted.blocks })
          : h('section', { class: 'lane lane--none' }, h('header', { class: 'lane__head' }, h('b', {}, 'repaired'), h('span', {}, 'no valid day')), h('p', { class: 'lane__none' }, 'nothing was changed.'));
        laneEls = [l1, l2, l3];
      }
      const replay = () => {
        if (!l2) return;
        S.timers.forEach(clearTimeout); S.timers = [];
        l2.rewind(); if (l3 && l3.rewind) l3.rewind();
        later(() => l2.play(), 350);
        later(() => l3 && l3.play && l3.play(), 1700);
      };
      if (result && !reduce && animate) {
        l2.rewind(); if (l3 && l3.rewind) l3.rewind();
        if (animate === true) { later(() => l2.play(), 450); later(() => l3 && l3.play && l3.play(), 1800); }
        else { l2.finish(); later(() => l3 && l3.play && l3.play(), 250); }
      }

      const lanes = laneEls.length
        ? h('div', { class: 'lanes' },
          h('header', { class: 'lanes__head' }, h('span', { class: 'cap' }, 'flexibility'), seg('flexibility', [['fixed', 'fixed'], ['balanced', 'balanced'], ['flexible', 'flexible']], S.mobility, (v) => { S.mobility = v; draw(true); })),
          scrollX(axisEl(r), ...laneEls))
        : null;

      // "test again": adopt this repair as the day, then break its weakest link
      const retest = () => {
        const next = E.adoptRepair(plan, S.disruptions, result.strategy);
        if (!next) return;
        S.adopted = next;
        S.disruptions = [];
        S.option = null;
        stressTest();
      };

      const acts = h('div', { class: 'acts' },
        h('div', { class: 'acts__l' }, sourceSwitch,
          mine
            ? h('label', { class: 'f f--date' }, h('span', {}, 'day'), h('input', { type: 'date', value: S.mine.date, 'aria-label': 'which day of your schedule?', onchange: (e) => e.target.value && loadMine(e.target.value) }))
            : h('button', { class: 'ghost', type: 'button', onclick: () => loadSeed(S.seed + 1) }, icon('i-bolt'), 'another day')),
        h('div', { class: 'acts__r' },
          S.adopted ? h('button', { class: 'ghost', type: 'button', onclick: resetAdopted }, 'back to the original') : null,
          result && l3 && l3.play ? h('button', { class: 'ghost', type: 'button', onclick: replay }, icon('i-play'), 'replay') : null,
          result && result.lanes.repaired ? h('button', { class: 'solid', type: 'button', onclick: retest }, icon('i-bolt'), 'test again') : null,
          !result && !error ? h('button', { class: 'solid', type: 'button', onclick: breakDay }, icon('i-bolt'), 'break my day') : null));

      const more = result
        ? h('details', { class: 'more', ...(result.status === 'impossible' ? { open: true } : {}) }, h('summary', {}, 'details'),
          h('div', { class: 'more__grid' },
            result.conflicts.length ? conflictsCard(result) : null,
            result.changes.length ? changesCard(result) : null,
            result.deferred.length ? deferredCard(result) : null,
            result.status === 'impossible' ? impossibleCard(result) : guaranteesCard(result)))
        : null;

      page(S.say, fm, result ? waysRow(result, (k) => { S.option = k === 'minimize_changes' ? null : k; draw('repair'); }) : null, lanes, acts, more);
    }

    if (startOnMine) {
      startOnMine = false;
      // their own schedule when this site has an api, otherwise the generated sample day
      import('./api.js').then((m) => (m.apiEnabled ? loadMine() : loadSeed(firstDay())));
    } else loadSeed(firstDay());
  }

  const legend = () =>
    h('ul', { class: 'legend', 'aria-label': 'legend' },
      h('li', {}, h('i', { class: 'sw sw--task' }), 'flexible task'), h('li', {}, h('i', { class: 'sw sw--locked' }), 'locked (never moves)'), h('li', {}, h('i', { class: 'sw sw--break' }), 'protected break'),
      h('li', {}, h('i', { class: 'sw sw--injected' }), 'unexpected'), h('li', {}, h('i', { class: 'sw sw--conflict' }), 'in conflict'), h('li', {}, h('i', { class: 'sw sw--moved' }), 'moved by the repair'));

  /** the three ways forward, as three quiet choices */
  const waysRow = (res, onPick) =>
    h('div', { class: 'rpicks', role: 'radiogroup', 'aria-label': 'way forward' },
      res.options.map((o) => {
        const on = o.strategy === res.strategy;
        const v = o.view;
        return h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), disabled: !o.feasible, title: o.description + (o.sameAs ? ` Same day as “${res.options.find((x) => x.strategy === o.sameAs).title}”.` : ''), class: `pick${on ? ' is-on' : ''}${o.recommended ? ' pick--best' : ''}`, onclick: () => onPick(o.strategy) },
          h('b', {}, o.title),
          h('span', {}, o.feasible ? `${v.metrics.moved} ${v.metrics.moved === 1 ? 'move' : 'moves'} · ${dur(v.metrics.totalMinutes)}${v.metrics.deferred ? ` · ${v.metrics.deferred} wait` : ''}` : 'no valid day'));
      }));

  const conflictsCard = (res) =>
    h('section', { class: 'rcard' }, h('h3', {}, `${res.conflicts.length} ${res.conflicts.length === 1 ? 'conflict' : 'conflicts'} if you carry on`),
      h('ul', { class: 'cf' }, res.conflicts.map((c) => h('li', { class: `cf__i cf__i--${c.severity}` }, h('span', { class: 'cf__tag' }, c.severity), h('p', {}, emphasize(c.detail))))));

  const changesCard = (res) =>
    h('section', { class: 'rcard' }, h('h3', {}, res.strategy === 'minimize_changes' ? 'The smallest fix' : `Fix: ${res.options.find((o) => o.strategy === res.strategy).title}`),
      h('p', { class: 'muted' }, `${res.changes.length} ${res.changes.length === 1 ? 'item moves' : 'items move'}, ${dur(res.metrics.totalMinutes)} in total.${res.optimal ? (res.strategy === 'minimize_changes' ? ' Proven the smallest.' : ' Proven best for this way forward.') : ''}`),
      h('ul', { class: 'ch' }, res.changes.map((c) => h('li', {}, h('div', { class: 'ch__top' }, h('b', {}, c.title), h('span', { class: `ch__d ${c.deltaMinutes > 0 ? 'is-later' : 'is-earlier'}` }, `${c.deltaMinutes > 0 ? '+' : '−'}${Math.abs(c.deltaMinutes)}m`)), h('p', {}, `${fmt(c.from.start)} -> ${fmt(c.to.start)}`)))),
      null);

  const deferredCard = (res) =>
    h('section', { class: 'rcard rcard--warn' }, h('h3', {}, 'Deferred, not deleted'), h('ul', { class: 'cf' }, res.deferred.map((d) => h('li', {}, h('p', {}, d.message)))));

  const guaranteesCard = (res) =>
    h('section', { class: 'rcard' }, h('h3', {}, 'Rules, re-checked'),
      h('ul', { class: 'gu' }, res.guarantees.map((g) => h('li', { class: g.ok ? 'is-ok' : 'is-bad' }, icon(g.ok ? 'i-check' : 'i-x', 'gu__ico'), h('div', {}, h('b', {}, g.label), h('span', {}, g.detail))))));

  const impossibleCard = (res) =>
    h('section', { class: 'rcard rcard--bad' }, h('h3', {}, 'Why, and what would fix it'),
      h('ul', { class: 'cf' }, [...(res.diagnosis ? res.diagnosis.reasons.map((r) => h('li', {}, h('p', {}, emphasize(r.message)))) : []), ...(res.diagnosis ? res.diagnosis.suggestions.slice(0, 3).map((s) => h('li', { class: 'is-fix' }, h('span', { class: 'cf__tag' }, 'fix'), h('p', {}, emphasize(s.message)))) : [])]));

  /* ═════════════ tab 2: can you save this day? ═════════════ */

  function renderChallenge() {
    const token = ++opened;
    TZ = 'UTC';
    const C = { seed: 3, ch: null, disruptions: [], placements: {}, deferred: new Set(), selected: null, report: null, drag: null };
    cleanup = () => {};

    const atChallenge = (hh, mm) => E.CHALLENGE_DAY + hh * 60 + mm;
    const planNow = () => C.ch.plan;
    const load = (seed) => { C.seed = seed; C.ch = E.makeChallenge(seed); C.disruptions = []; C.report = null; C.selected = null; C.placements = {}; C.deferred = new Set(); draw(); };

    /** start the visitor from what happens if they carry on: every task where the cascade leaves it. */
    const startFix = () => {
      const sim = E.simulateCascade(planNow(), C.disruptions);
      C.placements = {};
      for (const o of sim.outcomes) {
        const src = planNow().items.find((i) => i.id === o.id);
        if (src && src.blocking && !src.locked && !o.injected) C.placements[o.id] = o.simulated.start;
      }
      C.deferred = new Set();
      C.report = null;
      C.selected = null;
    };

    const world = () => E.buildWorld(planNow(), C.disruptions);

    const attempt = () => ({ disruptions: C.disruptions, placements: Object.fromEntries(Object.entries(C.placements).filter(([id]) => !C.deferred.has(id))), deferred: [...C.deferred] });

    const blocksNow = (violations) => {
      const w = world();
      const bad = new Set(violations.flatMap((v) => [v.itemId, v.otherId].filter(Boolean)));
      const out = [];
      for (const l of w.locked) out.push({ id: l.id, title: l.title, kind: l.kind, start: l.start, end: l.start + l.duration, pieces: [{ start: l.start, end: l.start + l.duration }], locked: true, injected: l.injected, protectedBreak: l.kind === 'break', deadline: null, release: null, state: bad.has(l.id) ? 'conflict' : 'ok', shiftedBy: 0, conflictCodes: [] });
      for (const f of w.floaters) {
        if (C.deferred.has(f.id)) continue;
        const s = C.placements[f.id] ?? f.origStart;
        const src = planNow().items.find((i) => i.id === f.id);
        out.push({ id: f.id, title: f.title, kind: f.kind, start: s, end: s + f.duration, pieces: [{ start: s, end: s + f.duration }], locked: false, injected: false, protectedBreak: f.kind === 'break', deadline: src?.deadline ?? null, release: src?.release ?? null, state: bad.has(f.id) ? 'conflict' : s !== f.origStart ? 'moved' : 'ok', shiftedBy: s - f.origStart, conflictCodes: [] });
      }
      return out.sort((a, b) => a.start - b.start);
    };

    function draw() {
      if (token !== opened) return;
      const plan = planNow();
      const phase = C.report ? 'result' : C.disruptions.length ? 'fix' : 'break';
      const steps = h('ol', { class: 'steps' },
        ...[['1', 'Break it'], ['2', 'Fix it'], ['3', 'Compare']].map(([n, t], k) => h('li', { class: ['break', 'fix', 'result'].indexOf(phase) >= k ? 'is-on' : '' }, h('i', {}, n), t)));
      const main = h('section', { class: 'rs__main' });
      put(main, 
        h('div', { class: 'intro' },
          h('div', {}, h('span', { class: 'eyebrow' }, 'Interactive challenge'), h('h1', {}, 'Can you save ', h('em', {}, 'this day?')),
            h('p', {}, 'a fragile day. break it, fix it by hand: no locked event moves, no deadline is missed, lunch stays. then see how breakpoint would do it.')),
          h('div', { class: 'intro__btns' }, h('button', { class: 'btn-p', type: 'button', onclick: () => load(C.seed + 1) }, icon('i-bolt'), h('span', {}, 'New day')), steps)),
        h('div', { class: 'story rcard' }, h('b', {}, C.ch.title), h('span', {}, C.ch.story)),
      );
      const side = h('aside', { class: 'rs__side' });

      if (phase === 'break') {
        const r0 = rangeFor(plan, plan.items.map((i) => ({ start: i.start, end: i.start + i.duration })));
        const blocks0 = plan.items.filter((i) => i.blocking).map((i) => ({ id: i.id, title: i.title, kind: i.kind, start: i.start, end: i.start + i.duration, pieces: [{ start: i.start, end: i.start + i.duration }], locked: i.locked, injected: false, protectedBreak: i.kind === 'break', deadline: i.deadline ?? null, release: i.release ?? null, state: 'ok', shiftedBy: 0, conflictCodes: [] }));
        put(main, 
          h('div', { class: 'compare rcard' }, scrollX(axisEl(r0), laneEl({ title: 'Your day', sub: 'Looks fine. Looks.', tone: 'original', blocks: blocks0, r: r0, plan })), legend()),
          h('div', { class: 'rcard controls' },
            h('div', { class: 'controls__row' }, h('b', {}, 'Step 1: make something go wrong'),
              h('button', { class: 'btn-p', type: 'button', onclick: () => { C.disruptions = [...C.ch.suggested]; startFix(); draw(); } }, icon('i-bolt'), h('span', {}, cap(E.describeDisruption(C.ch.suggested[0], plan))))),
            h('p', { class: 'muted' }, 'Or choose your own:'),
            disruptionForm(plan, (d) => { C.disruptions = [d]; startFix(); draw(); }, atChallenge)),
        );
        put(side, h('section', { class: 'rcard' }, h('h3', {}, 'How it works'), h('ul', { class: 'cf' },
          h('li', {}, h('p', {}, 'The day is generated from a seed, so every visitor can get a different one.')),
          h('li', {}, h('p', {}, 'Your fix is checked by the same engine that Breakpoint uses. No account, no server.')),
          h('li', {}, h('p', {}, 'You are scored against the smallest valid change, computed exactly.')))));
        body.replaceChildren(h('div', { class: 'rs__grid' }, main, side));
        return;
      }

      const att = attempt();
      const { violations } = E.checkAttempt(plan, att);
      const blocks = blocksNow(violations);
      const r = rangeFor(plan, blocks, world().locked.map((l) => ({ start: l.start, end: l.start + l.duration })));

      put(main, h('div', { class: 'rcard controls' },
        h('div', { class: 'controls__row' }, h('b', {}, 'What went wrong'), h('button', { class: 'btn-g btn-g--sm', type: 'button', onclick: () => { C.disruptions = []; C.report = null; draw(); } }, 'Undo the disruption')),
        chips(plan, C.disruptions, (i) => { C.disruptions.splice(i, 1); if (C.disruptions.length) startFix(); C.report = null; draw(); }),
        disruptionForm(plan, (d) => { C.disruptions.push(d); startFix(); draw(); }, atChallenge)));

      // editable lane
      const lane = editableLane(blocks, r, plan, violations);
      const sel = C.selected && blocks.find((b) => b.id === C.selected && !b.locked);
      put(main, h('div', { class: 'compare rcard' },
        h('header', { class: 'stage__head' }, h('b', {}, 'Step 2: fix it'), h('span', { class: `count ${violations.length ? 'is-bad' : 'is-ok'}` }, violations.length ? `${violations.length} ${violations.length === 1 ? 'problem' : 'problems'}` : 'No problems')),
        scrollX(axisEl(r), lane),
        h('p', { class: 'muted muted--sm' }, 'Drag a flexible block (or select it and use the buttons). Locked blocks cannot move. Arrow keys nudge a selected block by 5 minutes.'),
        sel ? selectedBar(sel, plan) : null,
        trayEl(plan),
        legend()));

      const check = h('button', { class: 'btn-p', type: 'button', disabled: violations.length > 0, onclick: () => { try { C.report = E.judgeAttempt(plan, attempt()); } catch (e) { say(e.message); return; } draw(); } }, icon('i-check'), h('span', {}, violations.length ? 'Fix the problems to check' : 'Check my fix'));
      put(main, h('div', { class: 'checkrow' }, check, h('button', { class: 'btn-g', type: 'button', onclick: () => { startFix(); draw(); } }, 'Reset my fix')));

      // side: live problems, or the result
      if (C.report) {
        put(main, resultCard(C.report, blocks, r, plan));
        put(side, pipCard(C.report.pip, 'Pip compares'), ...(C.report.rescue.status !== 'impossible' ? [guaranteesCard(C.report.rescue)] : [impossibleCard(C.report.rescue)]));
      } else {
        put(side, 
          h('section', { class: `rcard ${violations.length ? 'rcard--bad' : ''}` }, h('h3', {}, violations.length ? 'What still breaks the rules' : 'Looks valid'),
            violations.length ? h('ul', { class: 'cf' }, violations.map((v) => h('li', {}, h('p', {}, emphasize(v.message))))) : h('p', { class: 'muted' }, 'No lock, deadline, break or overlap is broken. Press “Check my fix” to see how it compares with Breakpoint’s.')),
          pipCard(E.rescueDay(plan, C.disruptions).conflicts.slice(0, 2).map((c) => ({ kind: 'shortfall', text: c.detail })), 'What would have happened'),
        );
      }
      body.replaceChildren(h('div', { class: 'rs__grid' }, main, side));
    }

    const snap = (m) => Math.round(m / SNAP) * SNAP;

    function editableLane(blocks, r, plan, violations) {
      const track = trackBase(r, plan, blocks.filter((b) => b.protectedBreak));
      for (const b of blocks) {
        const src = plan.items.find((i) => i.id === b.id);
        if (src && src.deadline !== undefined && src.kind !== 'break' && !b.locked) track.append(h('i', { class: 'due', style: { left: `${pct(src.deadline, r)}%` }, title: `${b.title} is due ${fmt(src.deadline)}` }));
      }
      for (const b of blocks) {
        const el = h('div', {
          class: `${blockClasses(b, 0, false)}${b.locked ? '' : ' is-drag'}${C.selected === b.id ? ' is-sel' : ''}`, title: tipFor(b, plan), 'data-id': b.id,
          tabindex: b.locked ? null : 0, role: b.locked ? null : 'button', 'aria-label': b.locked ? null : `${b.title}, ${fmt(b.start)} to ${fmt(b.end)}. Arrow keys move it.`,
        }, blockInner(b, b.pieces[0], 0));
        place(el, b.start, b.end, r);
        if (!b.locked) {
          el.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            C.selected = b.id;
            try { el.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
            const rect = track.getBoundingClientRect();
            C.drag = { id: b.id, x0: e.clientX, s0: C.placements[b.id], dur: b.end - b.start, perPx: (r.hi - r.lo) / rect.width, moved: false };
            el.classList.add('is-dragging');
          });
          el.addEventListener('pointermove', (e) => {
            const d = C.drag;
            if (!d || d.id !== b.id) return;
            const dx = e.clientX - d.x0;
            if (Math.abs(dx) > 3) d.moved = true;
            const s = clamp(snap(d.s0 + dx * d.perPx), r.lo, r.hi - d.dur);
            C.placements[b.id] = s;
            place(el, s, s + d.dur, r);
            el.querySelector('span') && (el.querySelector('span').textContent = `${fmt(s)}–${fmt(s + d.dur)}`);
          });
          const end = () => { if (C.drag && C.drag.id === b.id) { C.drag = null; C.report = null; draw(); } };
          el.addEventListener('pointerup', end);
          el.addEventListener('pointercancel', end);
          el.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? 15 : SNAP;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              nudge(b, e.key === 'ArrowLeft' ? -step : step, r);
              requestAnimationFrame(() => body.querySelector(`.blk[data-id="${CSS.escape(b.id)}"]`)?.focus());
            } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); C.selected = b.id; draw(); }
          });
        }
        track.append(el);
      }
      void violations;
      return h('section', { class: 'lane lane--edit' }, h('header', { class: 'lane__head' }, h('b', {}, 'Your fix'), h('span', {}, 'drag the flexible blocks')), track);
    }

    function nudge(b, delta, r) {
      const dur = b.end - b.start;
      C.placements[b.id] = clamp(C.placements[b.id] + delta, r.lo, r.hi - dur);
      C.report = null;
      C.selected = b.id;
      draw();
    }

    function selectedBar(b, plan) {
      const r = rangeFor(plan, blocksNow([]));
      const f = world().floaters.find((x) => x.id === b.id);
      return h('div', { class: 'sel' }, h('b', {}, b.title), h('span', {}, `${fmt(b.start)}–${fmt(b.end)}`),
        h('div', { class: 'sel__btns' },
          ...[-15, -5, 5, 15].map((d) => h('button', { class: 'btn-g btn-g--sm', type: 'button', onclick: () => nudge(b, d, r) }, `${d > 0 ? '+' : '−'}${Math.abs(d)}m`)),
          h('button', { class: 'btn-g btn-g--sm', type: 'button', onclick: () => { C.placements[b.id] = f.origStart; C.report = null; draw(); } }, 'Back to planned'),
          f && f.deferrable ? h('button', { class: 'btn-g btn-g--sm', type: 'button', onclick: () => { C.deferred.add(b.id); C.selected = null; C.report = null; draw(); } }, 'Send to tomorrow') : null));
    }

    function trayEl(plan) {
      if (!C.deferred.size) return null;
      return h('div', { class: 'tray' }, h('b', {}, 'Tomorrow'), ...[...C.deferred].map((id) => {
        const f = world().floaters.find((x) => x.id === id);
        return h('button', { class: 'chip chip--btn', type: 'button', onclick: () => { C.deferred.delete(id); C.placements[id] = f.origStart; C.report = null; draw(); } }, `${f ? f.title : id} · bring back`);
      }), h('span', { class: 'muted muted--sm' }, 'Deferred tasks are kept, never deleted.'));
      void plan;
    }

    function resultCard(rep, blocks, r, plan) {
      const tone = rep.verdict === 'matched' || rep.verdict === 'better' ? 'good' : rep.verdict === 'valid_bigger' ? 'warn' : 'bad';
      const rcard = h('div', { class: `rcard result result--${tone}` },
        h('div', { class: 'result__top' }, h('div', { class: 'score' }, h('b', {}, rep.valid ? String(rep.score) : '–'), h('span', {}, 'score')), h('div', {}, h('h3', {}, rep.headline), h('p', { class: 'muted' }, rep.valid ? rep.scoreNote : 'Fix the rules above, then check again.'))));
      if (rep.valid && rep.rescue.lanes.repaired) {
        rcard.append(
          h('div', { class: 'vs' },
            h('div', { class: 'vs__lanes' }, axisEl(r),
              laneEl({ title: 'Your fix', sub: `${rep.yours.moved} moved · ${dur(rep.yours.totalMinutes)}`, tone: 'yours', blocks, r, plan }),
              laneEl({ title: 'Breakpoint’s fix', sub: `${rep.breakpoint.moved} moved · ${dur(rep.breakpoint.totalMinutes)}`, tone: 'repaired', blocks: rep.rescue.lanes.repaired.blocks, r, plan })),
            h('table', { class: 'cmp' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'You'), h('th', {}, 'Breakpoint'))),
              h('tbody', {}, rep.comparison.map((c) => h('tr', { class: c.yours <= c.ours ? 'is-ok' : 'is-more' }, h('th', {}, c.label), h('td', {}, String(c.yours)), h('td', {}, String(c.ours))))))),
        );
      }
      rcard.append(h('div', { class: 'result__btns' },
        h('button', { class: 'btn-p', type: 'button', onclick: () => { startFix(); draw(); } }, 'Try again'),
        h('button', { class: 'btn-g', type: 'button', onclick: () => load(C.seed + 1) }, 'New day')));
      return rcard;
    }

    load(C.seed);
  }

  /* ═════════════ open / close ═════════════ */

  async function show(which) {
    tab = which;
    tabBtns.forEach((b) => { const on = b.dataset.tab === which; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    cleanup();
    cleanup = () => {};
    body.replaceChildren(h('div', { class: 'rs__loading', role: 'status' }, h('i', { class: 'spin' }), h('span', {}, 'Loading the scheduling engine…')));
    const t = ++opened;
    try {
      E = await loadEngine();
    } catch (e) {
      body.replaceChildren(h('div', { class: 'rcard rcard--bad' }, h('b', {}, 'Couldn’t load the scheduling engine'), h('p', {}, 'Check your connection and reload the page.')));
      return;
    }
    if (t !== opened || !isOpen) return;
    try {
      if (which === 'rescue') renderRescue();
      else renderChallenge();
    } catch (e) {
      console.error(e);
      body.replaceChildren(h('div', { class: 'rcard rcard--bad' }, h('b', {}, 'Something went wrong'), h('p', {}, e.message)));
    }
    body.scrollTop = 0;
  }

  tabBtns.forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab !== tab) show(b.dataset.tab); }));
  root.querySelector('[data-rs-close]').addEventListener('click', () => close());
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...root.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });

  // a redraw can drop focus on the page behind (the focused block is replaced), where the handler above never hears the key
  document.addEventListener('keydown', (e) => {
    if (!isOpen || root.contains(document.activeElement)) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); root.querySelector('[data-rs-close]').focus({ preventScroll: true }); }
  });

  function open(which = 'rescue', opts = {}) {
    startOnMine = !!opts.mine;
    if (isOpen) { if (which !== tab) show(which); else if (startOnMine) show(which); return; }
    isOpen = true;
    returnFocus = document.activeElement;
    const lenis = getLenis();
    lenis && lenis.stop();
    pageRegions.forEach((r) => { r.inert = true; });
    document.body.classList.add('ob-open');
    root.hidden = false;
    requestAnimationFrame(() => root.classList.add('is-open'));
    show(which);
    root.querySelector('[data-rs-close]').focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    opened++;
    cleanup();
    root.classList.remove('is-open');
    const done = () => {
      root.hidden = true;
      document.body.classList.remove('ob-open');
      pageRegions.forEach((r) => { r.inert = false; });
      const lenis = getLenis();
      lenis && lenis.start();
      body.replaceChildren();
      returnFocus && returnFocus.focus && returnFocus.focus({ preventScroll: true });
    };
    if (reduce) done();
    else setTimeout(done, 260);
  }

  return { open, close, get isOpen() { return isOpen; } };
}
