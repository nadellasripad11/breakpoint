import type { Disruption, Interval, Plan, Priority } from './types.ts';
import { simulateCascade } from './cascade.ts';
import { describeDisruption } from './world.ts';
import { Rng, hashString } from './prng.ts';

/**
 * chaos engine: realistic disruptions drawn from a seeded random generator.
 * same plan + same seed + same severity = byte-identical scenarios and statistics.
 * (randomness only picks which disruptions to try; every outcome is computed by the deterministic cascade.)
 */

export type ChaosSeverity = 'mild' | 'realistic' | 'severe';
export const MAX_SCENARIOS = 2000;

interface Profile {
  counts: [number, number][];
  delays: number[];
  overrunFrac: [number, number];
  unexpected: [number, number];
  lost: [number, number];
}

const PROFILES: Record<ChaosSeverity, Profile> = {
  mild: { counts: [[1, 80], [2, 20]], delays: [5, 10, 15, 20], overrunFrac: [0.1, 0.3], unexpected: [15, 30], lost: [5, 20] },
  realistic: { counts: [[1, 55], [2, 33], [3, 12]], delays: [10, 15, 20, 30, 45, 60], overrunFrac: [0.2, 0.8], unexpected: [15, 75], lost: [10, 45] },
  severe: { counts: [[2, 40], [3, 40], [4, 20]], delays: [30, 45, 60, 90], overrunFrac: [0.5, 1.5], unexpected: [45, 120], lost: [30, 90] },
};

const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);

export function defaultSeed(plan: Plan): number {
  return hashString(plan.items.map((i) => `${i.id}@${i.start ?? '?'}+${i.duration}`).sort().join('|') + `|${plan.settings.horizon.start}`);
}

export function generateScenario(plan: Plan, rng: Rng, severity: ChaosSeverity): Disruption[] {
  const prof = PROFILES[severity];
  const blocking = plan.items.filter((i) => i.blocking && i.start !== undefined).sort((a, b) => a.id.localeCompare(b.id));
  if (blocking.length === 0) return [];
  const flexible = blocking.filter((i) => !i.locked);
  const count = rng.weighted(prof.counts);
  const out: Disruption[] = [];
  const windows: Interval[] = plan.settings.availability.length ? plan.settings.availability : [plan.settings.horizon];
  for (let k = 0; k < count; k++) {
    const kind = rng.weighted<'overrun' | 'delay' | 'lost_time' | 'unexpected'>([['overrun', 35], ['delay', 30], ['lost_time', 15], ['unexpected', 20]]);
    if (kind === 'overrun') {
      const pool = flexible.length ? flexible : blocking;
      const t = rng.pick(pool);
      const frac = prof.overrunFrac[0] + rng.next() * (prof.overrunFrac[1] - prof.overrunFrac[0]);
      out.push({ type: 'overrun', targetId: t.id, minutes: round5(t.duration * frac) });
    } else if (kind === 'delay') {
      out.push({ type: 'delay', targetId: rng.pick(blocking).id, minutes: rng.pick(prof.delays) });
    } else if (kind === 'lost_time') {
      out.push({ type: 'lost_time', minutes: round5(rng.int(prof.lost[0], prof.lost[1])) });
    } else {
      const total = windows.reduce((s, w) => s + (w.end - w.start), 0);
      let r = Math.floor(rng.next() * total);
      let start = windows[0]!.start;
      for (const w of windows) {
        const len = w.end - w.start;
        if (r < len) {
          start = w.start + r;
          break;
        }
        r -= len;
      }
      start = Math.round(start / 15) * 15;
      out.push({ type: 'unexpected', start, duration: round5(rng.int(prof.unexpected[0], prof.unexpected[1])), priority: 5 as Priority });
    }
  }
  return out;
}

export interface ChaosOptions {
  scenarios?: number;
  seed?: number;
  severity?: ChaosSeverity;
  /** how many example scenarios to include in the report */
  examples?: number;
}

export interface ChaosScenario {
  index: number;
  disruptions: Disruption[];
  descriptions: string[];
  survives: boolean;
  criticalCount: number;
  conflictCount: number;
  headline: string;
}

