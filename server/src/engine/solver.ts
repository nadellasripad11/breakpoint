import type { Interval } from './types.ts';
import type { Floater } from './world.ts';
import { fitsFree, mergeIntervals, placeEarliest, subtractIntervals } from './intervals.ts';

/**
 * Exact placement of flexible tasks into the free gaps between locked commitments.
 *
 * Tasks are non-preemptive (they run in one piece) and have a release time and a HARD deadline.
 * For up to `exactLimit` tasks the solver is an exact subset DP (earliest-completion per subset):
 * it finds a placement iff one exists, and among all placeable subsets that contain every
 * non-deferrable task it picks the one with the highest additive key.
 * Above the limit it falls back to a deterministic greedy pass and says so (`optimal: false`).
 */

export interface SolveOptions {
  /** Keep the original relative order (Mobility "fixed"). */
  ordered?: boolean;
  /** Additive weight of placing a task; the solver maximises the sum over the placed set. */
  weight?: (f: Floater) => number;
  exactLimit?: number;
}

export interface SolveResult {
  feasible: boolean;
  /** id -> start minute (left-justified; run `relaxPlacements` to pull tasks toward their original slot). */
  placed: Map<string, number>;
  /** Deferrable tasks that could not be placed. Never silently dropped: callers must surface these. */
  deferred: string[];
  /** Non-deferrable tasks that could not be placed (only when `feasible` is false). */
  failed: string[];
  key: number;
  optimal: boolean;
  method: 'dp' | 'greedy' | 'none';
  /** work units spent (for budgeting callers) */
  ops: number;
}

export const DEFAULT_EXACT_LIMIT = 18;

/** Count-first weight: more tasks placed beats everything, then priority, then minutes. */
export const weightByCount = (f: Floater): number => 1e9 + f.priority * 1e5 + f.duration;

/** Priority-lexicographic weight: one priority-5 task beats any number of priority-4 tasks. */
export function weightByPriority(n: number): (f: Floater) => number {
  const base = n + 2;
  return (f) => Math.pow(base, f.priority - 1) * 1e3 + f.duration * 1e-3;
}

function lowBitIndex(m: number): number {
  return 31 - Math.clz32(m & -m);
}
function highBitIndex(m: number): number {
  return 31 - Math.clz32(m);
}

export function solveFloaters(freeIn: readonly Interval[], floaters: readonly Floater[], opts: SolveOptions = {}): SolveResult {
  const free = mergeIntervals(freeIn);
  const n = floaters.length;
  const weight = opts.weight ?? weightByCount;
  if (n === 0) return { feasible: true, placed: new Map(), deferred: [], failed: [], key: 0, optimal: true, method: 'none', ops: 0 };
  if (n > (opts.exactLimit ?? DEFAULT_EXACT_LIMIT)) return solveGreedy(free, floaters, opts, weight);

  const size = 1 << n;
  const f = new Float64Array(size).fill(Infinity);
  const choice = new Int8Array(size).fill(-1);
  const key = new Float64Array(size);
  f[0] = -Infinity;
  const w = floaters.map(weight);
  let required = 0;
  floaters.forEach((t, i) => {
    if (!t.deferrable) required |= 1 << i;
  });

  let ops = 0;
  for (let m = 1; m < size; m++) {
    key[m] = key[m & (m - 1)]! + w[lowBitIndex(m)]!;
    if (opts.ordered) {
      const j = highBitIndex(m);
      const prev = f[m ^ (1 << j)]!;
      if (prev === Infinity) continue;
      const t = floaters[j]!;
      const s = placeEarliest(free, prev, t.release, t.deadline, t.duration);
      ops++;
      if (s !== Infinity) {
        f[m] = s + t.duration;
        choice[m] = j;
      }
    } else {
      let best = Infinity;
      let bj = -1;
      for (let j = 0; j < n; j++) {
        if (!(m & (1 << j))) continue;
        const prev = f[m ^ (1 << j)]!;
        if (prev === Infinity) continue;
        const t = floaters[j]!;
        const s = placeEarliest(free, prev, t.release, t.deadline, t.duration);
        ops++;
        if (s === Infinity) continue;
        const end = s + t.duration;
        if (end < best) {
          best = end;
          bj = j;
        }
      }
      if (bj >= 0) {
        f[m] = best;
        choice[m] = bj;
      }
    }
  }

  let bestMask = -1;
  for (let m = 0; m < size; m++) {
    if ((m & required) !== required || f[m] === Infinity) continue;
    if (bestMask < 0 || key[m]! > key[bestMask]! || (key[m] === key[bestMask] && f[m]! < f[bestMask]!)) bestMask = m;
  }

  if (bestMask < 0) {
    // infeasible: report which non-deferrable tasks cannot even be placed on their own
    const failed = floaters.filter((t) => !t.deferrable && placeEarliest(free, -Infinity, t.release, t.deadline, t.duration) === Infinity).map((t) => t.id);
    return { feasible: false, placed: new Map(), deferred: [], failed, key: 0, optimal: true, method: 'dp', ops };
  }

  // reconstruct the order, then replay it left-justified
  const order: number[] = [];
  for (let m = bestMask; m > 0; m ^= 1 << order[order.length - 1]!) order.push(choice[m]!);
  order.reverse();
  const placed = new Map<string, number>();
  let cursor = -Infinity;
  for (const j of order) {
    const t = floaters[j]!;
    const s = placeEarliest(free, cursor, t.release, t.deadline, t.duration);
    placed.set(t.id, s);
    cursor = s + t.duration;
  }
  const deferred = floaters.filter((_, i) => !(bestMask & (1 << i))).map((t) => t.id);
  return { feasible: true, placed, deferred, failed: [], key: key[bestMask]!, optimal: true, method: 'dp', ops };
}

