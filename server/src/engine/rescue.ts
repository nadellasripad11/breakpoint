import type { CascadeResult, Conflict, Disruption, Interval, ItemKind, ItemOutcome, Minutes, Plan, PlanItem } from './types.ts';
import { simulateCascade } from './cascade.ts';
import { describeDisruption } from './world.ts';
import { STRATEGIES, parallelFutures } from './futures.ts';
import type { Future, FutureItem, FuturesResult, StrategyId } from './futures.ts';
import type { Diagnosis } from './diagnose.ts';
import { baselineIssues } from './validate.ts';
import type { BaselineIssue } from './validate.ts';
import { fmtClock, fmtDuration } from './time.ts';
import { explainRescue, pipWords } from './explain.ts';
import type { PipLine } from './explain.ts';

/**
 * Rescue My Day.
 *
 * When a schedule breaks, compute the smallest set of changes that makes it valid again, and show three things side by side:
 * the original day, the day after the disruption (what happens if you carry on), and the repaired day.
 *
 * "Smallest" has one precise meaning, applied in this order:
 *   1. defer nothing if a valid schedule exists that keeps every task (otherwise defer the least important work, explicitly);
 *   2. touch the fewest items (an item "keeps" its slot only if it starts at exactly its original time);
 *   3. move the touched items the fewest total minutes (exact: least total distance over every order and every minute).
 * Locked commitments never move, hard deadlines are never missed, protected breaks stay inside their windows.
 * If no schedule satisfies those rules the result says so, explains why with numbers, and changes nothing.
 */

export type RescueStatus = 'absorbed' | 'repaired' | 'repaired_with_deferrals' | 'impossible';

export interface LaneBlock {
  id: string;
  title: string;
  kind: ItemKind;
  start: Minutes;
  end: Minutes;
  /** pieces of work when a task is interrupted by a locked commitment and resumed (otherwise one piece = [start, end]) */
  pieces: Interval[];
  locked: boolean;
  injected: boolean;
  /** a protected break */
  protectedBreak: boolean;
  deadline: number | null;
  /** earliest start (protected breaks: the start of their window) */
  release: number | null;
  state: 'ok' | 'shifted' | 'conflict' | 'moved';
  /** minutes later (+) or earlier (-) than in the original plan */
  shiftedBy: number;
  conflictCodes: string[];
}

export interface Lane {
  key: 'original' | 'disrupted' | 'repaired';
  title: string;
  blocks: LaneBlock[];
  summary: string;
}

export interface ChainStep {
  itemId: string;
  title: string;
  minutes: number;
  /** e.g. "starts 45 minutes late", "gets pushed back 20 minutes by Project" */
  text: string;
}

export interface ExplainedConflict extends Conflict {
  itemTitle: string;
  otherTitle: string | null;
  /** how much room the item had in the ORIGINAL plan before its deadline (null when it has no deadline) */
  slackBefore: number | null;
  /** how far past its limit it lands (same as `minutes` for deadline / window conflicts) */
  lateBy: number | null;
  /** how the disruption travelled to this item, root cause first */
  chain: ChainStep[];
  /** one sentence with the exact numbers */
  detail: string;
}

export interface Change {
  id: string;
  title: string;
  kind: ItemKind;
  from: Interval;
  to: Interval;
  /** minutes later (+) or earlier (-) */
  deltaMinutes: number;
  why: string;
}

export interface Guarantee {
  key: 'locked_unmoved' | 'deadlines_met' | 'breaks_protected' | 'no_overlap' | 'nothing_deleted' | 'within_hours';
  ok: boolean;
  label: string;
  /** what was actually checked, with counts */
  detail: string;
}

export interface ReplayFrame {
  phase: 'original' | 'disruption' | 'conflicts' | 'repair' | 'done';
  caption: string;
  blocks: LaneBlock[];
  /** item ids to highlight in this frame */
  focus: string[];
}