export interface ChaosReport {
  seed: number;
  severity: ChaosSeverity;
  scenarios: number;
  /** share of scenarios with no critical failure, 0..1 */
  survivalRate: number;
  resilienceScore: number;
  anyConflictRate: number;
  meanShiftedItems: number;
  byType: Record<string, { occurrences: number; survivalRate: number }>;
  /** items most often involved in critical failures */
  fragileItems: { itemId: string; title: string; criticalScenarios: number; share: number }[];
  worstScenarios: ChaosScenario[];
  summary: string;
}

export function runChaos(plan: Plan, opts: ChaosOptions = {}): ChaosReport {
  const scenarios = Math.max(1, Math.min(MAX_SCENARIOS, Math.floor(opts.scenarios ?? 200)));
  const severity = opts.severity ?? 'realistic';
  const seed = (opts.seed ?? defaultSeed(plan)) >>> 0;
  const rng = new Rng(seed);
  const titles = new Map(plan.items.map((i) => [i.id, i.title]));

  let survived = 0;
  let anyConflict = 0;
  let shiftedTotal = 0;
  const typeStats = new Map<string, { n: number; ok: number }>();
  const fragile = new Map<string, number>();
  const all: ChaosScenario[] = [];

  for (let s = 0; s < scenarios; s++) {
    const disruptions = generateScenario(plan, rng, severity);
    const sim = simulateCascade(plan, disruptions);
    if (sim.summary.survives) survived++;
    if (sim.summary.conflictCount > 0) anyConflict++;
    shiftedTotal += sim.summary.shiftedCount;
    for (const d of disruptions) {
      const t = typeStats.get(d.type) ?? { n: 0, ok: 0 };
      t.n++;
      if (sim.summary.survives) t.ok++;
      typeStats.set(d.type, t);
    }
    const seen = new Set<string>();
    for (const c of sim.conflicts) {
      if (c.severity !== 'critical') continue;
      const id = c.itemId.startsWith('disruption:') && c.otherId ? c.otherId : c.itemId;
      if (!seen.has(id)) {
        seen.add(id);
        fragile.set(id, (fragile.get(id) ?? 0) + 1);
      }
    }
    all.push({
      index: s,
      disruptions,
      descriptions: disruptions.map((d) => describeDisruption(d, plan)),
      survives: sim.summary.survives,
      criticalCount: sim.summary.criticalCount,
      conflictCount: sim.summary.conflictCount,
      headline: sim.summary.headline,
    });
  }

  const survivalRate = survived / scenarios;
  const byType: ChaosReport['byType'] = {};
  for (const [k, v] of [...typeStats.entries()].sort()) byType[k] = { occurrences: v.n, survivalRate: v.ok / v.n };
  const fragileItems = [...fragile.entries()]
    .map(([itemId, c]) => ({ itemId, title: titles.get(itemId) ?? itemId, criticalScenarios: c, share: c / scenarios }))
    .sort((a, b) => b.criticalScenarios - a.criticalScenarios || a.title.localeCompare(b.title) || a.itemId.localeCompare(b.itemId))
    .slice(0, 5);
  const worst = all
    .filter((x) => !x.survives)
    .sort((a, b) => b.criticalCount - a.criticalCount || b.conflictCount - a.conflictCount || a.index - b.index)
    .slice(0, Math.max(0, opts.examples ?? 3));

  const pct = Math.round(survivalRate * 100);
  const summary =
    fragileItems.length === 0
      ? `Your schedule survived all ${scenarios} simulated ${severity} disruptions without a critical conflict.`
      : `Your schedule survives ${pct}% of ${scenarios} simulated ${severity} disruptions. Most fragile: "${fragileItems[0]!.title}" (critical in ${Math.round(fragileItems[0]!.share * 100)}% of runs).`;
  return {
    seed,
    severity,
    scenarios,
    survivalRate,
    resilienceScore: pct,
    anyConflictRate: anyConflict / scenarios,
    meanShiftedItems: shiftedTotal / scenarios,
    byType,
    fragileItems,
    worstScenarios: worst,
    summary,
  };
}