/** Deterministic fallback for very large days. Never claims optimality. */
function solveGreedy(free: Interval[], floaters: readonly Floater[], opts: SolveOptions, weight: (f: Floater) => number): SolveResult {
  const placed = new Map<string, number>();
  const deferred: string[] = [];
  const failed: string[] = [];
  const byId = new Map(floaters.map((t) => [t.id, t]));
  const sequence = opts.ordered
    ? [...floaters]
    : [...floaters].sort((a, b) => Number(a.deferrable) - Number(b.deferrable) || a.deadline - b.deadline || b.priority - a.priority || a.release - b.release || a.id.localeCompare(b.id));
  let freeNow = free;
  let cursor = -Infinity;
  for (const t of sequence) {
    const s = placeEarliest(freeNow, opts.ordered ? cursor : -Infinity, t.release, t.deadline, t.duration);
    if (s === Infinity) {
      (t.deferrable ? deferred : failed).push(t.id);
      continue;
    }
    placed.set(t.id, s);
    cursor = s + t.duration;
    freeNow = subtractIntervals(freeNow, [{ start: s, end: s + t.duration }]);
  }
  let key = 0;
  for (const id of placed.keys()) key += weight(byId.get(id)!);
  return { feasible: failed.length === 0, placed: failed.length ? new Map() : placed, deferred: failed.length ? [] : deferred, failed, key, optimal: false, method: 'greedy', ops: floaters.length };
}

/* ───────────── pull tasks toward their original slot ───────────── */

export interface Placed {
  id: string;
  start: number;
  duration: number;
  release: number;
  deadline: number;
  origStart: number;
}

/**
 * Left-justified DP output moves tasks more than necessary. This pass slides each task to the feasible
 * position closest to its original start, one at a time, given every other task as an obstacle.
 * Every move keeps the plan valid, so the result is never worse than its input.
 */
