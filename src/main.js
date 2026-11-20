import './styles.css';
import '@fontsource-variable/montserrat/wght.css';
import '@fontsource-variable/montserrat/wght-italic.css';
import '@fontsource-variable/nunito/wght-italic.css';
import '@fontsource-variable/figtree/wght.css';
import '@fontsource-variable/figtree/wght-italic.css';
import '@fontsource-variable/newsreader/wght.css';
import '@fontsource-variable/newsreader/wght-italic.css';
import 'lenis/dist/lenis.css';
import './onboarding.css';

import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { initOnboarding } from './onboarding.js';
import { initRescue } from './rescue.js';

gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin);
if (import.meta.env.DEV) { window.gsap = gsap; window.ScrollTrigger = ScrollTrigger; }

/* ───────────────────────── helpers ───────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || (import.meta.env.DEV && location.search.includes('static'));
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
const rem = () => parseFloat(getComputedStyle(root).fontSize); // 1rem = 100 design px
const SVGNS = 'http://www.w3.org/2000/svg';

/* orbit arc "A" — traced from the reference, smoothed with Catmull-Rom */
const ARC_A = [[1010,120],[983,130],[962,140],[944,150],[923,160],[898,180],[876,200],[862,220],[851,240],[840,260],[831,280],[823,300],[818,320],[814,350],[813,370],[815,390],[821,420],[828,440],[837,460],[850,480],[865,500],[885,520],[912,540],[947,560],[973,570]];
function smooth(pts) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0]} ${p2[1]}`;
  }
  return d;
}
$('#arcA').setAttribute('d', smooth(ARC_A));

/* split each multi-stroke "slashes" path into three separately animatable strokes */
$$('.slashes').forEach((svg) => {
  const p = svg.querySelector('path');
  if (!p) return;
  const parts = p.getAttribute('d').split('M').filter(Boolean);
  p.remove();
  parts.forEach((s) => {
    const n = document.createElementNS(SVGNS, 'path');
    n.setAttribute('d', 'M' + s);
    svg.appendChild(n);
  });
});

/* ───────────────────────── smooth scroll ───────────────────────── */
let lenis = null;
if (!reduce) {
  lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 1, smoothWheel: true, touchMultiplier: 1.4 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
const scrollToEl = (el, offset = 0) => {
  if (lenis) lenis.scrollTo(el, { offset, duration: 1.5, easing: (t) => 1 - Math.pow(1 - t, 4) });
  else el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* ───────────────────────── toast (placeholder for the app link) ───────────────────────── */
const toast = $('#toast');
let toastTimer;
function say(msg) {
  toast.textContent = msg;
  toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-on'), 2800);
}

const onboarding = initOnboarding({ getLenis: () => lenis, say });
const rescue = initRescue({ getLenis: () => lenis, say, onSetup: () => onboarding.open() });
onboarding.resumeFromRedirect(); // back from Google sign-in / consent? reopen the connector sheet where the user left off

/* ───────────────────────── nav ───────────────────────── */
const nav = $('#nav');
const navToggle = $('.nav__toggle');
function setMenu(open) {
  nav.classList.toggle('nav--open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
navToggle.addEventListener('click', () => setMenu(!nav.classList.contains('nav--open')));

$$('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (a.hasAttribute('data-rescue')) {
      e.preventDefault();
      setMenu(false);
      rescue.open(a.dataset.rescue);
      return;
    }
    if (a.hasAttribute('data-cta')) {
      e.preventDefault();
      setMenu(false);
      onboarding.open(a);
      return;
    }
    const target = id === '#top' ? document.body : $(id);
    if (!target) return;
    e.preventDefault();
    setMenu(false);
    if (id === '#top') return void (lenis ? lenis.scrollTo(0, { duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 4) }) : scrollTo({ top: 0, behavior: 'smooth' }));
    scrollToEl(target, id === '#ways' ? -rem() * 1.3 : 0);
  });
});

// theme (dark/light) follows whichever section sits under the bar
$$('[data-nav]').forEach((section) => {
  ScrollTrigger.create({
    trigger: section,
    start: 'top 56px',
    end: 'bottom 56px',
    onToggle: (self) => { if (self.isActive) nav.dataset.theme = section.dataset.nav; },
  });
});
// compact + frosted after the first scroll; tuck away on the closing screen while scrolling down
{
  const cta = $('#cta');
  let lastY = 0;
  const onScroll = () => {
    const y = window.scrollY;
    nav.classList.toggle('is-scrolled', y > 40);
    const inCta = cta.getBoundingClientRect().top < rem() * 1.2;
    if (Math.abs(y - lastY) > 3) {
      nav.classList.toggle('is-hidden', inCta && y > lastY && !nav.classList.contains('nav--open'));
      lastY = y;
    }
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ───────────────────────── interactions ───────────────────────── */
// pick a recovery strategy
{
  const ways = $$('.way');
  ways.forEach((w) =>
    w.addEventListener('click', () => {
      if (w.classList.contains('is-on')) return;
      ways.forEach((o) => { o.classList.toggle('is-on', o === w); o.setAttribute('aria-checked', String(o === w)); });
      if (!reduce) gsap.fromTo($$('.m', w), { scaleX: 0.82, opacity: 0.5 }, { scaleX: 1, opacity: 1, duration: 0.7, stagger: 0.05, ease: 'expo.out' });
    }),
  );
}
// magnetic primary buttons
if (finePointer && !reduce) {
  $$('[data-magnetic]').forEach((btn) => {
    const xTo = gsap.quickTo(btn, 'x', { duration: 0.6, ease: 'power3' });
    const yTo = gsap.quickTo(btn, 'y', { duration: 0.6, ease: 'power3' });
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.22);
      yTo((e.clientY - (r.top + r.height / 2)) * 0.32);
    });
    btn.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
  });
}

/* ───────────────────────── animation ───────────────────────── */
async function boot() {
  const wait = Promise.all([
    document.fonts.load('italic 300 40px "Montserrat Variable"'),
    document.fonts.load('700 24px "Montserrat Variable"'),
    document.fonts.load('italic 900 40px "Nunito Variable"'),
    document.fonts.load('500 20px "Figtree Variable"'),
    document.fonts.load('500 40px "Newsreader Variable"'),
    document.fonts.load('italic 600 40px "Newsreader Variable"'),
  ]).catch(() => {});
  await Promise.race([wait, new Promise((r) => setTimeout(r, 1600))]);

  if (reduce) { root.classList.add('anim-ready'); return; }

  heroIntro();
  heroScroll();
  lightSection();
  ctaSection();
  root.classList.add('anim-ready');

  addEventListener('load', () => ScrollTrigger.refresh());
}

/* ——— shared bits ——— */
function brushIn(sel, trigger, delay = 0) {
  return gsap.fromTo(sel, { clipPath: 'inset(0 100% 0 0)' }, {
    clipPath: 'inset(0 0% 0 0)', duration: 1.1, ease: 'power2.inOut', delay,
    scrollTrigger: trigger ? { trigger, start: 'top 80%' } : undefined,
  });
}
function loopSlashes(svg, trigger) {
  const paths = $$('path', svg);
  gsap.set(paths, { drawSVG: '0%' });
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.2, paused: true });
  tl.to(paths, { drawSVG: '100%', duration: 0.38, stagger: 0.12, ease: 'power2.out' })
    .to(paths, { opacity: 0.0, duration: 0.5, delay: 1.1, stagger: 0.05 })
    .set(paths, { drawSVG: '0%', opacity: 1 });
  ScrollTrigger.create({ trigger, start: 'top 90%', end: 'bottom top', onToggle: (s) => (s.isActive ? tl.play() : tl.pause()) });
  return tl;
}

/* ——— hero ——— */
function heroIntro() {
  const light = SplitText.create('.hero .display__light', { type: 'words' });
  const heavy = SplitText.create('.hero .display__word', { type: 'words,chars', charsClass: 'display__char' });
  const arcs = $$('.orbit .arc');
  const cards = [$('.card--b'), $('.card--a'), $('.card--c')];

  gsap.set('.orbit .dot', { opacity: 0 });
  gsap.set(arcs, { drawSVG: '0%' });

  const tl = gsap.timeline({ defaults: { ease: 'power3.out' }, delay: 0.1 });
  tl.fromTo('.nav__bar > *', { y: -22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, stagger: 0.07 }, 0)
    .fromTo(light.words, { yPercent: 80, opacity: 0, filter: 'blur(12px)' }, { yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: 1.2, stagger: 0.1, ease: 'expo.out', clearProps: 'transform,filter' }, 0.2)
    .fromTo(heavy.chars, { yPercent: 60, opacity: 0, scale: 0.72, rotate: 7, filter: 'blur(16px)' }, { yPercent: 0, opacity: 1, scale: 1, rotate: 0, filter: 'blur(0px)', duration: 1.25, stagger: 0.06, ease: 'back.out(1.6)', clearProps: 'transform,filter' }, 0.42)
    .fromTo('.brush--hero', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 1.1, ease: 'power2.inOut' }, 1.15)
    .fromTo('.lede', { y: 26, opacity: 0 }, { y: 0, opacity: 1, duration: 1, clearProps: 'transform' }, 0.9)
    .fromTo('.hero__ctas > *', { y: 24, opacity: 0, scale: 0.94 }, { y: 0, opacity: 1, scale: 1, duration: 0.9, stagger: 0.1, ease: 'back.out(1.5)' }, 1.05)
    .fromTo('.hero .works', { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9 }, 1.25)
    .fromTo(arcs, { drawSVG: '0%' }, { drawSVG: '100%', duration: 2, stagger: 0.12, ease: 'power2.inOut' }, 0.5)
    .fromTo(cards, { x: () => rem() * 1.4, y: () => rem() * 0.5, opacity: 0, scale: 0.9 }, { x: 0, y: 0, opacity: 1, scale: 1, duration: 1.4, stagger: 0.14, ease: 'expo.out' }, 0.55)
    .to('.orbit .dot', { opacity: 1, duration: 0.8 }, 1.6)
    .fromTo('.land--hero img', { y: () => rem() * 0.6, opacity: 0 }, { y: 0, opacity: 1, duration: 1.8, ease: 'expo.out' }, 0.3)
    .fromTo('.feat', { y: 28, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, stagger: 0.12 }, 1.4)
    .add(() => ambientHero(), 2.0);

  loopSlashes($('.land--hero .slashes'), '.hero');
}

function ambientHero() {
  // dot travels along the glowing arc
  const path = $('#arcB'), dot = $('.orbit .dot'), len = path.getTotalLength();
  const st = { t: 0.5 };
  const place = () => { const p = path.getPointAtLength(len * st.t); dot.setAttribute('transform', `translate(${p.x} ${p.y})`); };
  place();
  gsap.to(st, { t: 0.66, duration: 4.4, ease: 'sine.inOut', yoyo: true, repeat: -1, onUpdate: place })
    .progress(0.5);

  // idle float
  $$('.card__in').forEach((el, i) =>
    gsap.to(el, { y: -rem() * 0.07, duration: 3 + i * 0.6, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: i * 0.5 }));

  // the ripple: Practice slips, the neighbours feel it
  const rings = $$('.ripple');
  const rp = gsap.timeline({ repeat: -1, repeatDelay: 1.4, paused: true });
  rings.forEach((r, i) =>
    rp.fromTo(r, { opacity: 0.7, scaleX: 1, scaleY: 1 }, { opacity: 0, scaleX: 1.22, scaleY: 1.9, duration: 2.2, ease: 'power2.out' }, i * 0.55));
  rp.fromTo('.card--a, .card--c', { scale: 1 }, { scale: 1.03, duration: 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 0.5);
  rp.fromTo('.card--b .card__ico', { scale: 1 }, { scale: 1.25, duration: 0.3, yoyo: true, repeat: 1, ease: 'power2.out' }, 0);
  ScrollTrigger.create({ trigger: '.hero', start: 'top bottom', end: 'bottom top', onToggle: (s) => (s.isActive ? rp.play() : rp.pause()) });

  // pointer parallax on the glass cards
  if (finePointer) {
    const depth = { a: 16, b: 26, c: 12 };
    const q = {};
    for (const k of ['a', 'b', 'c']) {
      const el = $(`.card--${k}`);
      q[k] = [gsap.quickTo(el, 'x', { duration: 1.1, ease: 'power3' }), gsap.quickTo(el, 'y', { duration: 1.1, ease: 'power3' })];
    }
    const hero = $('.hero');
    hero.addEventListener('pointermove', (e) => {
      const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5;
      for (const k of ['a', 'b', 'c']) { q[k][0](nx * depth[k] * (rem() / 16)); q[k][1](ny * depth[k] * 0.7 * (rem() / 16)); }
    });
  }
}

function heroScroll() {
  const trig = { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.6, invalidateOnRefresh: true };
  gsap.to('[data-parallax="copy"]', { y: () => rem() * 0.3, opacity: 0.25, ease: 'none', scrollTrigger: trig });
  gsap.to('[data-parallax="stack"]', { y: () => rem() * 0.5, scale: 0.97, ease: 'none', scrollTrigger: trig });
  gsap.to('.hero__wash', { yPercent: 14, ease: 'none', scrollTrigger: trig });
}

/* ——— light section ——— */
function lightSection() {
  const reveal = (trigger, start = 'top 82%') => ({ trigger, start });

  const head = SplitText.create('.lhead__title .serif__a, .lhead__title .serif__b', { type: 'words' });
  gsap.fromTo(head.words, { yPercent: 55, opacity: 0, filter: 'blur(8px)' }, {
    yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: 1.2, stagger: 0.09, ease: 'expo.out', clearProps: 'transform,filter', scrollTrigger: reveal('.light'),
  });
  gsap.fromTo('.brush--light path', { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.1, delay: 0.55, ease: 'power2.inOut', scrollTrigger: reveal('.light') });
  gsap.fromTo('.lhead:not(.lhead--ways) .vr', { scaleY: 0 }, { scaleY: 1, duration: 1, delay: 0.3, ease: 'expo.out', scrollTrigger: reveal('.light') });
  gsap.fromTo('.lhead__copy p', { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 1, stagger: 0.14, delay: 0.45, ease: 'power3.out', scrollTrigger: reveal('.light') });

  /* the plan -> delay -> breaking-point demo */
  gsap.set('[data-practice]', { flexGrow: 212 });
  gsap.set('[data-project]', { display: 'flex', flexGrow: 166 });
  gsap.set('[data-alert]', { flexGrow: 0, opacity: 0 });
  gsap.set('.tl__ticks path', { drawSVG: '0%' });
  const dur = $('[data-dur]');
  const minutes = { v: 90 };
  const fmt = (m) => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
  dur.textContent = fmt(90);

  const tl = gsap.timeline({ scrollTrigger: { trigger: '#timeline', start: 'top 78%' }, defaults: { ease: 'power3.out' } });
  tl.fromTo('.tl__axis span', { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.06 }, 0)
    .fromTo('.tl__row', { y: 44, opacity: 0 }, { y: 0, opacity: 1, duration: 1, stagger: 0.16, ease: 'expo.out' }, 0.05)
    .fromTo('.tl__row--plan .seg', { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.8, stagger: 0.08, ease: 'expo.out' }, 0.35)
    .fromTo('.tl__row--delay .seg:not([data-alert])', { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.8, stagger: 0.08, ease: 'expo.out' }, 0.55)
    .fromTo('.tl__arrow path', { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.9, ease: 'power2.inOut' }, 0.8)
    // …and now the delay hits
    .addLabel('delay', 1.9)
    .to('[data-practice]', { flexGrow: 264, duration: 1.2, ease: 'power3.inOut' }, 'delay')
    .to(minutes, { v: 135, duration: 1.2, ease: 'power3.inOut', onUpdate: () => (dur.textContent = fmt(minutes.v)) }, 'delay')
    .to('[data-project]', { flexGrow: 0, opacity: 0, paddingLeft: 0, paddingRight: 0, marginLeft: () => -rem() * 0.08, duration: 0.9, ease: 'power3.inOut', onComplete() { this.targets()[0].style.display = 'none'; } }, 'delay')
    .to('[data-alert]', { flexGrow: 104, opacity: 1, duration: 1, ease: 'back.out(1.5)' }, 'delay+=0.35')
    .fromTo('.alert', { scale: 0.4, rotate: -30 }, { scale: 1, rotate: 0, duration: 0.8, ease: 'back.out(2.4)' }, 'delay+=0.7')
    .to('.tl__ticks path', { drawSVG: '100%', duration: 0.35, stagger: 0.1, ease: 'power2.out' }, 'delay+=0.9')
    .fromTo('.seg--alert', { x: 0 }, { x: 0, keyframes: { x: [0, -5, 5, -3, 3, 0] }, duration: 0.5, ease: 'none' }, 'delay+=0.85');
  gsap.to('.tl__ticks path', { opacity: 0.25, duration: 0.7, yoyo: true, repeat: -1, stagger: 0.15, ease: 'sine.inOut', delay: 4 });
  gsap.to('.alert', { boxShadow: '0 0 0 0.1rem rgba(245,196,174,0)', duration: 1.4, repeat: -1, ease: 'power1.out', delay: 4 });

  /* three ways forward */
  const wt = SplitText.create('.ways__title .split', { type: 'words' });
  gsap.fromTo(wt.words, { yPercent: 55, opacity: 0, filter: 'blur(8px)' }, { yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: 1.1, stagger: 0.09, ease: 'expo.out', clearProps: 'transform,filter', scrollTrigger: reveal('#ways', 'top 88%') });
  gsap.fromTo('.lhead--ways .vr', { scaleY: 0 }, { scaleY: 1, duration: 0.9, delay: 0.3, ease: 'expo.out', scrollTrigger: reveal('#ways', 'top 88%') });
  gsap.fromTo('.lhead--ways p', { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 1, delay: 0.4, scrollTrigger: reveal('#ways', 'top 88%') });
  const wayTl = gsap.timeline({ scrollTrigger: reveal('.ways', 'top 88%'), defaults: { ease: 'expo.out' } });
  wayTl.fromTo('.way', { y: 70, opacity: 0, rotate: 1.2 }, { y: 0, opacity: 1, rotate: 0, duration: 1.3, stagger: 0.13, clearProps: 'transform,translate,scale,rotate' }, 0)
    .fromTo('.way .m', { scaleX: 0 }, { scaleX: 1, duration: 0.9, stagger: 0.035 }, 0.45)
    .fromTo('.way.is-on .way__badge', { scale: 0 }, { scale: 1, duration: 0.7, ease: 'back.out(2.6)' }, 1.0);

  /* scenery */
  gsap.fromTo('.land--light img', { y: () => rem() * 0.9 }, { y: 0, ease: 'none', scrollTrigger: { trigger: '.light', start: 'top bottom', end: 'bottom bottom', scrub: 0.6, invalidateOnRefresh: true } });
  loopSlashes($('.land--light .slashes'), '.light');
}

/* ——— closing CTA ——— */
function ctaSection() {
  const at = { trigger: '.cta', start: 'top 62%' };
  const light = SplitText.create('.cta .display__light', { type: 'words' });
  const heavy = SplitText.create('.cta .display__word', { type: 'words,chars', charsClass: 'display__char' });

  const ring = $('.ring--outer');
  const inner = $('.ring--inner');
  gsap.set('.dot--cta', { opacity: 0 });
  gsap.set(ring, { drawSVG: '0%' });

  const tl = gsap.timeline({ scrollTrigger: at, defaults: { ease: 'power3.out' } });
  tl.fromTo('.brand--center', { y: -16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9 }, 0)
    .fromTo(light.words, { yPercent: 80, opacity: 0, filter: 'blur(12px)' }, { yPercent: 0, opacity: 1, filter: 'blur(0px)', duration: 1.2, stagger: 0.1, ease: 'expo.out', clearProps: 'transform,filter' }, 0.1)
    .fromTo(heavy.chars, { yPercent: 60, opacity: 0, scale: 0.75, rotate: 6, filter: 'blur(14px)' }, { yPercent: 0, opacity: 1, scale: 1, rotate: 0, filter: 'blur(0px)', duration: 1.2, stagger: 0.045, ease: 'back.out(1.6)', clearProps: 'transform,filter' }, 0.3)
    .fromTo('.brush--cta', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 1.1, ease: 'power2.inOut' }, 1.05)
    .fromTo('.cta__lede', { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 1 }, 0.9)
    .fromTo('.works--center li', { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, stagger: 0.1 }, 1.1)
    .fromTo('.cta__tag', { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9 }, 1.3)
    .fromTo('.cta .btn--xl', { y: 26, opacity: 0, scale: 0.86 }, { y: 0, opacity: 1, scale: 1, duration: 1.1, ease: 'back.out(1.8)' }, 1.45)
    .fromTo(ring, { drawSVG: '0%' }, { drawSVG: '100%', duration: 2.4, ease: 'power2.inOut' }, 0.2)
    .fromTo(inner, { opacity: 0 }, { opacity: 1, duration: 2 }, 0.6)
    .to('.dot--cta', { opacity: 1, duration: 0.8 }, 1.5)
    .add(() => ctaAmbient(), 1.6);

  gsap.fromTo('.land--cta img', { y: () => rem() * 1.0 }, { y: 0, ease: 'none', scrollTrigger: { trigger: '.cta', start: 'top bottom', end: 'top 20%', scrub: 0.6, invalidateOnRefresh: true } });
  loopSlashes($('.land--cta .slashes'), '.cta');
}

function ctaAmbient() {
  const path = $('#ringPath'), dot = $('.dot--cta'), len = path.getTotalLength();
  const st = { t: 0.34 };
  const place = () => { const p = path.getPointAtLength(len * st.t); dot.setAttribute('transform', `translate(${p.x} ${p.y})`); };
  place();
  gsap.to(st, { t: 0.62, duration: 7, ease: 'sine.inOut', yoyo: true, repeat: -1, onUpdate: place });
}

boot();