/** Everything about one way of repairing the day: the repaired lane, what moves, the rules re-checked, Pip's words and the replay. */
export interface RescueView {
  status: RescueStatus;
  headline: string;
  lane: Lane;
  changes: Change[];
  deferred: Future['deferred'];
  metrics: { moved: number; kept: number; totalMinutes: number; maxMinutes: number; deferred: number; conflictsBefore: number };
  guarantees: Guarantee[];
  pip: PipLine[];
  replay: ReplayFrame[];
  optimal: boolean;
}

/** One of the three ways forward. `view` is null when that strategy has no valid schedule (`note` says why). */
export interface RescueOption {
  strategy: StrategyId;
  title: string;
  description: string;
  feasible: boolean;
  /** the engine's own pick: keeps every task and changes the least */
  recommended: boolean;
  /** the earlier way forward (in the order listed) that lands on exactly the same schedule, or null when this one is different */
  sameAs: StrategyId | null;
  view: RescueView | null;
  note: string;
}

export interface RescueResult {
  /** which strategy the top-level repaired lane, changes and metrics come from (always the smallest change) */
  strategy: StrategyId;
  status: RescueStatus;
  headline: string;
  timezone: string;
  window: Interval;
  disruptions: string[];
  baselineIssues: BaselineIssue[];
  lanes: { original: Lane; disrupted: Lane; repaired: Lane | null };
  conflicts: ExplainedConflict[];
  changes: Change[];
  deferred: Future['deferred'];
  metrics: { moved: number; kept: number; totalMinutes: number; maxMinutes: number; deferred: number; conflictsBefore: number };
  /** the rules, re-checked against the repaired schedule (not assumed) */
  guarantees: Guarantee[];
  diagnosis: Diagnosis | null;
  pip: PipLine[];
  replay: ReplayFrame[];
  /** all three ways forward, each with its own repaired lane (same disruption, different priorities) */
  options: RescueOption[];
  /** other strategies' cost, for comparison */
  alternatives: { strategy: string; title: string; moved: number; totalMinutes: number; deferred: number }[];
  /** true when the repair is proven the smallest by the rule above */
  optimal: boolean;
}

/* ───────────── lanes ───────────── */

function planBlock(it: PlanItem, start: number, duration: number, extra: Partial<LaneBlock> = {}): LaneBlock {
  const isBreak = it.kind === 'break';
  return {
    id: it.id,
    title: it.title,
    kind: it.kind,
    start,
    end: start + duration,
    pieces: [{ start, end: start + duration }],
    locked: it.locked,
    injected: false,
    protectedBreak: isBreak,
    deadline: it.deadline ?? null,
    release: it.release ?? null,
    state: 'ok',
    shiftedBy: 0,
    conflictCodes: [],
    ...extra,
  };
}

function originalLane(plan: Plan): Lane {
  const blocks = plan.items.filter((i) => i.blocking && i.start !== undefined).map((i) => planBlock(i, i.start!, i.duration)).sort(byStart);
  const tasks = blocks.filter((b) => !b.locked).length;
  return { key: 'original', title: 'Original', blocks, summary: `${blocks.length} items (${blocks.length - tasks} locked, ${tasks} flexible)` };
}

function disruptedLane(plan: Plan, cascade: CascadeResult): Lane {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const blocks: LaneBlock[] = [];
  for (const o of cascade.outcomes) {
    const it = byId.get(o.id);
    if (it && !it.blocking) continue;
    blocks.push(outcomeBlock(o, it));
  }
  blocks.sort(byStart);
  return { key: 'disrupted', title: 'After the disruption', blocks, summary: cascade.summary.headline };
}

