import './rescue.css';
import { h, icon, emphasize } from './dom.js';

/**
 * Rescue My Day + "Can you save this day?"
 *
 * Everything on this screen is computed by the real scheduling engine (server/src/engine), which is bundled into the
 * page, so it works on the static site with no account and no server. Nothing here is hardcoded: the days are generated
 * from a seed, the disruptions are yours, and every number, conflict and sentence is read from the engine's result.
 */

let enginePromise = null;
const loadEngine = () => (enginePromise ||= import('../server/src/engine/index.ts'));

const SNAP = 5;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function initRescue({ getLenis, say }) {
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

  const fmt = (m) => E.fmtClock(m, 'UTC');
  const dur = (m) => E.fmtDuration(m);

  /* ═════════════ timeline pieces ═════════════ */

  /** The day's visible span: every block (and every replay frame), 30 minutes either side, on whole hours. */
  const rangeFor = (plan, ...lists) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of lists.flat()) { lo = Math.min(lo, b.start); hi = Math.max(hi, b.end); }
    if (!Number.isFinite(lo)) for (const a of plan.settings.availability) { lo = Math.min(lo, a.start); hi = Math.max(hi, a.end); }
    return { lo: Math.floor((lo - 30) / 60) * 60, hi: Math.ceil((hi + 30) / 60) * 60 };
  };
  const pct = (m, r) => ((m - r.lo) / (r.hi - r.lo)) * 100;
  const place = (el, start, end, r) => { el.style.left = `${pct(start, r)}%`; el.style.width = `${((end - start) / (r.hi - r.lo)) * 100}%`; };

  const axisEl = (r) => {
    const el = h('div', { class: 'axis', 'aria-hidden': 'true' });
    for (let t = r.lo; t <= r.hi; t += 60) {
      const hour = Math.round(((t - E.CHALLENGE_DAY) / 60) % 24);
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

  /** A static lane: Original / After the disruption / Repaired / Yours. */
  const laneEl = ({ title, sub, tone, blocks, r, plan }) => {
    const track = trackBase(r, plan, blocks.filter((b) => b.protectedBreak));
    for (const b of blocks) {
      const src = plan.items.find((i) => i.id === b.id);
      if (src && src.deadline !== undefined && src.kind !== 'break' && !b.locked) track.append(h('i', { class: 'due', style: { left: `${pct(src.deadline, r)}%` }, title: `${b.title} is due ${fmt(src.deadline)}` }));
    }
    for (const b of blocks) {
      const pieces = b.pieces && b.pieces.length ? b.pieces : [{ start: b.start, end: b.end }];
      pieces.forEach((p, i) => {
        const el = h('div', { class: blockClasses(b, i, false), title: tipFor(b, plan), 'data-id': b.id }, blockInner(b, p, i));
        place(el, p.start, p.end, r);
        track.append(el);
      });
    }
    return h('section', { class: `lane lane--${tone || 'plain'}` }, h('header', { class: 'lane__head' }, h('b', {}, title), h('span', {}, sub || '')), track);
  };

  /** The replay stage: blocks keep their element between frames so they glide to their new place. */
  const makeStage = (r, plan, firstFrame) => {
    const track = trackBase(r, plan, firstFrame.blocks.filter((b) => b.protectedBreak));
    for (const b of firstFrame.blocks) {
      const src = plan.items.find((i) => i.id === b.id);
      if (src && src.deadline !== undefined && src.kind !== 'break' && !b.locked) track.append(h('i', { class: 'due', style: { left: `${pct(src.deadline, r)}%` }, title: `${b.title} is due ${fmt(src.deadline)}` }));
    }
    const els = new Map();
    const update = (frame) => {
      const seen = new Set();
      for (const b of frame.blocks) {
        const pieces = b.pieces && b.pieces.length ? b.pieces : [{ start: b.start, end: b.end }];
        pieces.forEach((p, i) => {
          const key = `${b.id}:${i}`;
          seen.add(key);
          const focus = frame.focus.includes(b.id);
          let el = els.get(key);
          if (!el) {
            el = h('div', { class: blockClasses(b, i, focus), 'data-id': b.id }, blockInner(b, p, i));
            place(el, p.start, p.end, r);
            els.set(key, el);
            track.append(el);
          } else {
            el.className = blockClasses(b, i, focus);
            place(el, p.start, p.end, r);
            if (i === 0) { const s = el.querySelector('span'); if (s) s.textContent = `${fmt(b.start)}–${fmt(b.end)}`; }
          }
          el.title = tipFor(b, plan);
        });
      }
      for (const [key, el] of els) if (!seen.has(key)) { el.remove(); els.delete(key); }
    };
    update(firstFrame);
    return { track, update };
  };

  /* ═════════════ shared small widgets ═════════════ */

  const pipCard = (lines, title = 'Pip explains why') =>
    h('section', { class: 'rcard pipc' },
      h('header', { class: 'pipc__head' }, h('img', { class: 'pipc__img', src: '/art/pip-photo.webp', alt: '', width: 48, height: 48 }), h('div', {}, h('b', {}, title), h('span', {}, 'Every number below was computed, not guessed.'))),
      h('ul', { class: 'pipc__list' }, lines.map((l) => h('li', { class: `pipc__line pipc__line--${l.kind}` }, emphasize(l.text)))),
    );

  /** A wide timeline inside a narrow screen scrolls sideways on its own, while the text around it stays put. */
  const scrollX = (...kids) => h('div', { class: 'tl' }, h('div', { class: 'tl__in' }, kids));

  const seg = (name, options, value, onChange) => {
    const wrap = h('div', { class: 'rseg', role: 'radiogroup', 'aria-label': name });
    const paint = (v) => [...wrap.children].forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    for (const [v, label] of options) wrap.append(h('button', { type: 'button', role: 'radio', 'data-v': v, onclick: () => { paint(v); onChange(v); } }, label));
    paint(value);
    return wrap;
  };

  const TYPE_LABEL = { overrun: 'Runs long', delay: 'Starts late', unexpected: 'Surprise commitment', lost_time: 'Lost time' };

  /** The "what goes wrong?" form. Builds real engine disruptions from whatever the visitor chooses. */
  const disruptionForm = (plan, onAdd) => {
    const tasks = plan.items.filter((i) => i.blocking && !i.locked && i.kind !== 'break');
    const type = h('select', { 'aria-label': 'What goes wrong?' }, Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
    const target = h('select', { 'aria-label': 'Which task?' }, tasks.map((t) => h('option', { value: t.id }, t.title)));
    const minutes = h('input', { type: 'number', min: 5, max: 480, step: 5, value: 45, 'aria-label': 'How many minutes?' });
    const time = h('input', { type: 'time', value: '15:00', 'aria-label': 'At what time?' });
    const name = h('input', { type: 'text', maxlength: 40, placeholder: 'Surprise meeting', 'aria-label': 'What is it?' });
    const err = h('p', { class: 'form__err', role: 'alert', hidden: true });
    const rows = {
      target: h('label', { class: 'f' }, h('span', {}, 'Task'), target),
      minutes: h('label', { class: 'f f--sm' }, h('span', {}, 'Minutes'), minutes),
      time: h('label', { class: 'f f--sm' }, h('span', {}, 'At'), time),
      name: h('label', { class: 'f' }, h('span', {}, 'What'), name),
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
        if (!(m >= 5 && m <= 480)) { err.textContent = 'Use between 5 and 480 minutes.'; err.hidden = false; return; }
        err.hidden = true;
        const [hh, mm] = time.value.split(':').map(Number);
        const at = E.CHALLENGE_DAY + (hh || 0) * 60 + (mm || 0);
        const t = type.value;
        if (t === 'overrun' || t === 'delay') onAdd({ type: t, targetId: target.value, minutes: m });
        else if (t === 'unexpected') onAdd({ type: 'unexpected', start: at, duration: m, title: name.value.trim() || 'Surprise meeting', priority: 5 });
        else onAdd({ type: 'lost_time', minutes: m, start: at });
      },
    }, icon('i-plus'), 'Add');
    return h('div', { class: 'form' }, h('div', { class: 'form__row' }, h('label', { class: 'f' }, h('span', {}, 'What goes wrong?'), type), rows.target, rows.minutes, rows.time, rows.name, add), err);
  };

  const chips = (plan, disruptions, onRemove) =>
    h('ul', { class: 'chips', 'aria-label': 'Disruptions' }, disruptions.length
      ? disruptions.map((d, i) => h('li', { class: 'chip' }, h('span', {}, cap(E.describeDisruption(d, plan))), h('button', { type: 'button', 'aria-label': `Remove: ${E.describeDisruption(d, plan)}`, onclick: () => onRemove(i) }, icon('i-x'))))
      : [h('li', { class: 'chip chip--empty' }, 'Nothing has gone wrong yet.')]);

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ═════════════ tab 1: Rescue my day ═════════════ */

  function renderRescue() {
    const token = ++opened;
    const S = { seed: 0, ch: null, disruptions: [], mobility: 'balanced', result: null, player: null };
    const stop = () => { if (S.player) S.player.stop(); };
    cleanup = stop;

    const loadSeed = (seed) => {
      S.seed = seed;
      S.ch = E.makeChallenge(seed);
      S.disruptions = [...S.ch.suggested];
      S.mobility = 'balanced';
      draw(true);
    };

    const planNow = () => ({ ...S.ch.plan, settings: { ...S.ch.plan.settings, mobility: S.mobility } });

    function draw(autoplay) {
      if (token !== opened) return;
      stop();
      const plan = planNow();
      let result = null;
      let error = null;
      try { result = S.disruptions.length ? E.rescueDay(plan, S.disruptions) : null; } catch (e) { error = e; }
      S.result = result;

      const main = h('section', { class: 'rs__main' });
      main.append(
        h('div', { class: 'intro' },
          h('div', {},
            h('span', { class: 'eyebrow' }, 'Signature feature'),
            h('h1', {}, 'Rescue ', h('em', {}, 'my day.')),
            h('p', {}, 'When a day breaks, Breakpoint computes the smallest change that makes it valid again, and shows you the original, the broken day and the repaired day side by side.'),
          ),
          h('div', { class: 'intro__btns' },
            h('button', { class: 'btn-p', type: 'button', onclick: () => loadSeed(S.seed + 1) }, icon('i-bolt'), h('span', {}, 'Try another sample day')),
            h('button', { class: 'btn-g', type: 'button', onclick: () => { S.disruptions = []; draw(false); } }, 'Start without a disruption'),
          ),
        ),
        h('div', { class: 'story rcard' }, h('b', {}, S.ch.title), h('span', {}, S.ch.story)),
        h('div', { class: 'controls rcard' },
          h('div', { class: 'controls__row' }, h('span', { class: 'lbl' }, 'How flexible is the day?'), seg('Flexibility', [['fixed', 'Fixed'], ['balanced', 'Balanced'], ['flexible', 'Flexible']], S.mobility, (v) => { S.mobility = v; draw(true); })),
          chips(plan, S.disruptions, (i) => { S.disruptions.splice(i, 1); draw(true); }),
          disruptionForm(plan, (d) => { S.disruptions.push(d); draw(true); }),
        ),
      );

      const side = h('aside', { class: 'rs__side' });
      if (error) {
        main.append(h('div', { class: 'rcard rcard--bad' }, h('b', {}, 'That disruption can’t be applied'), h('p', {}, error.message)));
        body.replaceChildren(h('div', { class: 'rs__grid' }, main, side));
        return;
      }
      if (!result) {
        const r0 = rangeFor(plan, S.ch.plan.items.map((i) => ({ start: i.start, end: i.start + i.duration })));
        const blocks0 = S.ch.plan.items.filter((i) => i.blocking).map((i) => ({ id: i.id, title: i.title, kind: i.kind, start: i.start, end: i.start + i.duration, pieces: [{ start: i.start, end: i.start + i.duration }], locked: i.locked, injected: false, protectedBreak: i.kind === 'break', deadline: i.deadline ?? null, release: i.release ?? null, state: 'ok', shiftedBy: 0, conflictCodes: [] }));
        main.append(h('div', { class: 'compare rcard' }, scrollX(axisEl(r0), laneEl({ title: 'Your day as planned', sub: 'Add a disruption above to break it', tone: 'original', blocks: blocks0, r: r0, plan }))));
        body.replaceChildren(h('div', { class: 'rs__grid' }, main, side));
        return;
      }

      const allBlocks = [result.lanes.original.blocks, result.lanes.disrupted.blocks, result.lanes.repaired ? result.lanes.repaired.blocks : [], ...result.replay.map((f) => f.blocks)];
      const r = rangeFor(plan, ...allBlocks);

      main.append(h('div', { class: `banner banner--${result.status}` }, h('b', {}, bannerTitle(result.status)), h('span', {}, result.headline)));

      // replay
      const stage = makeStage(r, plan, result.replay[0]);
      const caption = h('p', { class: 'replay__cap', 'aria-live': 'polite' });
      const phase = h('span', { class: 'replay__phase' });
      const scrub = h('input', { type: 'range', min: 0, max: result.replay.length - 1, step: 1, value: 0, 'aria-label': 'Replay position' });
      const playBtn = h('button', { class: 'btn-p btn-p--sm', type: 'button' });
      let i = 0;
      let timer = null;
      const go = (n) => {
        i = clamp(n, 0, result.replay.length - 1);
        const f = result.replay[i];
        stage.update(f);
        caption.replaceChildren(...emphasize(f.caption));
        phase.textContent = PHASE[f.phase];
        phase.dataset.phase = f.phase;
        scrub.value = String(i);
      };
      const stopP = () => { clearInterval(timer); timer = null; playBtn.replaceChildren(icon('i-play'), h('span', {}, i >= result.replay.length - 1 ? 'Replay' : 'Play')); };
      const startP = () => {
        if (i >= result.replay.length - 1) go(0);
        playBtn.replaceChildren(icon('i-pause'), h('span', {}, 'Pause'));
        timer = setInterval(() => { if (i >= result.replay.length - 1) { stopP(); return; } go(i + 1); }, 1900);
      };
      playBtn.addEventListener('click', () => (timer ? stopP() : startP()));
      scrub.addEventListener('input', () => { stopP(); go(Number(scrub.value)); });
      S.player = { stop: () => { clearInterval(timer); timer = null; } };
      go(0);
      stopP();

      main.append(
        h('div', { class: 'stage rcard' },
          h('header', { class: 'stage__head' }, h('b', {}, 'Replay'), phase),
          scrollX(axisEl(r), h('section', { class: 'lane lane--stage' }, stage.track)),
          h('div', { class: 'replay' },
            h('button', { class: 'btn-g btn-g--sm', type: 'button', 'aria-label': 'Previous step', onclick: () => { stopP(); go(i - 1); } }, icon('i-arrow-left')),
            playBtn,
            h('button', { class: 'btn-g btn-g--sm', type: 'button', 'aria-label': 'Next step', onclick: () => { stopP(); go(i + 1); } }, icon('i-arrow')),
            scrub,
          ),
          caption,
        ),
        h('div', { class: 'compare rcard' },
          h('header', { class: 'stage__head' }, h('b', {}, 'Side by side')),
          scrollX(axisEl(r),
          laneEl({ title: 'Original', sub: result.lanes.original.summary, tone: 'original', blocks: result.lanes.original.blocks, r, plan }),
          laneEl({ title: 'After the disruption', sub: result.lanes.disrupted.summary, tone: 'disrupted', blocks: result.lanes.disrupted.blocks, r, plan }),
          result.lanes.repaired
            ? laneEl({ title: 'Repaired', sub: result.lanes.repaired.summary, tone: 'repaired', blocks: result.lanes.repaired.blocks, r, plan })
            : h('section', { class: 'lane lane--none' }, h('header', { class: 'lane__head' }, h('b', {}, 'Repaired'), h('span', {}, 'No valid schedule exists')), h('p', { class: 'lane__none' }, 'Nothing was changed. Pip explains why on the right.'))),
          legend(),
        ),
      );

      side.append(
        pipCard(result.pip),
        result.conflicts.length ? conflictsCard(result) : null,
        result.changes.length ? changesCard(result) : null,
        result.deferred.length ? deferredCard(result) : null,
        result.status === 'impossible' ? impossibleCard(result) : guaranteesCard(result),
      );
      body.replaceChildren(h('div', { class: 'rs__grid' }, main, side));
      if (autoplay && !reduce) setTimeout(() => { if (token === opened && !timer) startP(); }, 500);
    }

    loadSeed(0);
  }

  const PHASE = { original: 'As planned', disruption: 'Something goes wrong', conflicts: 'If you carry on', repair: 'The repair', done: 'Repaired' };
  const bannerTitle = (s) => ({ absorbed: 'Absorbed', repaired: 'Rescued', repaired_with_deferrals: 'Rescued, with deferrals', impossible: 'No valid schedule exists' })[s];

  const legend = () =>
    h('ul', { class: 'legend', 'aria-label': 'Legend' },
      h('li', {}, h('i', { class: 'sw sw--task' }), 'Flexible task'), h('li', {}, h('i', { class: 'sw sw--locked' }), 'Locked (never moves)'), h('li', {}, h('i', { class: 'sw sw--break' }), 'Protected break'),
      h('li', {}, h('i', { class: 'sw sw--injected' }), 'Unexpected'), h('li', {}, h('i', { class: 'sw sw--conflict' }), 'In conflict'), h('li', {}, h('i', { class: 'sw sw--moved' }), 'Moved by the repair'));

  const conflictsCard = (res) =>
    h('section', { class: 'rcard' }, h('h3', {}, `${res.conflicts.length} ${res.conflicts.length === 1 ? 'conflict' : 'conflicts'} if you carry on`),
      h('ul', { class: 'cf' }, res.conflicts.map((c) => h('li', { class: `cf__i cf__i--${c.severity}` }, h('span', { class: 'cf__tag' }, c.severity), h('p', {}, emphasize(c.detail))))));

  const changesCard = (res) =>
    h('section', { class: 'rcard' }, h('h3', {}, 'The smallest fix'),
      h('p', { class: 'muted' }, `${res.changes.length} ${res.changes.length === 1 ? 'item moves' : 'items move'}, ${dur(res.metrics.totalMinutes)} in total.${res.optimal ? ' Proven the smallest.' : ''}`),
      h('ul', { class: 'ch' }, res.changes.map((c) => h('li', {}, h('div', { class: 'ch__top' }, h('b', {}, c.title), h('span', { class: `ch__d ${c.deltaMinutes > 0 ? 'is-later' : 'is-earlier'}` }, `${c.deltaMinutes > 0 ? '+' : '−'}${Math.abs(c.deltaMinutes)}m`)), h('p', {}, `${fmt(c.from.start)} → ${fmt(c.to.start)}`)))),
      res.alternatives.length ? h('p', { class: 'muted muted--sm' }, 'Other strategies: ', res.alternatives.map((a) => `${a.title} moves ${a.moved} (${dur(a.totalMinutes)})`).join(' · ')) : null);

  const deferredCard = (res) =>
    h('section', { class: 'rcard rcard--warn' }, h('h3', {}, 'Deferred, not deleted'), h('ul', { class: 'cf' }, res.deferred.map((d) => h('li', {}, h('p', {}, d.message)))));

  const guaranteesCard = (res) =>
    h('section', { class: 'rcard' }, h('h3', {}, 'Rules, re-checked'),
      h('ul', { class: 'gu' }, res.guarantees.map((g) => h('li', { class: g.ok ? 'is-ok' : 'is-bad' }, icon(g.ok ? 'i-check' : 'i-x', 'gu__ico'), h('div', {}, h('b', {}, g.label), h('span', {}, g.detail))))));

  const impossibleCard = (res) =>
    h('section', { class: 'rcard rcard--bad' }, h('h3', {}, 'Why, and what would fix it'),
      h('ul', { class: 'cf' }, [...(res.diagnosis ? res.diagnosis.reasons.map((r) => h('li', {}, h('p', {}, emphasize(r.message)))) : []), ...(res.diagnosis ? res.diagnosis.suggestions.slice(0, 3).map((s) => h('li', { class: 'is-fix' }, h('span', { class: 'cf__tag' }, 'fix'), h('p', {}, emphasize(s.message)))) : [])]));

  /* ═════════════ tab 2: Can you save this day? ═════════════ */

  function renderChallenge() {
    const token = ++opened;
    const C = { seed: 3, ch: null, disruptions: [], placements: {}, deferred: new Set(), selected: null, report: null, drag: null };
    cleanup = () => {};

    const planNow = () => C.ch.plan;
    const load = (seed) => { C.seed = seed; C.ch = E.makeChallenge(seed); C.disruptions = []; C.report = null; C.selected = null; C.placements = {}; C.deferred = new Set(); draw(); };

    /** Start the visitor from what happens if they carry on: every task where the cascade leaves it. */
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
      main.append(
        h('div', { class: 'intro' },
          h('div', {}, h('span', { class: 'eyebrow' }, 'Interactive challenge'), h('h1', {}, 'Can you save ', h('em', {}, 'this day?')),
            h('p', {}, 'You get a deliberately fragile day. Break it, then fix it by hand without moving a locked event, missing a deadline or touching the lunch. Breakpoint then shows how it would have done it.')),
          h('div', { class: 'intro__btns' }, h('button', { class: 'btn-p', type: 'button', onclick: () => load(C.seed + 1) }, icon('i-bolt'), h('span', {}, 'New day')), steps)),
        h('div', { class: 'story rcard' }, h('b', {}, C.ch.title), h('span', {}, C.ch.story)),
      );
      const side = h('aside', { class: 'rs__side' });

      if (phase === 'break') {
        const r0 = rangeFor(plan, plan.items.map((i) => ({ start: i.start, end: i.start + i.duration })));
        const blocks0 = plan.items.filter((i) => i.blocking).map((i) => ({ id: i.id, title: i.title, kind: i.kind, start: i.start, end: i.start + i.duration, pieces: [{ start: i.start, end: i.start + i.duration }], locked: i.locked, injected: false, protectedBreak: i.kind === 'break', deadline: i.deadline ?? null, release: i.release ?? null, state: 'ok', shiftedBy: 0, conflictCodes: [] }));
        main.append(
          h('div', { class: 'compare rcard' }, scrollX(axisEl(r0), laneEl({ title: 'Your day', sub: 'Looks fine. Looks.', tone: 'original', blocks: blocks0, r: r0, plan })), legend()),
          h('div', { class: 'rcard controls' },
            h('div', { class: 'controls__row' }, h('b', {}, 'Step 1: make something go wrong'),
              h('button', { class: 'btn-p', type: 'button', onclick: () => { C.disruptions = [...C.ch.suggested]; startFix(); draw(); } }, icon('i-bolt'), h('span', {}, cap(E.describeDisruption(C.ch.suggested[0], plan))))),
            h('p', { class: 'muted' }, 'Or choose your own:'),
            disruptionForm(plan, (d) => { C.disruptions = [d]; startFix(); draw(); })),
        );
        side.append(h('section', { class: 'rcard' }, h('h3', {}, 'How it works'), h('ul', { class: 'cf' },
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

      main.append(h('div', { class: 'rcard controls' },
        h('div', { class: 'controls__row' }, h('b', {}, 'What went wrong'), h('button', { class: 'btn-g btn-g--sm', type: 'button', onclick: () => { C.disruptions = []; C.report = null; draw(); } }, 'Undo the disruption')),
        chips(plan, C.disruptions, (i) => { C.disruptions.splice(i, 1); if (C.disruptions.length) startFix(); C.report = null; draw(); }),
        disruptionForm(plan, (d) => { C.disruptions.push(d); startFix(); draw(); })));

      // editable lane
      const lane = editableLane(blocks, r, plan, violations);
      const sel = C.selected && blocks.find((b) => b.id === C.selected && !b.locked);
      main.append(h('div', { class: 'compare rcard' },
        h('header', { class: 'stage__head' }, h('b', {}, 'Step 2: fix it'), h('span', { class: `count ${violations.length ? 'is-bad' : 'is-ok'}` }, violations.length ? `${violations.length} ${violations.length === 1 ? 'problem' : 'problems'}` : 'No problems')),
        scrollX(axisEl(r), lane),
        h('p', { class: 'muted muted--sm' }, 'Drag a flexible block (or select it and use the buttons). Locked blocks cannot move. Arrow keys nudge a selected block by 5 minutes.'),
        sel ? selectedBar(sel, plan) : null,
        trayEl(plan),
        legend()));

      const check = h('button', { class: 'btn-p', type: 'button', disabled: violations.length > 0, onclick: () => { try { C.report = E.judgeAttempt(plan, attempt()); } catch (e) { say(e.message); return; } draw(); } }, icon('i-check'), h('span', {}, violations.length ? 'Fix the problems to check' : 'Check my fix'));
      main.append(h('div', { class: 'checkrow' }, check, h('button', { class: 'btn-g', type: 'button', onclick: () => { startFix(); draw(); } }, 'Reset my fix')));

      // side: live problems, or the result
      if (C.report) {
        main.append(resultCard(C.report, blocks, r, plan));
        side.append(pipCard(C.report.pip, 'Pip compares'), ...(C.report.rescue.status !== 'impossible' ? [guaranteesCard(C.report.rescue)] : [impossibleCard(C.report.rescue)]));
      } else {
        side.append(
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

  function open(which = 'rescue') {
    if (isOpen) { if (which !== tab) show(which); return; }
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
