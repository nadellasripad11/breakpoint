/**
 * core engine types. everything in the engine is plain data + pure functions:
 * no i/o, no clock, no randomness except an explicitly seeded prng. the same input
 * always produces the same output.
 *
 * time is integer minutes since the unix epoch (utc). timezones only matter at the edges
 * (parsing, availability windows, formatting) and are handled in `time.ts`.
 */

export type Minutes = number;

export interface Interval {
  start: Minutes;
  end: Minutes;
}

/** event = calendar commitment, task = flexible work, break = protected break */
export type ItemKind = 'event' | 'task' | 'break';
export type Priority = 1 | 2 | 3 | 4 | 5;
/** how much the plan may be rearranged: fixed = keep order, never earlier; balanced = reorder within +/-4h; flexible = anything */
export type Mobility = 'fixed' | 'balanced' | 'flexible';

export interface PlanItem {
  id: string;
  title: string;
  kind: ItemKind;
  /** planned start. undefined = an unscheduled task (the baseline builder will place it). */
  start?: Minutes;
  duration: number;
  /** locked items are never moved, resized or removed by the engine. */
  locked: boolean;
  priority: Priority;
  category?: string;
  /** earliest allowed start (flexible items). */
  release?: Minutes;
  /** hard deadline: the item must end at or before this. */
  deadline?: Minutes;
  /** may be explicitly deferred (and reported) when there is no room. never silently. */
  deferrable: boolean;
  /** missing / overlapping it is a critical failure. */
  critical: boolean;
  /** false = informational (e.g. all-day banner), occupies no time. */
  blocking: boolean;
  origin?: { source: string; externalId?: string; baseId?: string };
}

export interface PlanSettings {
  horizon: Interval;
  /** merged, sorted windows in which flexible items may be placed (e.g. waking hours). */
  availability: Interval[];
  mobility: Mobility;
  /** priority at or above which an item is critical / non-deferrable by default. */
  criticalPriority: Priority;
  /** iana timezone, only used to format messages. */
  timezone: string;
}

export interface Plan {
  items: PlanItem[];
  settings: PlanSettings;
}

/* ───────────── disruptions ───────────── */

export type Disruption =
  /** the target starts `minutes` later (a late arrival, a late-running predecessor). */
  | { type: 'delay'; targetId: string; minutes: number }
  /** the target takes `minutes` longer than planned. */
  | { type: 'overrun'; targetId: string; minutes: number }
  /** a new, locked commitment appears out of nowhere. */
  | { type: 'unexpected'; start: Minutes; duration: number; title?: string; priority?: Priority }
  /** `minutes` of time disappear (traffic, a sick morning). defaults to the start of the plan. */
  | { type: 'lost_time'; minutes: number; start?: Minutes };

/* ───────────── conflicts + cascade output ───────────── */

export type Severity = 'critical' | 'major' | 'minor';

export type ConflictCode =
  | 'locked_overlap' // two locked commitments want the same time
  | 'deadline_missed' // a hard deadline can no longer be met
  | 'break_lost' // a protected break is pushed out of its window
  | 'overflow' // the work no longer fits inside the planning window
  | 'after_hours'; // work spills outside the user's availability

export interface Conflict {
  code: ConflictCode;
  severity: Severity;
  itemId: string;
  otherId?: string;
  minutes: number;
  message: string;
}

export interface ItemOutcome {
  id: string;
  title: string;
  kind: ItemKind;
  locked: boolean;
  injected: boolean;
  original: Interval | null;
  simulated: Interval;
  /** pieces of work when a flexible task is interrupted by a locked commitment and resumed afterwards. */
  fragments: Interval[];
  shiftMinutes: number;
  extendedMinutes: number;
  status: 'unchanged' | 'shifted' | 'conflict' | 'injected';
  causedBy: string | null;
  conflicts: Conflict[];
}

export interface RippleEdge {
  from: string;
  to: string;
  minutes: number;
  reason: string;
}

export interface CascadeResult {
  outcomes: ItemOutcome[];
  conflicts: Conflict[];
  ripple: RippleEdge[];
  injected: PlanItem[];
  summary: {
    shiftedCount: number;
    conflictCount: number;
    criticalCount: number;
    majorCount: number;
    minorCount: number;
    totalShiftMinutes: number;
    maxShiftMinutes: number;
    firstConflictAt: Minutes | null;
    survives: boolean;
    headline: string;
  };
}

/* ───────────── errors ───────────── */

/** raised when an engine invariant is violated (a bug, never user error). */
export class EngineInvariantError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Engine invariant violated: ${violations.join('; ')}`);
    this.name = 'EngineInvariantError';
    this.violations = violations;
  }
}

/** raised for malformed plans (user error). */
export class PlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}
