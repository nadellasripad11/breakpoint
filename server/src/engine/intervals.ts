import type { Interval } from './types.ts';

/** sort + merge overlapping/adjacent intervals; drops empty ones. does not mutate the input. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push(iv);
  }
  return out;
}

/** a minus b (both arbitrary); result is merged and sorted. */
export function subtractIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out: Interval[] = [];
  let j = 0;
  for (const iv of A) {
    let cur = iv.start;
    while (j < B.length && B[j]!.end <= cur) j++;
    let k = j;
    while (k < B.length && B[k]!.start < iv.end) {
      const blk = B[k]!;
      if (blk.start > cur) out.push({ start: cur, end: blk.start });
      cur = Math.max(cur, blk.end);
      if (cur >= iv.end) break;
      k++;
    }
    if (cur < iv.end) out.push({ start: cur, end: iv.end });
  }
  return out;
}

export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i]!.start, B[j]!.start);
    const e = Math.min(A[i]!.end, B[j]!.end);
    if (e > s) out.push({ start: s, end: e });
    if (A[i]!.end < B[j]!.end) i++;
    else j++;
  }
  return out;
}

export function totalLength(list: readonly Interval[]): number {
  let t = 0;
  for (const i of list) t += i.end - i.start;
  return t;
}

/** free minutes inside [from, to) given merged free intervals. */
export function freeWithin(free: readonly Interval[], from: number, to: number): number {
  let t = 0;
  for (const iv of free) {
    const s = Math.max(iv.start, from);
    const e = Math.min(iv.end, to);
    if (e > s) t += e - s;
  }
  return t;
}

export function overlaps(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function contains(outer: Interval, inner: Interval): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * earliest start s >= max(from, release) such that [s, s+d) fits inside one free interval and ends by `deadline`.
 * returns infinity when impossible. `free` must be merged + sorted.
 */
export function placeEarliest(free: readonly Interval[], from: number, release: number, deadline: number, d: number): number {
  const lo = Math.max(from, release);
  for (const iv of free) {
    if (iv.end <= lo) continue;
    const s = Math.max(iv.start, lo);
    if (s + d > deadline) return Infinity;
    if (s + d <= iv.end) return s;
  }
  return Infinity;
}

/** true when [s, s+d) lies entirely inside one free interval. */
export function fitsFree(free: readonly Interval[], s: number, d: number): boolean {
  for (const iv of free) {
    if (iv.start > s) return false;
    if (s + d <= iv.end) return s >= iv.start;
  }
  return false;
}