function outcomeBlock(o: ItemOutcome, it: PlanItem | undefined): LaneBlock {
  const state: LaneBlock['state'] = o.status === 'conflict' ? 'conflict' : o.status === 'shifted' ? 'shifted' : 'ok';
  const base = it
    ? planBlock(it, o.simulated.start, o.simulated.end - o.simulated.start)
    : { id: o.id, title: o.title, kind: o.kind, start: o.simulated.start, end: o.simulated.end, pieces: [], locked: o.locked, injected: o.injected, protectedBreak: false, deadline: null, release: null, state: 'ok' as const, shiftedBy: 0, conflictCodes: [] as string[] };
  return {
    ...base,
    pieces: o.fragments.length ? o.fragments.map((f) => ({ start: f.start, end: f.end })) : [{ start: o.simulated.start, end: o.simulated.end }],
    injected: o.injected,
    state,
    shiftedBy: o.shiftMinutes,
    conflictCodes: o.conflicts.map((c) => c.code),
  };
}

function repairedLane(plan: Plan, f: Future): Lane {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const blocks: LaneBlock[] = [];
  for (const it of f.items) {
    const src = byId.get(it.id);
    if (src && !src.blocking) continue;
    const base: LaneBlock = src
      ? planBlock(src, it.start, it.end - it.start)
      : { id: it.id, title: it.title, kind: it.kind, start: it.start, end: it.end, pieces: [{ start: it.start, end: it.end }], locked: it.locked, injected: it.injected, protectedBreak: false, deadline: null, release: null, state: 'ok', shiftedBy: 0, conflictCodes: [] };
    blocks.push({ ...base, injected: it.injected, state: it.status === 'moved' ? 'moved' : 'ok', shiftedBy: it.movedByMinutes });
  }
  blocks.sort(byStart);
  return { key: 'repaired', title: 'Repaired', blocks, summary: `${f.metrics.movedCount} moved, ${f.metrics.keptCount} kept, ${fmtDuration(f.metrics.totalDisplacementMinutes)} of movement${f.deferred.length ? `, ${f.deferred.length} deferred` : ''}` };
}

const byStart = (a: { start: number; id: string }, b: { start: number; id: string }) => a.start - b.start || a.id.localeCompare(b.id);

/* ───────────── conflicts, explained with numbers ───────────── */

function explainConflicts(plan: Plan, cascade: CascadeResult): ExplainedConflict[] {
  const tz = plan.settings.timezone;
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const outcome = new Map(cascade.outcomes.map((o) => [o.id, o]));
  const title = (id: string | undefined) => (id ? outcome.get(id)?.title ?? byId.get(id)?.title ?? id : '');
  const edges = new Map(cascade.ripple.map((e) => [e.to, e]));

  const chainFor = (itemId: string): ChainStep[] => {
    const steps: ChainStep[] = [];
    const seen = new Set<string>();
    let cur = itemId;
    while (!seen.has(cur)) {
      seen.add(cur);
      const e = edges.get(cur);
      if (!e) break;
      const root = e.from.startsWith('delay:');
      const name = title(cur);
      const text =
        e.reason === 'starts late' ? `"${name}" starts ${pipWords(e.minutes)} late`
        : e.reason === 'runs longer' ? `"${name}" runs ${pipWords(e.minutes)} longer`
        : e.reason === 'locked commitments overlap' ? `"${name}" overlaps "${title(e.from)}" for ${pipWords(e.minutes)}`
        : `"${name}" gets pushed back ${pipWords(e.minutes)}`;
      steps.unshift({ itemId: cur, title: name, minutes: e.minutes, text });
      if (root) break;
      cur = e.from;
    }
    return steps;
  };

  return cascade.conflicts.map((c) => {
    const it = byId.get(c.itemId);
    const o = outcome.get(c.itemId);
    const origEnd = it?.start !== undefined ? it.start + (o?.original ? o.original.end - o.original.start : it.duration) : null;
    const slackBefore = it?.deadline !== undefined && origEnd !== null ? it.deadline - origEnd : null;
    const chain = chainFor(c.itemId);
    const simEnd = o?.simulated.end;
    let detail = c.message;
    if ((c.code === 'deadline_missed' || c.code === 'break_lost') && it?.deadline !== undefined && simEnd !== undefined) {
      const slack = slackBefore !== null && slackBefore >= 0 ? `In your plan it had ${pipWords(slackBefore)} to spare. ` : '';
      const travel = chain.length ? `${chain.map((s) => s.text).join(', so ')}. ` : '';
      detail = `${travel}${slack}It would now end at ${fmtClock(simEnd, tz)}, ${pipWords(c.minutes)} after its ${fmtClock(it.deadline, tz)} ${c.code === 'break_lost' ? 'window closes' : 'deadline'}.`;
    } else if (c.code === 'locked_overlap') {
      detail = `${c.message} Neither can move, so this cannot be solved by shuffling flexible work.`;
    } else if (chain.length) {
      detail = `${c.message} ${chain.map((s) => s.text).join(', so ')}.`;
    }
    return { ...c, itemTitle: title(c.itemId), otherTitle: c.otherId ? title(c.otherId) : null, slackBefore, lateBy: c.minutes, chain, detail };
  });
}

