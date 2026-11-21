import type { Interval, Minutes, Plan, PlanItem } from './types.ts';
import { PlanError } from './types.ts';
import { runChaos, defaultSeed } from './chaos.ts';
import type { ChaosSeverity } from './chaos.ts';
import { cascadeBreakingPoint, weakLinkProfile } from './breakingPoint.ts';
import { fitsFree, intersectIntervals, overlaps } from './intervals.ts';
import { fmtClock, fmtDuration } from './time.ts';

/**
 * fortify my day: small preventive adjustments that make the schedule more resilient.
 *
 * candidates are tiny moves of flexible tasks (earlier/later by minutes, or swapping two neighbours).
 * each candidate is validated (never touches locked items, never violates a deadline, release time, availability or
 * another item) and then proven by re-running the deterministic simulations. only moves that improve resilience
 * without making anything worse are suggested. this returns a proposal; it never edits the user's schedule.
 */

export interface FortifyOptions {
  maxChanges?: number;
  /** a single task may drift at most this far from where it is now */
  maxShiftMinutes?: number;
  scenarios?: number;
  seed?: number;
  severity?: ChaosSeverity;
}

export interface Snapshot {
  survivalRate: number;
  /** minutes of lost time at the start of the day the schedule tolerates (null = more than the search limit) */
  dayStartTolerance: number | null;
  weakestItem: { itemId: string; title: string; toleranceMinutes: number } | null;
}

export interface Adjustment {
  type: 'move' | 'swap' | 'shift_block';
  itemId: string;
  title: string;
  fromStart: Minutes;
  toStart: Minutes;
  shiftMinutes: number;
  swapWith?: { itemId: string; title: string; fromStart: Minutes; toStart: Minutes };
  /** shift_block: the other back-to-back tasks that move with it */
  alsoMoved?: { itemId: string; title: string; fromStart: Minutes; toStart: Minutes }[];
  reason: string;
  gain: { survivalPoints: number; dayStartToleranceMinutes: number };
}

export interface FortifyResult {
  before: Snapshot;
  after: Snapshot;
  adjustments: Adjustment[];
  /** the plan with the adjustments applied: a proposal. nothing has been saved. */
  proposedStarts: { id: string; title: string; start: Minutes; end: Minutes; changed: boolean }[];
  explanation: string[];
}

const TOL_LIMIT = 240;

function evaluate(plan: Plan, seed: number, scenarios: number, severity: ChaosSeverity): { survival: number; tolerance: number } {
  const survival = runChaos(plan, { scenarios, seed, severity, examples: 0 }).survivalRate;
  const bp = cascadeBreakingPoint(plan, { type: 'lost_time' }, TOL_LIMIT);
  return { survival, tolerance: bp.status === 'breaks' ? bp.tolerableMinutes! : TOL_LIMIT };
}

function withStarts(plan: Plan, changes: Map<string, Minutes>): Plan {
  return { ...plan, items: plan.items.map((i) => (changes.has(i.id) ? { ...i, start: changes.get(i.id)! } : i)) };
}

function validMove(plan: Plan, it: PlanItem, start: Minutes, origin: Map<string, Minutes>, maxShift: number): boolean {
  if (it.locked || !it.blocking) return false;
  const end = start + it.duration;
  if (it.release !== undefined && start < it.release) return false;
  if (it.deadline !== undefined && end > it.deadline) return false;
  if (start < plan.settings.horizon.start || end > plan.settings.horizon.end) return false;
  if (Math.abs(start - (origin.get(it.id) ?? it.start!)) > maxShift) return false;
  if (!fitsFree(intersectIntervals(plan.settings.availability, [plan.settings.horizon]), start, it.duration)) return false;
  const me: Interval = { start, end };
  for (const o of plan.items) {
    if (o.id === it.id || !o.blocking || o.start === undefined) continue;
    if (overlaps(me, { start: o.start, end: o.start + o.duration }) > 0) return false;
  }
  return true;
}

