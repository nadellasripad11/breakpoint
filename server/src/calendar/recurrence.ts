import type { Interval, Minutes } from '../engine/index.ts';
import { zonedToMin } from '../engine/index.ts';

/**
 * rrule subset used by real calendars: freq (daily/weekly/monthly/yearly), interval, count, until,
 * byday (with ordinals such as 1mo / -1fr), bymonthday (negative allowed), bymonth, wkst, plus exdate handled by the caller.
 * occurrences keep the same wall-clock time across dst changes (a 9:00 meeting stays at 9:00).
 */

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: { y: number; mo: number; d: number; h: number; mi: number; utc: boolean };
  byDay: { n?: number; day: number }[];
  byMonthDay: number[];
  byMonth: number[];
  /** 0 = sunday */
  wkst: number;
}

const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRRule(text: string): RecurrenceRule {
  const parts = new Map<string, string>();
  for (const p of text.replace(/^RRULE:/i, '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) parts.set(p.slice(0, i).toUpperCase(), p.slice(i + 1));
  }
  const freq = parts.get('FREQ')?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') throw new RangeError(`Unsupported or missing FREQ in RRULE: ${text}`);
  const interval = Math.max(1, Math.min(1000, Number(parts.get('INTERVAL') ?? 1) || 1));
  const rule: RecurrenceRule = { freq, interval, byDay: [], byMonthDay: [], byMonth: [], wkst: DOW[parts.get('WKST')?.toUpperCase() ?? 'MO'] ?? 1 };
  const count = parts.get('COUNT');
  if (count !== undefined) {
    const c = Number(count);
    if (!Number.isInteger(c) || c < 1) throw new RangeError('Invalid COUNT');
    rule.count = Math.min(c, 100000);
  }
  const until = parts.get('UNTIL');
  if (until) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(until);
    if (!m) throw new RangeError(`Invalid UNTIL: ${until}`);
    rule.until = { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: m[4] ? +m[4] : 23, mi: m[5] ? +m[5] : 59, utc: m[7] === 'Z' };
  }
  for (const d of (parts.get('BYDAY') ?? '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(d.trim());
    if (m) rule.byDay.push({ ...(m[1] ? { n: Number(m[1]) } : {}), day: DOW[m[2]!.toUpperCase()]! });
  }
  for (const d of (parts.get('BYMONTHDAY') ?? '').split(',').filter(Boolean)) {
    const n = Number(d);
    if (Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31) rule.byMonthDay.push(n);
  }
  for (const d of (parts.get('BYMONTH') ?? '').split(',').filter(Boolean)) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 1 && n <= 12) rule.byMonth.push(n);
  }
  return rule;
}