/* ───────────── guarantees, re-verified ───────────── */

function checkGuarantees(plan: Plan, repaired: Lane, f: Future): Guarantee[] {
  const blocks = repaired.blocks;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const out: Guarantee[] = [];

  const locked = plan.items.filter((i) => i.locked && i.blocking && i.start !== undefined);
  const movedLocked = locked.filter((i) => {
    const b = byId.get(i.id);
    return !b || b.start !== i.start || b.end !== i.start! + i.duration;
  });
  out.push({ key: 'locked_unmoved', ok: movedLocked.length === 0, label: 'Locked events untouched', detail: `${locked.length - movedLocked.length} of ${locked.length} locked items are at exactly their original time` });

  const withDeadline = blocks.filter((b) => !b.locked && b.deadline !== null && b.kind !== 'break');
  const late = withDeadline.filter((b) => b.end > b.deadline!);
  out.push({ key: 'deadlines_met', ok: late.length === 0, label: 'Deadlines met', detail: `${withDeadline.length - late.length} of ${withDeadline.length} deadlines are met` });

  const breaks = plan.items.filter((i) => i.kind === 'break' && i.blocking);
  const badBreaks = breaks.filter((i) => {
    const b = byId.get(i.id);
    if (!b) return true;
    if (i.locked) return b.start !== i.start;
    return (i.release !== undefined && b.start < i.release) || (i.deadline !== undefined && b.end > i.deadline);
  });
  out.push({ key: 'breaks_protected', ok: badBreaks.length === 0, label: 'Protected breaks kept', detail: `${breaks.length - badBreaks.length} of ${breaks.length} protected breaks are kept inside their windows` });

  const sorted = [...blocks].sort(byStart);
  let overlaps = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) overlaps++;
  out.push({ key: 'no_overlap', ok: overlaps === 0, label: 'Nothing overlaps', detail: `${overlaps} overlaps among ${blocks.length} blocks` });

  const blocking = plan.items.filter((i) => i.blocking && i.start !== undefined);
  const missing = blocking.filter((i) => !byId.has(i.id) && !f.deferred.some((d) => d.id === i.id));
  out.push({ key: 'nothing_deleted', ok: missing.length === 0, label: 'Nothing deleted', detail: `${blocking.length - missing.length} of ${blocking.length} items are scheduled${f.deferred.length ? `, ${f.deferred.length} listed as deferred` : ''}` });

  const avail = plan.settings.availability;
  const outside = blocks.filter((b) => !b.locked && !avail.some((a) => b.start >= a.start && b.end <= a.end));
  out.push({ key: 'within_hours', ok: outside.length === 0, label: 'Inside your available hours', detail: `${blocks.filter((b) => !b.locked).length - outside.length} of ${blocks.filter((b) => !b.locked).length} flexible blocks are inside your hours` });
  return out;
}

/* ───────────── the rescue ───────────── */