export function fortifyDay(plan: Plan, opts: FortifyOptions = {}): FortifyResult {
  if (plan.items.some((i) => i.blocking && i.start === undefined)) throw new PlanError('unscheduled_item', 'Fortify needs every task placed first (build the baseline).');
  const maxChanges = Math.max(1, Math.min(8, opts.maxChanges ?? 3));
  const maxShift = Math.max(5, Math.min(180, opts.maxShiftMinutes ?? 45));
  const scenarios = Math.max(20, Math.min(400, opts.scenarios ?? 120));
  const severity = opts.severity ?? 'realistic';
  const seed = (opts.seed ?? defaultSeed(plan)) >>> 0;
  const tz = plan.settings.timezone;

  const origin = new Map(plan.items.map((i) => [i.id, i.start!]));
  const snapshot = (p: Plan): Snapshot => {
    const prof = weakLinkProfile(p, TOL_LIMIT);
    const e = evaluate(p, seed, scenarios, severity);
    return {
      survivalRate: e.survival,
      dayStartTolerance: e.tolerance >= TOL_LIMIT ? null : e.tolerance,
      weakestItem: prof.weakest ? { itemId: prof.weakest.itemId, title: prof.weakest.title, toleranceMinutes: prof.minTolerance! } : null,
    };
  };

  const before = snapshot(plan);
  let current = plan;
  let currentEval = evaluate(current, seed, scenarios, severity);
  const adjustments: Adjustment[] = [];

  for (let step = 0; step < maxChanges; step++) {
    const flex = current.items.filter((i) => !i.locked && i.blocking && i.start !== undefined).sort((a, b) => a.start! - b.start! || a.id.localeCompare(b.id));
    type Cand = { changes: Map<string, Minutes>; adj: Omit<Adjustment, 'reason' | 'gain'>; cost: number };
    const cands: Cand[] = [];
    const seen = new Set<string>();
    const add = (c: Cand) => {
      const k = [...c.changes.entries()].sort().join('|');
      if (!seen.has(k)) {
        seen.add(k);
        cands.push(c);
      }
    };

    for (const it of flex) {
      const s0 = it.start!;
      const others = current.items.filter((o) => o.id !== it.id && o.blocking && o.start !== undefined);
      const prevEnd = Math.max(-Infinity, ...others.filter((o) => o.start! + o.duration <= s0).map((o) => o.start! + o.duration));
      const nextStart = Math.min(Infinity, ...others.filter((o) => o.start! >= s0 + it.duration).map((o) => o.start!));
      const offsets = [-30, -20, -15, -10, -5, 5, 10, 15];
      const positions = new Set<number>(offsets.map((o) => s0 + o));
      if (Number.isFinite(prevEnd)) positions.add(prevEnd);
      if (Number.isFinite(nextStart)) positions.add(nextStart - it.duration);
      for (const p of [...positions].sort((a, b) => a - b)) {
        if (p === s0 || !validMove(current, it, p, origin, maxShift)) continue;
        add({ changes: new Map([[it.id, p]]), adj: { type: 'move', itemId: it.id, title: it.title, fromStart: s0, toStart: p, shiftMinutes: p - s0 }, cost: Math.abs(p - s0) });
      }
    }
    for (let i = 0; i + 1 < flex.length; i++) {
      const a = flex[i]!;
      const b = flex[i + 1]!;
      const between = current.items.some((o) => o.id !== a.id && o.id !== b.id && o.blocking && o.start !== undefined && o.start! < b.start! + b.duration && o.start! + o.duration > a.start!);
      if (between) continue; // only swap true neighbours
      const bStart = a.start!;
      const aStart = a.start! + b.duration;
      const tmp = withStarts(current, new Map([[a.id, aStart], [b.id, bStart]]));
      if (!validMove(tmp, tmp.items.find((x) => x.id === a.id)!, aStart, origin, maxShift) || !validMove(tmp, tmp.items.find((x) => x.id === b.id)!, bStart, origin, maxShift)) continue;
      add({
        changes: new Map([[a.id, aStart], [b.id, bStart]]),
        adj: { type: 'swap', itemId: b.id, title: b.title, fromStart: b.start!, toStart: bStart, shiftMinutes: bStart - b.start!, swapWith: { itemId: a.id, title: a.title, fromStart: a.start!, toStart: aStart } },
        cost: Math.abs(bStart - b.start!) + Math.abs(aStart - a.start!),
      });
    }

    // shift a run of back-to-back tasks earlier together (a single move shows no gain on its own)
    for (let i = 0; i < flex.length; i++) {
      const group = [flex[i]!];
      while (flex[i + group.length] && flex[i + group.length]!.start === group[group.length - 1]!.start! + group[group.length - 1]!.duration) group.push(flex[i + group.length]!);
      if (group.length < 2) continue;
      for (const delta of [5, 10, 15, 20, 30]) {
        const changes = new Map(group.map((g) => [g.id, g.start! - delta] as [string, number]));
        let ok = true;
        let tmp = current;
        for (const g of group) {
          tmp = withStarts(tmp, new Map([[g.id, g.start! - delta]]));
        }
        for (const g of group) if (!validMove(tmp, tmp.items.find((x) => x.id === g.id)!, g.start! - delta, origin, maxShift)) ok = false;
        if (!ok) continue;
        const first = group[0]!;
        add({
          changes,
          adj: {
            type: 'shift_block',
            itemId: first.id,
            title: first.title,
            fromStart: first.start!,
            toStart: first.start! - delta,
            shiftMinutes: -delta,
            alsoMoved: group.slice(1).map((g) => ({ itemId: g.id, title: g.title, fromStart: g.start!, toStart: g.start! - delta })),
          },
          cost: delta * group.length,
        });
      }
    }

    let best: { cand: Cand; ev: { survival: number; tolerance: number }; plan: Plan } | null = null;
    for (const c of cands.sort((x, y) => x.cost - y.cost || x.adj.itemId.localeCompare(y.adj.itemId) || x.adj.toStart - y.adj.toStart)) {
      const next = withStarts(current, c.changes);
      const ev = evaluate(next, seed, scenarios, severity);
      if (ev.survival < currentEval.survival || ev.tolerance < currentEval.tolerance) continue; // never make anything worse
      if (ev.survival === currentEval.survival && ev.tolerance === currentEval.tolerance) continue;
      const better =
        !best ||
        ev.survival > best.ev.survival ||
        (ev.survival === best.ev.survival && ev.tolerance > best.ev.tolerance) ||
        (ev.survival === best.ev.survival && ev.tolerance === best.ev.tolerance && c.cost < best.cand.cost);
      if (better) best = { cand: c, ev, plan: next };
    }
    if (!best) break;

    const gain = { survivalPoints: Math.round((best.ev.survival - currentEval.survival) * 1000) / 10, dayStartToleranceMinutes: best.ev.tolerance - currentEval.tolerance };
    const a = best.cand.adj;
    const where = a.type === 'swap' ? `Swap "${a.title}" and "${a.swapWith!.title}"` : a.type === 'shift_block' ? `Start ${[a.title, ...a.alsoMoved!.map((x) => x.title)].map((t) => `"${t}"`).join(', ')} ${fmtDuration(Math.abs(a.shiftMinutes))} earlier (from ${fmtClock(a.fromStart, tz)} to ${fmtClock(a.toStart, tz)})` : `Move "${a.title}" ${fmtDuration(Math.abs(a.shiftMinutes))} ${a.shiftMinutes < 0 ? 'earlier' : 'later'} (to ${fmtClock(a.toStart, tz)})`;
    const effects: string[] = [];
    if (gain.dayStartToleranceMinutes > 0) effects.push(`the schedule now tolerates ${fmtDuration(gain.dayStartToleranceMinutes)} more lost time at the start of the day`);
    if (gain.survivalPoints > 0) effects.push(`it survives ${gain.survivalPoints} more percentage points of ${scenarios} simulated disruptions`);
    adjustments.push({ ...a, reason: `${where}: ${effects.join(' and ')}. Nothing locked moves and no deadline is affected.`, gain });
    current = best.plan;
    currentEval = best.ev;
  }

  const after = snapshot(current);
  const proposedStarts = current.items
    .filter((i) => i.blocking)
    .map((i) => ({ id: i.id, title: i.title, start: i.start!, end: i.start! + i.duration, changed: i.start !== origin.get(i.id) }))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const explanation: string[] = [];
  if (adjustments.length === 0) explanation.push('No small adjustment improves your resilience without making something else worse. Your schedule is already well balanced for its constraints.');
  else {
    explanation.push(`${adjustments.length} small adjustment${adjustments.length > 1 ? 's' : ''} found. Survival under ${scenarios} simulated disruptions goes from ${Math.round(before.survivalRate * 100)}% to ${Math.round(after.survivalRate * 100)}%.`);
    for (const a of adjustments) explanation.push(a.reason);
  }
  explanation.push('This is a proposal only. Your original schedule and calendars are untouched until you accept it.');
  return { before, after, adjustments, proposedStarts, explanation };
}