const DAY_MS = 86_400_000;
const toDn = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / DAY_MS);
const fromDn = (dn: number) => {
  const dt = new Date(dn * DAY_MS);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const weekdayOf = (dn: number) => (((dn + 4) % 7) + 7) % 7;
const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** all dates in one month that match byday / bymonthday (or the default day). */
function monthDates(y: number, mo: number, rule: RecurrenceRule, defaultDay: number): number[] {
  const dim = daysInMonth(y, mo);
  const out = new Set<number>();
  if (rule.byDay.length) {
    for (const { n, day } of rule.byDay) {
      const matches: number[] = [];
      for (let d = 1; d <= dim; d++) if (weekdayOf(toDn(y, mo, d)) === day) matches.push(d);
      if (n === undefined) matches.forEach((d) => out.add(d));
      else {
        const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
        if (pick !== undefined) out.add(pick);
      }
    }
    if (rule.byMonthDay.length) {
      const bm = new Set(rule.byMonthDay.map((d) => (d > 0 ? d : dim + 1 + d)));
      for (const d of [...out]) if (!bm.has(d)) out.delete(d);
    }
  } else if (rule.byMonthDay.length) {
    for (const d of rule.byMonthDay) {
      const dd = d > 0 ? d : dim + 1 + d;
      if (dd >= 1 && dd <= dim) out.add(dd);
    }
  } else if (defaultDay <= dim) out.add(defaultDay);
  return [...out].sort((a, b) => a - b).map((d) => toDn(y, mo, d));
}

export interface ExpandOptions {
  /** wall-clock start of the first occurrence */
  start: { y: number; mo: number; d: number; h: number; mi: number };
  timezone: string;
  durationMin: number;
  rule: RecurrenceRule;
  exdates?: readonly Minutes[];
  /** only occurrences that overlap this window are returned */
  window: Interval;
  maxOccurrences?: number;
}

export const MAX_OCCURRENCES = 1000;

/** start minutes of every occurrence overlapping `window`. bounded: never loops unboundedly. */
export function expandRecurrence(o: ExpandOptions): Minutes[] {
  const { start, rule, timezone: tz } = o;
  const cap = Math.min(o.maxOccurrences ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const startDn = toDn(start.y, start.mo, start.d);
  const untilMin: number | null = rule.until
    ? rule.until.utc
      ? Math.round(Date.UTC(rule.until.y, rule.until.mo - 1, rule.until.d, rule.until.h, rule.until.mi) / 60000)
      : zonedToMin(rule.until.y, rule.until.mo, rule.until.d, rule.until.h, rule.until.mi, tz)
    : null;
  const exdates = new Set(o.exdates ?? []);
  const out: Minutes[] = [];
  let produced = 0;
  const startWd = weekdayOf(startDn);

  const emit = (dn: number): 'stop' | 'ok' => {
    if (dn < startDn) return 'ok';
    const { y, mo, d } = fromDn(dn);
    if (rule.byMonth.length && !rule.byMonth.includes(mo)) return 'ok';
    const m = zonedToMin(y, mo, d, start.h, start.mi, tz);
    if (untilMin !== null && m > untilMin) return 'stop';
    produced++;
    if (rule.count !== undefined && produced > rule.count) return 'stop';
    if (m >= o.window.end) return 'stop';
    if (m + o.durationMin > o.window.start && !exdates.has(m)) out.push(m);
    if (out.length >= cap) return 'stop';
    return 'ok';
  };

  let periods = 0;
  const MAX_PERIODS = 20000;
  if (rule.freq === 'DAILY') {
    for (let k = 0; periods++ < MAX_PERIODS; k++) {
      const dn = startDn + k * rule.interval;
      if (rule.byDay.length && !rule.byDay.some((b) => b.day === weekdayOf(dn))) continue;
      if (rule.byMonthDay.length) {
        const { y, mo, d } = fromDn(dn);
        const dim = daysInMonth(y, mo);
        if (!rule.byMonthDay.some((x) => (x > 0 ? x : dim + 1 + x) === d)) continue;
      }
      if (emit(dn) === 'stop') break;
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length ? [...new Set(rule.byDay.map((b) => b.day))] : [startWd];
    const offset = (day: number) => (day - rule.wkst + 7) % 7;
    days.sort((a, b) => offset(a) - offset(b));
    const weekStart0 = startDn - offset(startWd);
    outer: for (let w = 0; periods++ < MAX_PERIODS; w++) {
      const base = weekStart0 + w * 7 * rule.interval;
      for (const day of days) {
        const dn = base + offset(day);
        if (dn < startDn) continue;
        if (emit(dn) === 'stop') break outer;
      }
    }
  } else if (rule.freq === 'MONTHLY') {
    outer: for (let k = 0; periods++ < MAX_PERIODS; k++) {
      const idx = start.mo - 1 + k * rule.interval;
      const y = start.y + Math.floor(idx / 12);
      const mo = (((idx % 12) + 12) % 12) + 1;
      for (const dn of monthDates(y, mo, rule, start.d)) if (emit(dn) === 'stop') break outer;
    }
  } else {
    const months = rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [start.mo];
    outer: for (let k = 0; periods++ < MAX_PERIODS; k++) {
      const y = start.y + k * rule.interval;
      for (const mo of months) for (const dn of monthDates(y, mo, { ...rule, byMonth: [] }, start.d)) if (emit(dn) === 'stop') break outer;
    }
  }
  return out;
}
