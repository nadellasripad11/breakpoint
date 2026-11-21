import type { CascadeResult, Conflict, Disruption, Interval, ItemOutcome, Plan, RippleEdge, Severity } from './types.ts';
import { fmtClock, fmtDuration } from './time.ts';
import { intersectIntervals, mergeIntervals, totalLength } from './intervals.ts';
import { applyDisruptions, lockedInterval } from './world.ts';
import type { WorkItem } from './world.ts';

/**
 * butterfly effect: what happens if you apply the disruptions and then simply carry on?
 *
 * rules (deterministic):
 *  - locked commitments never move. if two locked commitments end up overlapping, that is a conflict.
 *  - flexible work yields to locked commitments: it is paused while a locked block runs and resumed after.
 *  - flexible items keep their original order and start when you are free (never earlier than planned).
 *  - nothing is dropped. anything that no longer fits is reported as a conflict.
 */
export function simulateCascade(plan: Plan, disruptions: readonly Disruption[]): CascadeResult {
  const { settings } = plan;
  const tz = settings.timezone;
  const { work, injected } = applyDisruptions(plan, disruptions);

  const lockedBlocks: Interval[] = mergeIntervals(work.filter((w) => w.locked && w.blocking).map(lockedInterval));
  const order = work
    .filter((w) => w.blocking)
    .sort((a, b) => a.origStart - b.origStart || Number(b.locked) - Number(a.locked) || a.id.localeCompare(b.id));

  const outcomes = new Map<string, ItemOutcome>();
  const conflicts: Conflict[] = [];
  const ripple: RippleEdge[] = [];
  const idToItem = new Map(work.map((w) => [w.id, w]));
  const nameOf = (id: string | null | undefined) => (id ? idToItem.get(id)?.title ?? id : 'the disruption');

  let cursor = -Infinity;
  let cursorOwner: string | null = null;
  let lockedCursor = -Infinity;
  let lockedOwner: WorkItem | null = null;

  const push = (c: Conflict, out: ItemOutcome) => {
    conflicts.push(c);
    out.conflicts.push(c);
  };

  for (const w of order) {
    const out: ItemOutcome = {
      id: w.id,
      title: w.title,
      kind: w.kind,
      locked: w.locked,
      injected: w.injected,
      original: w.injected ? null : { start: w.origStart, end: w.origStart + w.origDuration },
      simulated: { start: w.start, end: w.start + w.duration },
      fragments: [],
      shiftMinutes: 0,
      extendedMinutes: w.extendedBy,
      status: w.injected ? 'injected' : 'unchanged',
      causedBy: null,
      conflicts: [],
    };
    outcomes.set(w.id, out);

    if (w.locked) {
      const s = w.start;
      const e = s + w.duration;
      out.simulated = { start: s, end: e };
      out.fragments = [{ start: s, end: e }];
      out.shiftMinutes = w.injected ? 0 : s - w.origStart;
      if (w.shiftedBy > 0) out.causedBy = `delay:${w.id}`;
      if (lockedOwner && s < lockedCursor) {
        const overlap = Math.min(lockedCursor - s, w.duration, lockedOwner.duration);
        if (overlap > 0) {
          const sev: Severity = w.critical || lockedOwner.critical ? 'critical' : 'major';
          push(
            {
              code: 'locked_overlap',
              severity: sev,
              itemId: w.id,
              otherId: lockedOwner.id,
              minutes: overlap,
              message: `"${w.title}" overlaps "${lockedOwner.title}" by ${fmtDuration(overlap)}. Both are locked, so you can't be in both places.`,
            },
            out,
          );
          ripple.push({ from: lockedOwner.id, to: w.id, minutes: overlap, reason: 'locked commitments overlap' });
        }
      }
      if (e > lockedCursor) {
        lockedCursor = e;
        lockedOwner = w;
      }
    } else {
      // flexible: starts when you are free, never earlier than planned, pauses around locked blocks
      const notBefore = Math.max(w.start, w.release ?? -Infinity);
      let pos = Math.max(notBefore, cursor);
      let cause: string | null = cursor > notBefore ? cursorOwner : w.shiftedBy > 0 ? `delay:${w.id}` : null;
      let remaining = w.duration;
      const fragments: Interval[] = [];
      let guard = 0;
      while (remaining > 0 && guard++ < lockedBlocks.length + 4) {
        const inside = lockedBlocks.find((b) => b.start <= pos && pos < b.end);
        if (inside) {
          pos = inside.end;
          const owner = work.find((x) => x.locked && x.blocking && x.start === inside.start);
          if (fragments.length === 0 && owner) cause = owner.id;
          continue;
        }
        const next = lockedBlocks.find((b) => b.start > pos);
        const room = next ? next.start - pos : Infinity;
        const take = Math.min(remaining, room);
        fragments.push({ start: pos, end: pos + take });
        remaining -= take;
        pos += take;
      }
      const first = fragments[0]!.start;
      const last = fragments[fragments.length - 1]!.end;
      out.fragments = fragments;
      out.simulated = { start: first, end: last };
      out.shiftMinutes = first - w.origStart;
      out.causedBy = cause;
      cursor = last;
      cursorOwner = w.id;

      const changed = out.shiftMinutes !== 0 || w.extendedBy > 0 || fragments.length > 1;
      const hardDeadline = w.deadline;
      if (hardDeadline !== undefined && last > hardDeadline) {
        const late = last - hardDeadline;
        if (w.kind === 'break') {
          push(
            {
              code: 'break_lost',
              severity: w.critical ? 'critical' : 'major',
              itemId: w.id,
              minutes: late,
              message: `"${w.title}" can no longer happen inside its window: it would end at ${fmtClock(last, tz)}, ${fmtDuration(late)} after the window closes at ${fmtClock(hardDeadline, tz)}.`,
            },
            out,
          );
        } else {
          push(
            {
              code: 'deadline_missed',
              severity: w.deferrable ? 'major' : 'critical',
              itemId: w.id,
              minutes: late,
              message: `"${w.title}" would finish at ${fmtClock(last, tz)}, ${fmtDuration(late)} after its ${fmtClock(hardDeadline, tz)} deadline.`,
            },
            out,
          );
        }
      }
      if (last > settings.horizon.end && !(hardDeadline !== undefined && hardDeadline <= settings.horizon.end && last > hardDeadline)) {
        const over = last - settings.horizon.end;
        push(
          {
            code: 'overflow',
            severity: w.deferrable ? 'major' : 'critical',
            itemId: w.id,
            minutes: over,
            message: `"${w.title}" no longer fits before the planning window ends at ${fmtClock(settings.horizon.end, tz)} (${fmtDuration(over)} over).`,
          },
          out,
        );
      }
      if (changed) {
        const inside = totalLength(intersectIntervals(fragments, settings.availability));
        const outside = totalLength(fragments) - inside;
        if (outside > 0) {
          push(
            {
              code: 'after_hours',
              severity: 'minor',
              itemId: w.id,
              minutes: outside,
              message: `"${w.title}" now runs ${fmtDuration(outside)} outside your available hours.`,
            },
            out,
          );
        }
      }
      if (out.shiftMinutes !== 0 || w.extendedBy > 0) {
        ripple.push({
          from: cause ?? `delay:${w.id}`,
          to: w.id,
          minutes: Math.abs(out.shiftMinutes) || w.extendedBy,
          reason: w.extendedBy > 0 && out.shiftMinutes === 0 ? 'runs longer' : cause?.startsWith('delay:') ? 'starts late' : 'pushed back',
        });
      }
    }
    if (out.conflicts.length) out.status = 'conflict';
    else if (!w.injected && (out.shiftMinutes !== 0 || out.extendedMinutes > 0 || out.fragments.length > 1)) out.status = 'shifted';
  }

  // non-blocking items are reported unchanged
  for (const w of work) {
    if (w.blocking) continue;
    outcomes.set(w.id, {
      id: w.id,
      title: w.title,
      kind: w.kind,
      locked: w.locked,
      injected: false,
      original: { start: w.origStart, end: w.origStart + w.origDuration },
      simulated: { start: w.start, end: w.start + w.duration },
      fragments: [],
      shiftMinutes: 0,
      extendedMinutes: 0,
      status: 'unchanged',
      causedBy: null,
      conflicts: [],
    });
  }

  const list = work.map((w) => outcomes.get(w.id)!).sort((a, b) => a.simulated.start - b.simulated.start || a.id.localeCompare(b.id));
  const sevCount = (s: Severity) => conflicts.filter((c) => c.severity === s).length;
  const shifted = list.filter((o) => o.status === 'shifted' || (o.status === 'conflict' && o.shiftMinutes !== 0));
  const firstConflictItem = conflicts.length ? conflicts.map((c) => outcomes.get(c.itemId)!.simulated.start).sort((a, b) => a - b)[0]! : null;
  const critical = conflicts.filter((c) => c.severity === 'critical');
  const sorted = [...conflicts].sort((a, b) => rank(b.severity) - rank(a.severity) || b.minutes - a.minutes);
  const maxShift = list.reduce((m, o) => Math.max(m, Math.abs(o.shiftMinutes)), 0);

  let headline: string;
  if (disruptions.length === 0) headline = 'No disruption applied.';
  else if (critical.length > 0) headline = sorted[0]!.message + (critical.length > 1 ? ` (+${critical.length - 1} more critical)` : '');
  else if (conflicts.length > 0) headline = sorted[0]!.message + (conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : '');
  else if (shifted.length > 0) headline = `Absorbed: ${shifted.length} item${shifted.length > 1 ? 's' : ''} shift by up to ${fmtDuration(maxShift)} with no conflicts.`;
  else headline = 'No impact on the rest of the day.';

  return {
    outcomes: list,
    conflicts: sorted,
    ripple,
    injected,
    summary: {
      shiftedCount: shifted.length,
      conflictCount: conflicts.length,
      criticalCount: sevCount('critical'),
      majorCount: sevCount('major'),
      minorCount: sevCount('minor'),
      totalShiftMinutes: list.reduce((t, o) => t + Math.max(0, o.shiftMinutes), 0),
      maxShiftMinutes: maxShift,
      firstConflictAt: firstConflictItem,
      survives: critical.length === 0,
      headline,
    },
  };
}

function rank(s: Severity): number {
  return s === 'critical' ? 3 : s === 'major' ? 2 : 1;
}

/** stable identity of a conflict so "new" conflicts can be told apart from pre-existing ones. */
export function conflictKey(c: Conflict): string {
  return `${c.code}:${c.itemId}:${c.otherId ?? ''}`;
}
