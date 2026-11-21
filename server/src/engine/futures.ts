import type { CascadeResult, Disruption, Interval, ItemKind, Minutes, Plan } from './types.ts';
import type { Floater, World } from './world.ts';
import { buildWorld, describeDisruption, freeTime, lockedInterval } from './world.ts';
import { freeWithin, subtractIntervals } from './intervals.ts';
import { DISP_MAX_TASKS, anchorFits, improveByOrder, minDisplacementPlacement, solveFloaters, weightByCount, weightByPriority } from './solver.ts';
import type { Placed } from './solver.ts';
import { diagnoseWorld } from './diagnose.ts';
import type { Diagnosis } from './diagnose.ts';
import { assertValidPlacements } from './validate.ts';
import { simulateCascade } from './cascade.ts';
import { fmtClock, fmtDuration } from './time.ts';

export type StrategyId = 'protect_priorities' | 'maximize_completion' | 'minimize_changes';

export const STRATEGIES: Record<StrategyId, { title: string; description: string }> = {
  protect_priorities: { title: 'Protect priorities', description: 'Keeps the most important tasks on schedule. Lower-priority work absorbs the disruption.' },
  maximize_completion: { title: 'Preserve the most tasks', description: 'Fits in as many of your original tasks as possible.' },
  minimize_changes: { title: 'Minimize changes', description: 'Makes the smallest possible adjustment to your plan.' },
};

export interface FutureItem {
  id: string;
  title: string;
  kind: ItemKind;
  locked: boolean;
  injected: boolean;
  start: Minutes;
  end: Minutes;
  original: Interval | null;
  /** locked = never moves; kept = same slot as before; moved = re-planned; unchanged = informational item */
  status: 'locked' | 'kept' | 'moved' | 'injected' | 'unchanged';
  movedByMinutes: number;
}

export interface DeferredItem {
  id: string;
  title: string;
  reason: 'no_room';
  message: string;
}

export interface Future {
  strategy: StrategyId;
  title: string;
  description: string;
  feasible: boolean;
  items: FutureItem[];
  /** tasks that do not fit and were deferred. they are listed explicitly and need the user's confirmation. */
  deferred: DeferredItem[];
  requiresConfirmation: boolean;
  metrics: {
    placedCount: number;
    deferredCount: number;
    keptCount: number;
    movedCount: number;
    totalDisplacementMinutes: number;
    maxDisplacementMinutes: number;
    criticalKept: { kept: number; total: number };
  };
  explanation: string[];
  /** true when the optimisation is provably optimal for its objective (false only for very large days or budget cut-offs) */
  optimal: boolean;
  diagnosis?: Diagnosis;
}

export interface FuturesResult {
  disruptions: string[];
  /** what happens if you do nothing: the butterfly effect summary for the same disruptions. */
  doNothing: CascadeResult['summary'] | null;
  futures: Future[];
  recommended: StrategyId | null;
  recommendedReason: string;
}

const OPS_BUDGET = 4e7;
/** tie-break when two options are equally good: the one that promises the least change wins */
const PREFERENCE: Record<StrategyId, number> = { minimize_changes: 0, protect_priorities: 1, maximize_completion: 2 };

function ivOf(f: Floater): Interval {
  return { start: f.origStart, end: f.origStart + f.duration };
}

/** under fixed mobility anchors also fix the relative order of everything around them. */
function constrainRest(floaters: readonly Floater[], anchors: readonly Floater[], ordered: boolean): Floater[] {
  const ids = new Set(anchors.map((a) => a.id));
  return floaters
    .filter((f) => !ids.has(f.id))
    .map((f) => {
      if (!ordered) return f;
      let { release, deadline } = f;
      for (const a of anchors) {
        if (f.origStart < a.origStart) deadline = Math.min(deadline, a.origStart);
        else release = Math.max(release, a.origStart + a.duration);
      }
      return release === f.release && deadline === f.deadline ? f : { ...f, release, deadline };
    });
}

