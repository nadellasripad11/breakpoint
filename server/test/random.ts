import type { Plan, PlanItem } from '../src/engine/index.ts';
import { Rng, buildBaseline } from '../src/engine/index.ts';
import { at, mkPlan, settings } from './helpers.ts';

/** seeded random but valid plan: a few locked events plus flexible tasks placed by the baseline builder. */
export function randomPlan(seed: number, opts: { mobility?: 'fixed' | 'balanced' | 'flexible'; maxTasks?: number } = {}): Plan | null {
  const rng = new Rng(seed);
  const items: (Partial<PlanItem> & { id: string; duration: number })[] = [];
  // locked events, non-overlapping, between 09:00 and 19:00
  let cursor = at(9) + rng.int(0, 6) * 15;
  const nEvents = rng.int(0, 3);
  for (let i = 0; i < nEvents; i++) {
    const dur = rng.pick([30, 45, 60, 90]);
    const start = cursor + rng.int(1, 8) * 30;
    if (start + dur > at(19)) break;
    items.push({ id: `ev${i}`, kind: 'event', duration: dur, start, priority: rng.pick([2, 3, 4, 5]) as 2 | 3 | 4 | 5, critical: rng.next() < 0.3 });
    cursor = start + dur;
  }
  const nTasks = rng.int(2, opts.maxTasks ?? 6);
  for (let i = 0; i < nTasks; i++) {
    const dur = rng.pick([20, 30, 45, 60, 90]);
    const it: Partial<PlanItem> & { id: string; duration: number } = { id: `t${i}`, kind: 'task', duration: dur, priority: rng.pick([1, 2, 3, 4, 5]) as 1 | 2 | 3 | 4 | 5 };
    if (rng.next() < 0.5) it.deadline = at(rng.int(12, 21), rng.pick([0, 30]));
    if (rng.next() < 0.2) it.release = at(rng.int(8, 12));
    items.push(it);
  }
  const plan = mkPlan(items, settings({ from: at(8), to: at(22), hours: ['08:00', '22:00'], mobility: opts.mobility ?? 'balanced' }));
  const base = buildBaseline(plan);
  if (base.unscheduled.length) return null;
  return base.plan;
}
