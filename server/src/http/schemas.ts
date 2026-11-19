import { z } from 'zod';
import { isValidTimeZone, parseHHMM } from '../engine/index.ts';

/* ───────────── primitives ───────────── */

export const isoDateTime = z
  .string()
  .max(40)
  .refine((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)), 'Use ISO-8601 with a timezone offset, e.g. 2026-11-20T17:00:00-06:00');

export const timezone = z.string().max(64).refine(isValidTimeZone, 'Unknown IANA timezone (e.g. America/Chicago)');
export const priority = z.literal([1, 2, 3, 4, 5]);
const hhmm = z.string().refine((s) => {
  try {
    parseHHMM(s);
    return true;
  } catch {
    return false;
  }
}, 'Use HH:MM (24h)');
const weekdays = z.array(z.number().int().min(0).max(6)).max(7).refine((a) => new Set(a).size === a.length, 'Duplicate weekday');
const title = z.string().trim().min(1).max(200);
export const uuid = z.string().uuid();

/* ───────────── preferences ───────────── */

export const preferencesSchema = z
  .object({
    timezone: timezone.optional(),
    workingHours: z.object({ start: hhmm, end: hhmm, days: weekdays.optional() }).strict().optional(),
    protectedBreaks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
            title,
            durationMin: z.number().int().min(5).max(240),
            windowStart: hhmm,
            windowEnd: hhmm,
            days: weekdays.optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    /** onboarding "What matters most?": { school: 5, fitness: 4, ... } */
    categoryPriority: z.record(z.string().trim().min(1).max(60), priority).refine((o) => Object.keys(o).length <= 30, 'At most 30 categories').optional(),
    /** onboarding "How flexible is your schedule?": fixed | balanced | flexible */
    mobility: z.enum(['fixed', 'balanced', 'flexible']).optional(),
    criticalPriority: priority.optional(),
  })
  .strict();
export type PreferencesInput = z.infer<typeof preferencesSchema>;

/* ───────────── items ───────────── */

const recurrence = z.object({ rrule: z.string().min(5).max(400), exdates: z.array(isoDateTime).max(400).default([]) }).strict();

const itemFields = {
  kind: z.enum(['event', 'task', 'break']),
  title,
  start: isoDateTime.nullish(),
  durationMin: z.number().int().min(1).max(20160),
  allDay: z.boolean().optional(),
  timezone: timezone.optional(),
  locked: z.boolean().nullish(),
  priority: priority.nullish(),
  category: z.string().trim().min(1).max(60).nullish(),
  deadline: isoDateTime.nullish(),
  release: isoDateTime.nullish(),
  deferrable: z.boolean().nullish(),
  critical: z.boolean().nullish(),
  blocking: z.boolean().optional(),
  recurrence: recurrence.nullish(),
};

export const itemCreateSchema = z
  .object(itemFields)
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'event' && !v.start) ctx.addIssue({ code: 'custom', path: ['start'], message: 'Events need a start time.' });
    if (v.kind === 'break' && !v.start && !(v.release && v.deadline)) ctx.addIssue({ code: 'custom', path: ['start'], message: 'Breaks need a start time, or a release + deadline window.' });
    if (v.recurrence && !v.start) ctx.addIssue({ code: 'custom', path: ['recurrence'], message: 'Recurring items need a start time.' });
    if (v.release && v.deadline && Date.parse(v.release) >= Date.parse(v.deadline)) ctx.addIssue({ code: 'custom', path: ['deadline'], message: 'The deadline must be after the earliest start.' });
  });
export type ItemCreate = z.infer<typeof itemCreateSchema>;

export const itemPatchSchema = z.object(Object.fromEntries(Object.entries(itemFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof itemFields]: z.ZodOptional<(typeof itemFields)[K]> }).strict();
export type ItemPatch = z.infer<typeof itemPatchSchema>;

export const itemsBody = z.union([itemCreateSchema, z.array(itemCreateSchema).min(1).max(200)]);

export const inlineItemSchema = z
  .object({ id: z.string().regex(/^[A-Za-z0-9_.:@-]{1,64}$/), ...itemFields })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'event' && !v.start) ctx.addIssue({ code: 'custom', path: ['start'], message: 'Events need a start time.' });
  });

export const inlineScheduleSchema = z
  .object({
    preferences: preferencesSchema.optional(),
    items: z.array(inlineItemSchema).max(300),
  })
  .strict();

/* ───────────── schedules ───────────── */

export const scheduleCreateSchema = z.object({ name: z.string().trim().min(1).max(100), preferences: preferencesSchema.optional(), timezone: timezone.optional() }).strict();
export const schedulePatchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), preferences: preferencesSchema.optional(), timezone: timezone.optional() }).strict();

/* ───────────── engine requests ───────────── */

