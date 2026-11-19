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

/** Can `t` keep its original slot given the currently free time? */
export function anchorFits(free: readonly Interval[], t: Floater): boolean {
  return t.origStart >= t.release && t.origStart + t.duration <= t.deadline && fitsFree(free, t.origStart, t.duration);
}