export function parallelFutures(plan: Plan, disruptions: readonly Disruption[] = []): FuturesResult {
  const world = buildWorld(plan, disruptions);
  const futures = (Object.keys(STRATEGIES) as StrategyId[]).map((s) => planStrategy(world, plan, disruptions, s));
  const doNothing = disruptions.length ? simulateCascade(plan, disruptions).summary : null;

  // deterministic recommendation: feasible, nothing deferred, fewest changes; otherwise fewest critical deferrals
  const feasible = futures.filter((f) => f.feasible);
  let recommended: StrategyId | null = null;
  let recommendedReason = 'No feasible schedule exists. See the diagnosis for why and what would fix it.';
  if (feasible.length) {
    const noDefer = feasible.filter((f) => f.deferred.length === 0);
    const pool = noDefer.length ? noDefer : feasible;
    const best = [...pool].sort(
      (a, b) =>
        a.deferred.length - b.deferred.length ||
        a.metrics.criticalKept.total - a.metrics.criticalKept.kept - (b.metrics.criticalKept.total - b.metrics.criticalKept.kept) ||
        a.metrics.movedCount - b.metrics.movedCount ||
        a.metrics.totalDisplacementMinutes - b.metrics.totalDisplacementMinutes ||
        PREFERENCE[a.strategy] - PREFERENCE[b.strategy],
    )[0]!;
    recommended = best.strategy;
    recommendedReason = noDefer.length
      ? `"${best.title}" keeps every task and changes the least (${best.metrics.movedCount} moved, ${fmtDuration(best.metrics.totalDisplacementMinutes)} of total movement).`
      : `Every option has to defer something; "${best.title}" defers the least important work (${best.deferred.length} task${best.deferred.length > 1 ? 's' : ''}). You must confirm any deferral.`;
  }
  return { disruptions: disruptions.map((d) => describeDisruption(d, plan)), doNothing, futures, recommended, recommendedReason };
}