export function rescueDay(plan: Plan, disruptions: readonly Disruption[]): RescueResult {
  const tz = plan.settings.timezone;
  const cascade = simulateCascade(plan, disruptions);
  const futures: FuturesResult = parallelFutures(plan, disruptions);
  const repaired = futures.futures.find((f) => f.strategy === 'minimize_changes')!;
  const original = originalLane(plan);
  const disrupted = disruptedLane(plan, cascade);
  const conflicts = explainConflicts(plan, cascade);
  const descs = disruptions.map((d) => describeDisruption(d, plan));
  const alternatives = futures.futures
    .filter((f) => f.feasible && f.strategy !== 'minimize_changes')
    .map((f) => ({ strategy: f.strategy, title: f.title, moved: f.metrics.movedCount, totalMinutes: f.metrics.totalDisplacementMinutes, deferred: f.deferred.length }));

  /** one repaired day, built from one strategy's future */
  const view = (f: Future): RescueView => {
    const lane = repairedLane(plan, f);
    const changes = buildChanges(plan, f, lane, disrupted, tz);
    const status: RescueStatus = f.deferred.length ? 'repaired_with_deferrals' : conflicts.length === 0 ? 'absorbed' : 'repaired';
    const m = f.metrics;
    const moves = `${changes.length} ${changes.length === 1 ? 'item moves' : 'items move'}, ${fmtDuration(m.totalDisplacementMinutes)} of movement in total`;
    const headline =
      status === 'absorbed' && changes.length === 0
        ? 'Your day absorbs this disruption: no conflicts and nothing has to move.'
        : status === 'repaired_with_deferrals'
          ? `Rescued, but ${f.deferred.length} ${f.deferred.length === 1 ? 'task' : 'tasks'} had to be deferred (never deleted): ${changes.length} moved, ${fmtDuration(m.totalDisplacementMinutes)} of movement.`
          : f.strategy === 'minimize_changes'
            ? `Rescued with the smallest change: ${moves}. Locked events, deadlines and protected breaks are untouched.`
            : `Rescued with "${f.title}": ${moves}. Locked events, deadlines and protected breaks are untouched.`;
    return {
      status,
      headline,
      lane,
      changes,
      deferred: f.deferred,
      metrics: { moved: m.movedCount, kept: m.keptCount, totalMinutes: m.totalDisplacementMinutes, maxMinutes: m.maxDisplacementMinutes, deferred: m.deferredCount, conflictsBefore: conflicts.length },
      guarantees: checkGuarantees(plan, lane, f),
      pip: explainRescue({ plan, disruptions, cascade, futures, repaired: f, changes, status }),
      replay: buildReplay(plan, disruptions, original, disrupted, lane, changes, conflicts, tz),
      optimal: f.optimal,
    };
  };

  const smallest = repaired.feasible ? view(repaired) : null;
  // two strategies can land on the very same day; say so instead of showing two identical cards as if they were different
  const slots = (f: Future) => f.deferred.map((d) => d.id).sort().join(',') + '|' + f.items.map((i) => `${i.id}@${i.start}:${i.end}`).sort().join(',');
  const firstWith = new Map<string, StrategyId>();
  const options: RescueOption[] = futures.futures.map((f) => {
    const key = f.feasible ? slots(f) : null;
    const sameAs = key !== null ? firstWith.get(key) ?? null : null;
    if (key !== null && sameAs === null) firstWith.set(key, f.strategy);
    return {
      strategy: f.strategy,
      title: STRATEGIES[f.strategy].title,
      description: STRATEGIES[f.strategy].description,
      feasible: f.feasible,
      recommended: futures.recommended === f.strategy,
      sameAs,
      view: f === repaired ? smallest : f.feasible ? view(f) : null,
      note: f.feasible ? f.explanation[0] ?? '' : f.diagnosis?.summary ?? 'No valid schedule exists for this strategy.',
    };
  });

  if (!smallest) {
    const diagnosis = repaired.diagnosis ?? null;
    const pip = explainRescue({ plan, disruptions, cascade, futures, repaired: null, changes: [], status: 'impossible' });
    return {
      strategy: 'minimize_changes',
      status: 'impossible',
      headline: diagnosis?.summary ?? 'No valid schedule exists under these constraints. Nothing was changed.',
      timezone: tz,
      window: plan.settings.horizon,
      disruptions: descs,
      baselineIssues: baselineIssues(plan),
      lanes: { original, disrupted, repaired: null },
      conflicts,
      changes: [],
      deferred: [],
      metrics: { moved: 0, kept: 0, totalMinutes: 0, maxMinutes: 0, deferred: 0, conflictsBefore: conflicts.length },
      guarantees: [],
      diagnosis,
      pip,
      replay: buildReplay(plan, disruptions, original, disrupted, null, [], conflicts, tz),
      options,
      alternatives,
      optimal: repaired.optimal,
    };
  }

  return {
    strategy: 'minimize_changes',
    status: smallest.status,
    headline: smallest.headline,
    timezone: tz,
    window: plan.settings.horizon,
    disruptions: descs,
    baselineIssues: baselineIssues(plan),
    lanes: { original, disrupted, repaired: smallest.lane },
    conflicts,
    changes: smallest.changes,
    deferred: smallest.deferred,
    metrics: smallest.metrics,
    guarantees: smallest.guarantees,
    diagnosis: null,
    pip: smallest.pip,
    replay: smallest.replay,
    options,
    alternatives,
    optimal: smallest.optimal,
  };
}