/** Either a local calendar day (in the schedule's timezone) or an explicit instant range. */
export const windowSchema = z.union([
  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ from: isoDateTime, to: isoDateTime }),
]);

const minutes = z.number().int().min(1).max(10080);
export const disruptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delay'), targetId: z.string().max(100), minutes }).strict(),
  z.object({ type: z.literal('overrun'), targetId: z.string().max(100), minutes }).strict(),
  z.object({ type: z.literal('unexpected'), start: isoDateTime, minutes, title: z.string().trim().max(100).optional(), priority: priority.optional() }).strict(),
  z.object({ type: z.literal('lost_time'), minutes, start: isoDateTime.optional() }).strict(),
]);
export type DisruptionInput = z.infer<typeof disruptionSchema>;

export const probeSchema = z
  .object({ type: z.enum(['delay', 'overrun', 'lost_time', 'unexpected']), targetId: z.string().max(100).optional(), at: isoDateTime.optional() })
  .strict();

const save = z.boolean().optional();
const severity = z.enum(['mild', 'realistic', 'severe']);

export const simulateBody = z.object({ window: windowSchema, disruptions: z.array(disruptionSchema).min(1).max(20), save }).strict();
export const chaosBody = z.object({ window: windowSchema, scenarios: z.number().int().min(1).max(2000).optional(), seed: z.number().int().min(0).max(4294967295).optional(), severity: severity.optional(), examples: z.number().int().min(0).max(10).optional(), save }).strict();
export const breakingPointBody = z
  .object({ window: windowSchema, probe: probeSchema.optional(), mode: z.enum(['cascade', 'recover', 'both']).optional(), limitMinutes: z.number().int().min(1).max(1440).optional(), weakLinks: z.boolean().optional(), save })
  .strict();
export const futuresBody = z.object({ window: windowSchema, disruptions: z.array(disruptionSchema).max(20).optional(), save }).strict();
export const fortifyBody = z
  .object({ window: windowSchema, maxChanges: z.number().int().min(1).max(8).optional(), maxShiftMinutes: z.number().int().min(5).max(180).optional(), scenarios: z.number().int().min(20).max(400).optional(), seed: z.number().int().min(0).max(4294967295).optional(), severity: severity.optional(), save })
  .strict();
export const planBody = z.object({ window: windowSchema }).strict();

export const adoptBody = z
  .object({
    window: windowSchema,
    name: z.string().trim().min(1).max(100).optional(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('future'), strategy: z.enum(['protect_priorities', 'maximize_completion', 'minimize_changes']), disruptions: z.array(disruptionSchema).max(20).optional() }).strict(),
      z.object({ kind: z.literal('fortify'), maxChanges: z.number().int().min(1).max(8).optional(), maxShiftMinutes: z.number().int().min(5).max(180).optional() }).strict(),
    ]),
    /** the user must explicitly confirm; and name any task that will be deferred */
    confirm: z.literal(true),
    acceptDeferrals: z.array(z.string().max(120)).max(100).optional(),
  })
  .strict();

/** The stateless (guest demo) endpoints take the schedule inline. */
export const statelessWrap = <T extends z.ZodRawShape>(shape: z.ZodObject<T>) => shape.extend({ schedule: inlineScheduleSchema });

/* ───────────── imports + connections ───────────── */

export const icsImportBody = z
  .object({
    ics: z.string().min(20).max(2 * 1024 * 1024),
    defaultTimezone: timezone.optional(),
    allDayBlocks: z.boolean().optional(),
    defaultTaskMinutes: z.number().int().min(5).max(1440).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const googleImportBody = z
  .object({ connectionId: uuid, calendarId: z.string().min(1).max(300), from: isoDateTime, to: isoDateTime, confirm: z.literal(true), dryRun: z.boolean().optional() })
  .strict();

export const notionImportBody = z
  .object({
    connectionId: uuid,
    databaseId: z.string().min(32).max(40),
    mapping: z
      .object({
        title: z.string().max(100).optional(),
        date: z.string().max(100).optional(),
        duration: z.string().max(100).optional(),
        priority: z.string().max(100).optional(),
        category: z.string().max(100).optional(),
        status: z.string().max(100).optional(),
        doneValues: z.array(z.string().max(60)).max(10).optional(),
        defaultMinutes: z.number().int().min(5).max(1440).optional(),
      })
      .strict()
      .default({}),
    confirm: z.literal(true),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const googleConnectBody = z.object({ acknowledge: z.literal(true), scopes: z.tuple([z.literal('https://www.googleapis.com/auth/calendar.readonly')]), redirect: z.string().max(200).optional() }).strict();
export const notionConnectBody = z.object({ acknowledge: z.literal(true), token: z.string().min(20).max(300) }).strict();
export const deleteAccountBody = z.object({ confirm: z.literal('delete my account') }).strict();