function planStrategy(world: World, plan: Plan, disruptions: readonly Disruption[], strategy: StrategyId): Future {
  const meta = STRATEGIES[strategy];
  const tz = world.settings.timezone;
  const ordered = world.settings.mobility === 'fixed';
  const free0 = freeTime(world);
  const weight = strategy === 'protect_priorities' ? weightByPriority(world.floaters.length) : weightByCount;
  const keyOf = (list: readonly Floater[]) => list.reduce((s, f) => s + weight(f), 0);
  let ops = 0;
  let optimal = true;

  const base = solveFloaters(free0, world.floaters, { ordered, weight });
  ops += base.ops;
  if (!base.feasible) {
    return {
      strategy,
      title: meta.title,
      description: meta.description,
      feasible: false,
      items: [],
      deferred: [],
      requiresConfirmation: false,
      metrics: emptyMetrics(),
      explanation: ['No feasible schedule exists, so nothing was changed. Your original plan is untouched.'],
      optimal: base.optimal,
      diagnosis: diagnoseWorld(world, plan, disruptions),
    };
  }
  if (!base.optimal) optimal = false;

  const sameKey = (a: number) => Math.abs(a - base.key) < 1e-6;
  const solveRest = (anchors: readonly Floater[]) => {
    const rest = constrainRest(world.floaters, anchors, ordered);
    const freeA = subtractIntervals(free0, anchors.map(ivOf));
    const r = solveFloaters(freeA, rest, { ordered, weight });
    ops += r.ops;
    return { r, rest, freeA };
  };

  /* choose anchors: tasks that keep their original slot */
  let anchors: Floater[] = [];
  if (strategy === 'protect_priorities') {
    // highest priority first: keep a task at its original time if that does not cost any placement at its own
    // priority tier or above. lower-priority (deferrable) work may be deferred, explicitly, to make this possible.
    const tierCounts = (ids: Iterable<string>): number[] => {
      const c = [0, 0, 0, 0, 0, 0];
      for (const id of ids) c[world.floaters.find((f) => f.id === id)!.priority]!++;
      return c;
    };
    let ref = tierCounts(base.placed.keys());
    const sorted = [...world.floaters].sort((a, b) => b.priority - a.priority || a.origStart - b.origStart || a.id.localeCompare(b.id));
    for (const t of sorted) {
      if (ops > OPS_BUDGET) {
        optimal = false;
        break;
      }
      if (!anchorFits(subtractIntervals(free0, anchors.map(ivOf)), t)) continue;
      const trial = [...anchors, t];
      const { r } = solveRest(trial);
      if (!r.feasible) continue;
      const counts = tierCounts([...trial.map((a) => a.id), ...r.placed.keys()]);
      let ok = true;
      for (let q = t.priority; q <= 5; q++) if (counts[q]! < ref[q]!) ok = false;
      if (ok) {
        anchors = trial;
        ref = counts;
      }
    }
  } else if (strategy === 'minimize_changes') {
    const order = [...world.floaters].sort((a, b) => a.origStart - b.origStart || a.id.localeCompare(b.id));
    let best: Floater[] = [];
    let bestDisp = Infinity;
    let bestPrio = -1;
    const displacementOf = (cur: readonly Floater[]): number => {
      const { r, rest, freeA } = solveRest(cur);
      const placedList: Placed[] = rest
        .filter((f) => r.placed.has(f.id))
        .map((f) => ({ id: f.id, start: r.placed.get(f.id)!, duration: f.duration, release: f.release, deadline: f.deadline, origStart: f.origStart }));
      // exact minimum movement for this anchor choice (integer minutes, every order); heuristic only for very large days
      if (placedList.length <= DISP_MAX_TASKS - 1) {
        const ex = minDisplacementPlacement(freeA, placedList, { ordered });
        if (ex) {
          ops += ex.ops;
          return ex.cost;
        }
      }
      return improveByOrder(freeA, placedList, { ordered, maxTasks: 5 }).reduce((s, p) => s + Math.abs(p.start - p.origStart), 0);
    };
    const dfs = (i: number, cur: Floater[]) => {
      if (ops > OPS_BUDGET) {
        optimal = false;
        return;
      }
      if (cur.length + (order.length - i) < best.length) return;
      if (i === order.length) {
        if (cur.length < best.length) return;
        const disp = displacementOf(cur);
        const prio = cur.reduce((s, f) => s + f.priority, 0);
        if (cur.length > best.length || disp < bestDisp || (disp === bestDisp && prio > bestPrio)) {
          best = cur;
          bestDisp = disp;
          bestPrio = prio;
        }
        return;
      }
      const t = order[i]!;
      if (anchorFits(subtractIntervals(free0, cur.map(ivOf)), t)) {
        const trial = [...cur, t];
        const { r } = solveRest(trial);
        if (r.feasible && sameKey(r.key + keyOf(trial))) dfs(i + 1, trial);
      }
      dfs(i + 1, cur);
    };
    dfs(0, []);
    anchors = best;
  }

  let { r: res, rest, freeA } = solveRest(anchors);
  if (!res.feasible || (strategy !== 'protect_priorities' && !sameKey(res.key + keyOf(anchors)))) {
    // defensive: anchoring must never cost us a placement; fall back to the unanchored optimum
    anchors = [];
    ({ r: res, rest, freeA } = solveRest([]));
  }
  if (!res.optimal) optimal = false;

  /* pull moved tasks back toward their original slots */
  const restPlaced: Placed[] = rest
    .filter((f) => res.placed.has(f.id))
    .map((f) => ({ id: f.id, start: res.placed.get(f.id)!, duration: f.duration, release: f.release, deadline: f.deadline, origStart: f.origStart }));
  const exactRest = restPlaced.length <= DISP_MAX_TASKS ? minDisplacementPlacement(freeA, restPlaced, { ordered }) : null;
  if (exactRest) ops += exactRest.ops;
  const relaxed: Placed[] = exactRest ? restPlaced.map((p) => ({ ...p, start: exactRest.placed.get(p.id)! })) : improveByOrder(freeA, restPlaced, { ordered, maxTasks: 6 });
  if (!exactRest && restPlaced.length > 0) optimal = false; // large day: movement is minimised by the slide heuristic, not proven minimal

  const placed = new Map<string, number>();
  for (const a of anchors) placed.set(a.id, a.origStart);
  for (const p of relaxed) placed.set(p.id, p.start);
  const deferredIds = world.floaters.filter((f) => !placed.has(f.id)).map((f) => f.id);
  assertValidPlacements(world, placed, deferredIds);

  /* assemble */
  const items: FutureItem[] = [];
  for (const l of world.locked) {
    items.push({
      id: l.id,
      title: l.title,
      kind: l.kind,
      locked: true,
      injected: l.injected,
      start: l.start,
      end: l.start + l.duration,
      original: l.injected ? null : { start: l.origStart, end: l.origStart + l.origDuration },
      status: l.injected ? 'injected' : 'locked',
      movedByMinutes: 0,
    });
  }
  for (const w of world.work) {
    if (w.blocking) continue;
    items.push({ id: w.id, title: w.title, kind: w.kind, locked: w.locked, injected: false, start: w.start, end: w.start + w.duration, original: { start: w.origStart, end: w.origStart + w.origDuration }, status: 'unchanged', movedByMinutes: 0 });
  }
  let displacement = 0;
  let maxDisp = 0;
  let kept = 0;
  let moved = 0;
  for (const f of world.floaters) {
    const s = placed.get(f.id);
    if (s === undefined) continue;
    const d = s - f.origStart;
    const status = d === 0 ? 'kept' : 'moved';
    if (d === 0) kept++;
    else moved++;
    displacement += Math.abs(d);
    maxDisp = Math.max(maxDisp, Math.abs(d));
    const orig = world.work.find((w) => w.id === f.id)!;
    items.push({ id: f.id, title: f.title, kind: f.kind, locked: false, injected: false, start: s, end: s + f.duration, original: { start: f.origStart, end: f.origStart + orig.origDuration }, status, movedByMinutes: d });
  }
  items.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  const freeAfter = subtractIntervals(free0, [...placed.entries()].map(([id, s]) => ({ start: s, end: s + world.floaters.find((f) => f.id === id)!.duration })));
  const deferred: DeferredItem[] = deferredIds.map((id) => {
    const f = world.floaters.find((x) => x.id === id)!;
    const avail = freeWithin(freeAfter, f.release, f.deadline);
    return {
      id,
      title: f.title,
      reason: 'no_room',
      message: `"${f.title}" is deferred: it needs ${fmtDuration(f.duration)}, but only ${fmtDuration(avail)} stay free between ${fmtClock(f.release, tz)} and ${fmtClock(f.deadline, tz)} once the other tasks are placed. It has not been deleted.`,
    };
  });

  const criticalFloaters = world.floaters.filter((f) => f.priority >= world.settings.criticalPriority || f.critical);
  const criticalKept = criticalFloaters.filter((f) => placed.get(f.id) === f.origStart).length;
  const future: Future = {
    strategy,
    title: meta.title,
    description: meta.description,
    feasible: true,
    items,
    deferred,
    requiresConfirmation: deferred.length > 0,
    metrics: {
      placedCount: placed.size,
      deferredCount: deferred.length,
      keptCount: kept,
      movedCount: moved,
      totalDisplacementMinutes: displacement,
      maxDisplacementMinutes: maxDisp,
      criticalKept: { kept: criticalKept, total: criticalFloaters.length },
    },
    explanation: [],
    optimal,
  };
  future.explanation = explain(future, world);
  return future;
}