/**
 * "Test it again": the same day with one way forward adopted, as a new plan. Every item sits where that repair put it (an
 * overrun keeps its new length, an unexpected commitment becomes a locked event) and deferred tasks are set aside (kept, but no longer taking time).
 * Pure: the original plan is untouched. Null when that strategy has no valid schedule.
 */
export function adoptRepair(plan: Plan, disruptions: readonly Disruption[], strategy: StrategyId = 'minimize_changes'): Plan | null {
  const f = parallelFutures(plan, disruptions).futures.find((x) => x.strategy === strategy);
  if (!f || !f.feasible) return null;
  const placed = new Map(f.items.filter((i) => !i.injected).map((i) => [i.id, i]));
  const deferred = new Set(f.deferred.map((d) => d.id));
  const items: PlanItem[] = [];
  for (const it of plan.items) {
    const p = placed.get(it.id);
    if (p) items.push({ ...it, start: p.start, duration: p.end - p.start });
    else if (deferred.has(it.id)) {
      // set aside, not deleted: it stays in the plan but no longer takes time until the visitor places it
      items.push({ ...it, blocking: false });
    } else items.push(it);
  }
  for (const i of f.items) {
    if (i.injected) items.push({ id: i.id, title: i.title, kind: 'event', start: i.start, duration: i.end - i.start, locked: true, priority: 5, deferrable: false, critical: false, blocking: true });
  }
  return { ...plan, items };
}

function buildChanges(plan: Plan, f: Future, lane: Lane, disrupted: Lane, tz: string): Change[] {
  const byId = new Map(lane.blocks.map((b) => [b.id, b]));
  const sim = new Map(disrupted.blocks.map((b) => [b.id, b]));
  const changes: Change[] = [];
  for (const it of f.items as FutureItem[]) {
    if (it.status !== 'moved' || !it.original) continue;
    const b = byId.get(it.id)!;
    const others = lane.blocks.filter((x) => x.id !== it.id).sort(byStart);
    const prev = [...others].reverse().find((x) => x.end <= b.start);
    const next = others.find((x) => x.start >= b.end);
    const d = it.movedByMinutes;
    const was = sim.get(it.id);
    const lead = was && was.state === 'conflict' ? 'It would have broken the day where it was' : was && was.state === 'shifted' ? `It would have been pushed to ${fmtClock(was.start, tz)} anyway` : 'It had to make room';
    const fit =
      prev && next ? `now fits between "${prev.title}" (ends ${fmtClock(prev.end, tz)}) and "${next.title}" (starts ${fmtClock(next.start, tz)})`
      : prev ? `now starts after "${prev.title}" ends at ${fmtClock(prev.end, tz)}`
      : next ? `now ends before "${next.title}" starts at ${fmtClock(next.start, tz)}`
      : 'now has the day to itself';
    changes.push({
      id: it.id,
      title: it.title,
      kind: it.kind,
      from: it.original,
      to: { start: it.start, end: it.end },
      deltaMinutes: d,
      why: `Move "${it.title}" from ${fmtClock(it.original.start, tz)} to ${fmtClock(it.start, tz)} (${pipWords(Math.abs(d))} ${d > 0 ? 'later' : 'earlier'}). ${lead}; ${fit}.`,
    });
  }
  return changes.sort((a, b) => a.to.start - b.to.start || a.id.localeCompare(b.id));
}

