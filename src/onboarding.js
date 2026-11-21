import gsap from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { initConnect, readReturn } from './connect.js';

gsap.registerPlugin(DrawSVGPlugin);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const STORE = 'breakpoint:onboarding';
const FLEX = ['Fixed (stick to plan)', 'Balanced (recommended)', 'Flexible (allow bigger changes)'];

const store = {
  read() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } },
  write(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

/**
 * onboarding overlay: welcome -> connect -> customize -> done.
 * opens from every "get started" / "try breakpoint" button.
 */
export function initOnboarding({ getLenis, say, onDone }) {
  const ob = $('#onboarding');
  const screens = $$('.scr', ob);
  const steps = $$('.stp', ob);
  const pip = $('.pip', ob);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || (import.meta.env.DEV && location.search.includes('static'));
  const pageRegions = ['#main', '#nav'].map((s) => $(s)).filter(Boolean);

  const state = { source: 'google', priorities: ['school'], flexibility: 1 };
  let idx = 0, busy = false, isOpen = false, returnFocus = null, working = false;
  let idle = [], slashTl = null, introTl = null;
  let imported = null; // what the connector brought in, for the done screen

  /** saves the picks so far. called before anything redirects away (google), so the page can pick up where it left off. */
  const persist = () => store.write({ source: state.source, priorities: state.priorities, flexibility: state.flexibility, draft: true });
  const connect = initConnect({ ob, say, reduce, persist });

  /* ───────── selections ───────── */
  const optBtns = $$('.opt', ob);
  const setSource = (value) => {
    state.source = value;
    optBtns.forEach((b) => { const on = b.dataset.value === value; b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
  };
  optBtns.forEach((b, i) => {
    b.addEventListener('click', () => setSource(b.dataset.value));
    b.addEventListener('keydown', (e) => {
      const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!k) return;
      e.preventDefault();
      const n = optBtns[(i + k + optBtns.length) % optBtns.length];
      setSource(n.dataset.value); n.focus();
    });
  });

  // priorities keep the order they were picked in: the first one picked is protected first
  const priBtns = $$('.pri', ob);
  const paintPriorities = () => priBtns.forEach((b) => { const on = state.priorities.includes(b.dataset.value); b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
  priBtns.forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.value;
    state.priorities = state.priorities.includes(v) ? state.priorities.filter((x) => x !== v) : [...state.priorities, v];
    paintPriorities();
  }));

  const flex = $('.flex', ob), range = $('.flex__range', ob), flexLabels = $$('.flex__labels button', ob);
  const setFlex = (v) => {
    v = Math.max(0, Math.min(2, +v)); state.flexibility = v; range.value = v;
    flex.style.setProperty('--p', `${((11.5 + v * 140) / 303) * 100}%`);
    flexLabels.forEach((b, i) => b.classList.toggle('is-on', i === v));
    range.setAttribute('aria-valuetext', FLEX[v]);
  };
  range.addEventListener('input', () => setFlex(range.value));
  flexLabels.forEach((b) => b.addEventListener('click', () => setFlex(b.dataset.v)));

  const saved = store.read();
  if (saved && !saved.skipped) {
    if (saved.source) setSource(saved.source);
    if (Array.isArray(saved.priorities)) state.priorities = saved.priorities.filter((v) => priBtns.some((b) => b.dataset.value === v));
    if (typeof saved.flexibility === 'number') setFlex(saved.flexibility);
  }
  setSource(state.source); setFlex(state.flexibility); paintPriorities();

  /* ───────── stepper ───────── */
  const paint = (i) => {
    steps.forEach((s, n) => {
      s.classList.toggle('is-current', n === i);
      s.classList.toggle('is-done', n < i || (i === 3 && n === 3));
      if (n === i) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current');
    });
    ob.dataset.step = i;
  };

  /* ───────── motion helpers ───────── */
  const kill = () => { idle.forEach((t) => t.kill()); idle = []; slashTl && slashTl.kill(); slashTl = null; introTl && introTl.kill(); introTl = null; };
  const loopSlashes = (svg) => {
    const paths = $$('path', svg);
    gsap.set(paths, { drawSVG: '0%', opacity: 1 });
    slashTl = gsap.timeline({ repeat: -1, repeatDelay: 2.4, delay: 1.2 });
    slashTl.to(paths, { drawSVG: '100%', duration: 0.35, stagger: 0.1, ease: 'power2.out' })
      .to(paths, { opacity: 0, duration: 0.5, delay: 1.1, stagger: 0.04 })
      .set(paths, { drawSVG: '0%', opacity: 1 });
  };
  const showPip = (on) => {
    if (reduce) { gsap.set(pip, { autoAlpha: on ? 1 : 0 }); return; }
    if (on) {
      gsap.fromTo(pip, { y: 90, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 1.5, delay: 0.25, ease: 'expo.out' });
      idle.push(gsap.to($('.pip__img', pip), { y: -7, duration: 2.8, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.2 }));
      loopSlashes($('.pip__slashes', pip));
    } else {
      gsap.to(pip, { y: 40, autoAlpha: 0, duration: 0.4, ease: 'power2.in' });
    }
  };

  const sweep = { duration: 0.9, ease: 'power3.out', clearProps: 'all' };

  const enter = {
    0() {
      const lines = $$('.ln', screens[0]);
      introTl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      introTl.fromTo(lines, { yPercent: 70, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 1, stagger: 0.13, ease: 'expo.out', clearProps: 'all' }, 0.05)
        .fromTo('.pipname', { scale: 0.7, rotate: -6, opacity: 0 }, { scale: 1, rotate: 0, opacity: 1, duration: 1, ease: 'back.out(2.2)', clearProps: 'all' }, 0.3)
        .fromTo($('.ob__brush--pip path', ob), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.9, ease: 'power2.inOut' }, 0.75)
        .fromTo('.ob__sub--welcome', { y: 22, opacity: 0 }, { y: 0, opacity: 1, ...sweep }, 0.55)
        .fromTo('.ob__btn--start', { y: 22, opacity: 0, scale: 0.92 }, { y: 0, opacity: 1, scale: 1, duration: 1, ease: 'back.out(1.6)', clearProps: 'all' }, 0.75);
    },
    1() {
      introTl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      introTl.fromTo('#ob-h1', { y: 26, opacity: 0 }, { y: 0, opacity: 1, ...sweep }, 0)
        .fromTo('#ob-h1 em', { y: 14, opacity: 0, skewX: -8 }, { y: 0, opacity: 1, skewX: 0, duration: 0.9, clearProps: 'all' }, 0.18)
        .fromTo('.ob__sub--center', { y: 18, opacity: 0 }, { y: 0, opacity: 1, ...sweep }, 0.2)
        .fromTo('.opt', { y: 34, opacity: 0, scale: 0.96 }, { y: 0, opacity: 1, scale: 1, duration: 1, stagger: 0.09, ease: 'expo.out', clearProps: 'all' }, 0.3)
        .fromTo('.scr--connect .ob__nav', { opacity: 0 }, { opacity: 1, duration: 0.7, clearProps: 'all' }, 0.7);
    },
    2() {
      introTl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      introTl.fromTo('#ob-h2', { y: 26, opacity: 0 }, { y: 0, opacity: 1, ...sweep }, 0)
        .fromTo('#ob-h2 em', { y: 14, opacity: 0, skewX: -8 }, { y: 0, opacity: 1, skewX: 0, duration: 0.9, clearProps: 'all' }, 0.18)
        .fromTo('.ob__sub--left', { y: 18, opacity: 0 }, { y: 0, opacity: 1, ...sweep }, 0.2)
        .fromTo('.col--prio .col__h, .col--prio .col__p, .col--flex .col__h, .col--flex .col__p', { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, stagger: 0.05, clearProps: 'all' }, 0.3)
        .fromTo('.pri', { x: -26, opacity: 0 }, { x: 0, opacity: 1, duration: 0.9, stagger: 0.08, ease: 'expo.out', clearProps: 'all' }, 0.4)
        .fromTo('.ob__vr', { scaleY: 0, transformOrigin: 'top' }, { scaleY: 1, duration: 0.9, ease: 'expo.out', clearProps: 'all' }, 0.4)
        .fromTo('.flex', { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, clearProps: 'all' }, 0.6)
        .fromTo('.scr--custom .ob__nav', { opacity: 0 }, { opacity: 1, duration: 0.7, clearProps: 'all' }, 0.8);
    },
    3() {
      const polaroid = $('.polaroid', ob);
      gsap.set(polaroid, { rotation: -8 });
      if (reduce) return;
      introTl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      introTl.fromTo(polaroid, { y: -340, rotation: 18, opacity: 0 }, { y: 0, rotation: -8, opacity: 1, duration: 1.35, ease: 'bounce.out' }, 0.05)
        .fromTo('.polaroid__tape', { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.5, ease: 'power2.out' }, 1)
        .fromTo('#ob-h3', { y: 26, opacity: 0 }, { y: 0, opacity: 1, ...sweep }, 0.35)
        .fromTo('#ob-h3 em', { y: 16, opacity: 0, scale: 0.8 }, { y: 0, opacity: 1, scale: 1, duration: 1, ease: 'back.out(2)', clearProps: 'all' }, 0.55)
        .fromTo('.ob__sub--done', { y: 20, opacity: 0 }, { y: 0, opacity: 1, ...sweep }, 0.6)
        .fromTo('.ob__btn--go', { y: 24, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 1, ease: 'back.out(1.7)', clearProps: 'all' }, 0.8)
        .fromTo($('.ob__brush--go path', ob), { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.8, ease: 'power2.inOut' }, 1.2)
        .add(() => confetti(polaroid), 0.85);
      idle.push(gsap.to(polaroid, { rotation: -7.2, y: -5, duration: 3.4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.8 }));
      loopSlashes($('.done__slashes', ob));
    },
  };

  function confetti(anchor) {
    const frame = $('.ob__frame', ob);
    const fr = frame.getBoundingClientRect(), r = anchor.getBoundingClientRect();
    const cx = r.left - fr.left + r.width / 2, cy = r.top - fr.top + r.height * 0.55;
    const u = parseFloat(getComputedStyle(ob).getPropertyValue('--u')) || 2;
    const colors = ['#9bd98a', '#f6ecdf', '#e9b872', '#c8f5b5', '#f2a99a'];
    const bits = [];
    for (let i = 0; i < 26; i++) {
      const el = document.createElement('i');
      const s = (4 + Math.random() * 5) * u;
      Object.assign(el.style, { position: 'absolute', left: `${cx}px`, top: `${cy}px`, width: `${s}px`, height: `${s * (Math.random() > 0.5 ? 1 : 0.45)}px`, background: colors[i % colors.length], borderRadius: Math.random() > 0.6 ? '50%' : '1px', pointerEvents: 'none', zIndex: 4 });
      frame.appendChild(el); bits.push(el);
      const a = Math.random() * Math.PI * 2, d = (90 + Math.random() * 190) * u;
      gsap.timeline({ onComplete: () => el.remove() })
        .to(el, { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.7 - 80 * u, rotation: Math.random() * 540 - 270, duration: 0.9, ease: 'power3.out' })
        .to(el, { y: `+=${190 * u}`, opacity: 0, duration: 1.1, ease: 'power1.in' }, 0.6);
    }
  }

  /* ───────── navigation ───────── */
  async function go(to) {
    if (busy || to === idx || to < 0 || to > 3) return;
    busy = true;
    const dir = to > idx ? 1 : -1;
    const from = screens[idx], next = screens[to];
    kill();
    if (!reduce) await gsap.to(from, { opacity: 0, x: -34 * dir, duration: 0.3, ease: 'power2.in' }).then();
    from.hidden = true; gsap.set(from, { clearProps: 'all' });
    $$('.ob__frame > i', ob).forEach((n) => n.remove());
    if (idx === 0) showPip(false);
    idx = to; paint(to);
    next.hidden = false;
    if (to === 0) showPip(true);
    if (!reduce) enter[to](dir); else if (to === 3) enter[3]();
    next.focus({ preventScroll: true });
    setTimeout(() => { busy = false; }, reduce ? 0 : 450);
  }

  const importNote = $('#ob-import', ob);
  const describeImport = (r) => {
    if (!r) return '';
    if (r.scratch) return 'Your new schedule is ready for you to fill in.';
    const n = r.total || 0;
    const noun = r.noun || 'item';
    return n ? `${n} ${n === 1 ? noun : noun + 's'} imported from ${r.label}.` : `Connected to ${r.label}. Nothing new to import.`;
  };
  const showImport = () => {
    const text = describeImport(imported);
    importNote.hidden = !text;
    $('span', importNote).textContent = text;
  };

  /** what "continue" does on the connect and customize steps: run the connector, or save the preferences. */
  async function proceed(btn) {
    if (working || busy) return;
    if (idx !== 1 && idx !== 2) return go(idx + 1);
    working = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      if (idx === 1) {
        persist();
        const r = await connect.start(state.source);
        if (!r.advance) return;
        imported = r.imported || null;
        showImport();
      } else {
        const label = $('span', btn), was = label.textContent;
        label.textContent = 'Saving…';
        await connect.savePrefs({ priorities: state.priorities, flexibility: state.flexibility });
        label.textContent = was;
      }
      go(idx + 1);
    } finally {
      working = false;
      btn.removeAttribute('aria-busy');
    }
  }
  $$('[data-next]', ob).forEach((b) => b.addEventListener('click', () => proceed(b)));
  $$('[data-back]', ob).forEach((b) => b.addEventListener('click', () => go(idx - 1)));
  $('[data-ob-skip]', ob).addEventListener('click', () => close('skip'));
  $('[data-finish]', ob).addEventListener('click', () => close('done'));

  /* ───────── open / close ───────── */
  const focusables = () => $$('button, [href], input, [tabindex]:not([tabindex="-1"])', ob).filter((el) => !el.disabled && el.offsetParent !== null && !el.closest('[hidden]'));
  ob.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close('skip'); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === screens[idx])) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /** `opts.step` opens straight on a later step (used when google sends the user back); `opts.onready` runs once it is showing. */
  function open(origin, opts = {}) {
    if (isOpen) return;
    isOpen = true; busy = true;
    const at = opts.step || 0;
    returnFocus = document.activeElement;
    const lenis = getLenis(); lenis && lenis.stop();
    pageRegions.forEach((r) => { r.inert = true; });
    document.body.classList.add('ob-open');
    kill();
    screens.forEach((s, n) => { s.hidden = n !== at; gsap.set(s, { clearProps: 'all' }); });
    idx = at; paint(at);
    ob.hidden = false;
    gsap.set(pip, { autoAlpha: 0 });

    const rect = origin && origin.getBoundingClientRect ? origin.getBoundingClientRect() : null;
    const cx = rect ? rect.left + rect.width / 2 : innerWidth / 2, cy = rect ? rect.top + rect.height / 2 : innerHeight / 2;
    const reach = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) + 40;
    const begin = () => {
      busy = false;
      if (at === 0) showPip(true);
      if (!reduce) enter[at](); else if (at === 3) enter[3]();
      screens[at].focus({ preventScroll: true });
      opts.onReady && opts.onReady();
    };
    if (reduce) { begin(); return; }
    gsap.fromTo(ob, { clipPath: `circle(0px at ${cx}px ${cy}px)` }, { clipPath: `circle(${reach}px at ${cx}px ${cy}px)`, duration: 0.95, ease: 'power3.inOut', clearProps: 'clipPath', onStart: () => setTimeout(begin, 380) });
  }

  function close(reason) {
    if (!isOpen) return;
    isOpen = false; busy = true;
    if (reason === 'done') store.write({ source: state.source, priorities: state.priorities, flexibility: state.flexibility, completedAt: new Date().toISOString() });
    else if (!store.read()) store.write({ skipped: true });
    else if (store.read().draft) store.write({ ...store.read(), draft: false });
    const finish = () => {
      kill();
      ob.hidden = true; document.body.classList.remove('ob-open');
      pageRegions.forEach((r) => { r.inert = false; });
      gsap.set([ob, pip, ...screens], { clearProps: 'all' });
      const lenis = getLenis(); lenis && lenis.start();
      busy = false;
      returnFocus && returnFocus.focus && returnFocus.focus({ preventScroll: true });
      if (reason === 'done') {
        say(`You’re all set${imported && !imported.scratch && imported.total ? ` — ${imported.total} ${imported.total === 1 ? 'item' : 'items'} imported` : ''}.`);
        if (onDone) onDone({ imported }); // "go to my plan": straight into rescue my day on the schedule they just built
      }
    };
    if (reduce) { finish(); return; }
    gsap.to(ob, { opacity: 0, scale: 1.02, duration: 0.45, ease: 'power2.in', onComplete: finish });
  }

  /**
   * after a redirect back from google (sign-in, consent or a refusal) the url says so: reopen the overlay on the
   * connect step with the connector sheet already showing the next step. returns true when it did.
   */
  function resumeFromRedirect() {
    const ret = readReturn();
    if (!ret) return false;
    open(null, {
      step: 1,
      onReady: async () => {
        working = true;
        try {
          const r = await connect.resume(ret);
          if (r.advance) { imported = r.imported || null; showImport(); go(2); }
        } finally { working = false; }
      },
    });
    return true;
  }

  return { open, close, resumeFromRedirect, get isOpen() { return isOpen; } };
}