export function relaxPlacements(free: readonly Interval[], placed: readonly Placed[], opts: { ordered?: boolean; rounds?: number } = {}): Placed[] {
  const cur = placed.map((p) => ({ ...p }));
  const rounds = opts.rounds ?? 8;
  for (let r = 0; r < rounds; r++) {
    let changed = false;
    const order = [...cur].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (let idx = 0; idx < order.length; idx++) {
      const t = order[idx]!;
      const others = cur.filter((o) => o.id !== t.id).map((o) => ({ start: o.start, end: o.start + o.duration }));
      const gaps = subtractIntervals(free, others);
      // in ordered (fixed) mode a task may not hop over its neighbours
      const prevEnd = opts.ordered && idx > 0 ? order[idx - 1]!.start + order[idx - 1]!.duration : -Infinity;
      const nextStart = opts.ordered && idx < order.length - 1 ? order[idx + 1]!.start : Infinity;
      let bestS = t.start;
      let bestCost = Math.abs(t.start - t.origStart);
      for (const g of gaps) {
        const lo = Math.max(g.start, t.release, prevEnd);
        const hi = Math.min(g.end, t.deadline, nextStart) - t.duration;
        if (hi < lo) continue;
        const s = Math.min(Math.max(t.origStart, lo), hi);
        const cost = Math.abs(s - t.origStart);
        if (cost < bestCost || (cost === bestCost && s < bestS)) {
          bestCost = cost;
          bestS = s;
        }
      }
      if (bestS !== t.start) {
        t.start = bestS;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return cur;
}

/**
 * Tries every ordering of the placed tasks (left-justified), slides each result toward the original slots,
 * and keeps the plan with the least total movement. Exhaustive for up to `maxTasks` tasks, then it falls back
 * to the plain slide pass. Deterministic: permutations are visited in lexicographic order.
 */
export function improveByOrder(free: readonly Interval[], tasks: readonly Placed[], opts: { ordered?: boolean; maxTasks?: number } = {}): Placed[] {
  const cost = (p: readonly Placed[]) => p.reduce((s, t) => s + Math.abs(t.start - t.origStart), 0);
  let best = relaxPlacements(free, tasks, { ordered: opts.ordered });
  const m = tasks.length;
  if (m <= 1 || opts.ordered || m > (opts.maxTasks ?? 6)) return best;
  let bestCost = cost(best);
  const base = [...tasks].sort((a, b) => a.origStart - b.origStart || a.id.localeCompare(b.id));
  const used: boolean[] = new Array(m).fill(false);
  const perm: number[] = [];
  const visit = () => {
    let cursor = -Infinity;
    const placed: Placed[] = [];
    for (const j of perm) {
      const t = base[j]!;
      const s = placeEarliest(free as Interval[], cursor, t.release, t.deadline, t.duration);
      if (s === Infinity) return;
      placed.push({ ...t, start: s });
      cursor = s + t.duration;
    }
    const r = relaxPlacements(free, placed, {});
    const c = cost(r);
    if (c < bestCost) {
      best = r;
      bestCost = c;
    }
  };
  const rec = () => {
    if (perm.length === m) return visit();
    for (let i = 0; i < m; i++) {
      if (used[i]) continue;
      used[i] = true;
      perm.push(i);
      rec();
      perm.pop();
      used[i] = false;
    }
  };
  rec();
  return best;
}

/* ───────────── exact minimum movement ───────────── */

export interface DispTask {
  id: string;
  duration: number;
  release: number;
  deadline: number;
  origStart: number;
}

export interface DispResult {
  placed: Map<string, number>;
  /** sum over tasks of |start - origStart|, minutes */
  cost: number;
  /** true when proven minimal (integer-minute exact DP); false when the task count or time span forced the heuristic */
  exact: boolean;
  ops: number;
}

export const DISP_MAX_TASKS = 9;
export const DISP_MAX_SPAN = 2000;

/**
 * Places ALL the given tasks (non-preemptive, inside the free gaps, between each task's release and deadline, never
 * overlapping each other) so that the total distance from their original starts is the SMALLEST possible, over every
 * order and every integer-minute start. Returns null when they cannot all be placed.
 *
 * Exact dynamic programme over (set of tasks placed, minute the last one ends): f[set][end] = least movement so far.
 * With `ordered` the tasks keep their original order (fixed mobility). Beyond DISP_MAX_TASKS tasks (or a span longer
 * than DISP_MAX_SPAN minutes) it falls back to the exhaustive-order slide heuristic and says so (`exact: false`).
 */
export function minDisplacementPlacement(freeIn: readonly Interval[], tasksIn: readonly DispTask[], opts: { ordered?: boolean } = {}): DispResult | null {
  const free = mergeIntervals(freeIn);
  const tasks = [...tasksIn].sort((a, b) => a.origStart - b.origStart || a.id.localeCompare(b.id));
  const n = tasks.length;
  if (n === 0) return { placed: new Map(), cost: 0, exact: true, ops: 0 };
  if (free.length === 0) return null;
  const t0 = Math.max(Math.min(...tasks.map((t) => t.release)), free[0]!.start);
  const t1 = Math.min(Math.max(...tasks.map((t) => t.deadline)), free[free.length - 1]!.end);
  if (t1 <= t0) return null;
  const span = t1 - t0;

  if (n > DISP_MAX_TASKS || span > DISP_MAX_SPAN) {
    const floaters: Floater[] = tasks.map((t) => ({ id: t.id, title: t.id, kind: 'task', duration: t.duration, release: t.release, deadline: t.deadline, origStart: t.origStart, priority: 3, deferrable: false, critical: false }));
    const s = solveFloaters(free, floaters, { ordered: opts.ordered });
    if (!s.feasible) return null;
    const start: Placed[] = floaters.map((f) => ({ id: f.id, start: s.placed.get(f.id)!, duration: f.duration, release: f.release, deadline: f.deadline, origStart: f.origStart }));
    const out = improveByOrder(free, start, { ordered: opts.ordered, maxTasks: 6 });
    return { placed: new Map(out.map((p) => [p.id, p.start])), cost: out.reduce((c, p) => c + Math.abs(p.start - p.origStart), 0), exact: false, ops: s.ops };
  }

  const W = span + 1;
  const full = (1 << n) - 1;
  const size = (1 << n) * W;
  const f = new Float64Array(size).fill(Infinity);
  const g = new Float64Array(size).fill(Infinity);
  const ga = new Int32Array(size).fill(-1);
  const choiceTask = new Int8Array(size).fill(-1);
  const choiceStart = new Int32Array(size).fill(0);
  f[0] = 0;
  let ops = 0;

  for (let m = 0; m <= full; m++) {
    if (opts.ordered && m !== (1 << popBits(m)) - 1) continue; // only prefixes of the original order
    const base = m * W;
    let best = Infinity;
    let arg = -1;
    for (let k = 0; k < W; k++) {
      if (f[base + k]! < best) {
        best = f[base + k]!;
        arg = k;
      }
      g[base + k] = best;
      ga[base + k] = arg;
    }
    if (best === Infinity) continue;
    for (let j = 0; j < n; j++) {
      if (m & (1 << j)) continue;
      if (opts.ordered && j !== popBits(m)) continue;
      const t = tasks[j]!;
      const nm = m | (1 << j);
      for (const seg of free) {
        const lo = Math.max(seg.start, t.release, t0);
        const hi = Math.min(seg.end, t.deadline, t1) - t.duration;
        for (let s = lo; s <= hi; s++) {
          ops++;
          const prev = g[base + (s - t0)]!;
          if (prev === Infinity) continue;
          const cost = prev + Math.abs(s - t.origStart);
          const idx = nm * W + (s + t.duration - t0);
          if (cost < f[idx]!) {
            f[idx] = cost;
            choiceTask[idx] = j;
            choiceStart[idx] = s;
          }
        }
      }
    }
  }

  const fb = full * W;
  let bestK = -1;
  for (let k = 0; k < W; k++) if (f[fb + k]! < (bestK < 0 ? Infinity : f[fb + bestK]!)) bestK = k;
  if (bestK < 0) return null;
  const cost = f[fb + bestK]!;

  const placed = new Map<string, number>();
  let m = full;
  let k = bestK;
  while (m > 0) {
    const idx = m * W + k;
    const j = choiceTask[idx]!;
    const s = choiceStart[idx]!;
    placed.set(tasks[j]!.id, s);
    m ^= 1 << j;
    k = ga[m * W + (s - t0)]!;
  }
  return { placed, cost, exact: true, ops };
}

function popBits(m: number): number {
  let c = 0;
  for (let x = m; x; x &= x - 1) c++;
  return c;
}

/** Can `t` keep its original slot given the currently free time? */
export function anchorFits(free: readonly Interval[], t: Floater): boolean {
  return t.origStart >= t.release && t.origStart + t.duration <= t.deadline && fitsFree(free, t.origStart, t.duration);
}