/* ───────────── replay ───────────── */

function buildReplay(plan: Plan, disruptions: readonly Disruption[], original: Lane, disrupted: Lane, repaired: Lane | null, changes: readonly Change[], conflicts: readonly ExplainedConflict[], tz: string): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  const copy = (blocks: readonly LaneBlock[]): LaneBlock[] => blocks.map((b) => ({ ...b, pieces: b.pieces.map((p) => ({ ...p })), conflictCodes: [...b.conflictCodes] }));
  const n = plan.items.filter((i) => i.blocking && i.start !== undefined).length;
  frames.push({ phase: 'original', caption: `Your day as planned: ${n} items, nothing in conflict.`, blocks: copy(original.blocks), focus: [] });

  // one frame per disruption, applied cumulatively: the ripple builds up step by step
  for (let i = 0; i < disruptions.length; i++) {
    const c = simulateCascade(plan, disruptions.slice(0, i + 1));
    const lane = disruptedLane(plan, c);
    const d = disruptions[i]!;
    const focus = d.type === 'delay' || d.type === 'overrun' ? [d.targetId] : c.injected.map((x) => x.id);
    frames.push({ phase: 'disruption', caption: `${cap(describeDisruption(d, plan))}. ${c.summary.headline}`, blocks: copy(lane.blocks), focus });
  }

  if (conflicts.length) {
    frames.push({ phase: 'conflicts', caption: `${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'} if you carry on: ${conflicts[0]!.message}`, blocks: copy(disrupted.blocks), focus: conflicts.map((c) => c.itemId) });
  }
  if (!repaired) return frames;

  // repair: apply each move, one at a time, in the order they happen in the day
  let cur = copy(disrupted.blocks);
  const target = new Map(repaired.blocks.map((b) => [b.id, b]));
  const todo = cur
    .filter((b) => !b.locked)
    .map((b) => ({ b, t: target.get(b.id) }))
    .filter((x) => x.t && (x.t.start !== x.b.start || x.t.end !== x.b.end || x.b.pieces.length > 1))
    .sort((a, b) => a.t!.start - b.t!.start || a.b.id.localeCompare(b.b.id));
  for (const { b, t } of todo) {
    const orig = original.blocks.find((x) => x.id === b.id);
    const back = orig && orig.start === t!.start;
    cur = cur.map((x) => (x.id === b.id ? { ...x, ...t!, state: back ? 'ok' : 'moved', conflictCodes: [] } : x));
    const d = orig ? t!.start - orig.start : 0;
    frames.push({
      phase: 'repair',
      caption: back
        ? `Put "${b.title}" back at ${fmtClock(t!.start, tz)}.`
        : `Move "${b.title}" to ${fmtClock(t!.start, tz)}${orig ? ` (${pipWords(Math.abs(d))} ${d > 0 ? 'later' : 'earlier'} than planned)` : ''}.`,
      blocks: copy(cur),
      focus: [b.id],
    });
  }
  frames.push({
    phase: 'done',
    caption: changes.length ? `Done: ${changes.length} ${changes.length === 1 ? 'move' : 'moves'}, and nothing locked, due or protected was touched.` : 'Done: nothing needed to move.',
    blocks: copy(repaired.blocks),
    focus: [],
  });
  return frames;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