function emptyMetrics(): Future['metrics'] {
  return { placedCount: 0, deferredCount: 0, keptCount: 0, movedCount: 0, totalDisplacementMinutes: 0, maxDisplacementMinutes: 0, criticalKept: { kept: 0, total: 0 } };
}

function explain(f: Future, world: World): string[] {
  const tz = world.settings.timezone;
  const lines: string[] = [];
  for (const n of world.notes) lines.push(`Disruption: ${n}`);
  const movedItems = f.items.filter((i) => i.status === 'moved');
  const keptItems = f.items.filter((i) => i.status === 'kept');
  if (f.strategy === 'protect_priorities') {
    const top = keptItems.filter((i) => {
      const fl = world.floaters.find((x) => x.id === i.id);
      return fl && (fl.priority >= world.settings.criticalPriority || fl.critical);
    });
    lines.push(top.length ? `Important work keeps its time: ${top.map((i) => `"${i.title}" (${fmtClock(i.start, tz)})`).join(', ')}.` : 'No high-priority task could keep its exact slot.');
  }
  if (!movedItems.length && !f.deferred.length) lines.push('Nothing needs to move. The disruption is absorbed by existing free time.');
  for (const m of movedItems) {
    const d = m.movedByMinutes;
    lines.push(`"${m.title}" moves from ${fmtClock(m.original!.start, tz)} to ${fmtClock(m.start, tz)} (${fmtDuration(Math.abs(d))} ${d > 0 ? 'later' : 'earlier'}).`);
  }
  for (const d of f.deferred) lines.push(d.message);
  if (f.deferred.length) lines.push('Deferred tasks are never removed automatically: confirm or reject each one.');
  lines.push('Your locked commitments and your original calendar are unchanged.');
  if (!f.optimal) lines.push('This day is large; the plan is valid but not proven optimal.');
  return lines;
}
