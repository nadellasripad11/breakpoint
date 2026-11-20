import type { Preferences } from '../engine/index.ts';
import type { StoredItem } from '../calendar/expand.ts';
import type { Connection, Schedule, User } from './types.ts';

/** Row <-> object mapping shared by every SQL store (SQLite on Node, D1 on Cloudflare Workers). */
export type Row = Record<string, unknown>;
export const b = (v: unknown): boolean => v === 1 || v === true;
export const nb = (v: unknown): boolean | null => (v === null || v === undefined ? null : b(v));
export const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const n = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

export function userFrom(r: Row): User {
  return { id: String(r.id), email: s(r.email), name: s(r.name), picture: s(r.picture), googleSub: s(r.google_sub), isGuest: b(r.is_guest), createdAt: String(r.created_at), lastSeenAt: String(r.last_seen_at) };
}
export function connFrom(r: Row): Connection {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    provider: r.provider as 'google' | 'notion',
    accountLabel: s(r.account_label),
    scopes: JSON.parse(String(r.scopes)) as string[],
    accessTokenEnc: s(r.access_token_enc),
    refreshTokenEnc: s(r.refresh_token_enc),
    tokenExpiresAt: s(r.token_expires_at),
    consentAt: String(r.consent_at),
    createdAt: String(r.created_at),
  };
}
export function schedFrom(r: Row): Schedule {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    name: String(r.name),
    timezone: String(r.timezone),
    preferences: JSON.parse(String(r.preferences)) as Preferences,
    sourceScheduleId: s(r.source_schedule_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
export function itemFrom(r: Row): StoredItem {
  const rrule = s(r.rrule);
  return {
    id: String(r.id),
    kind: r.kind as StoredItem['kind'],
    title: String(r.title),
    start: s(r.start_at),
    durationMin: Number(r.duration_min),
    allDay: b(r.all_day),
    timezone: String(r.timezone),
    locked: nb(r.locked),
    priority: (r.priority === null || r.priority === undefined ? null : Number(r.priority)) as StoredItem['priority'],
    category: s(r.category),
    deadline: s(r.deadline_at),
    release: s(r.release_at),
    deferrable: nb(r.is_deferrable),
    critical: nb(r.critical),
    blocking: b(r.blocking),
    recurrence: rrule ? { rrule, exdates: JSON.parse(String(r.exdates ?? '[]')) as string[] } : null,
    source: r.source as StoredItem['source'],
    externalId: s(r.external_id),
  };
}

