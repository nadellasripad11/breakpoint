import { minToZonedIso } from '../engine/index.ts';

/** keys whose numeric values are epoch-minutes instants. everything else (minutes, durations, counts) stays a number. */
const TIME_KEYS = new Set(['start', 'end', 'deadline', 'release', 'fromStart', 'toStart', 'firstConflictAt', 'at']);

/** convert engine output (epoch minutes) to iso-8601 strings with the schedule's utc offset. */
export function withIsoTimes(value: unknown, tz: string): unknown {
  if (Array.isArray(value)) return value.map((v) => withIsoTimes(v, tz));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = TIME_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v) ? minToZonedIso(v, tz) : withIsoTimes(v, tz);
    }
    return out;
  }
  return value;
}
