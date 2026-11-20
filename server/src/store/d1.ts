import type { Preferences } from '../engine/index.ts';
import type { StoredItem } from '../calendar/expand.ts';
import type { ImportedItem } from '../calendar/ics.ts';
import { LimitError } from './types.ts';
import type { Connection, ImportRecord, OAuthStateRow, RunRecord, Schedule, SessionRow, Store, UpsertResult, User } from './types.ts';
import { connFrom, itemFrom, n, s, schedFrom, userFrom } from './rows.ts';
import type { Row } from './rows.ts';

/**
 * The same Store as SqliteStore, on Cloudflare D1 (SQLite in the cloud), so the whole API can run on Workers.
 *
 * What differs from the Node store, and why:
 *  - D1 has no interactive transactions, so multi-step changes use `batch()` (atomic) and single-use tokens use
 *    `DELETE ... RETURNING`, which is atomic and so makes "consume once" even stronger than before.
 *  - D1 limits how many queries one request may run (50 on the free plan). Bulk writes therefore insert and update
 *    from ONE JSON parameter (`json_each`) instead of one statement per row: importing 500 events is 3 queries, not 500.
 *  - Migrations are applied by `wrangler d1 migrations apply`, not at startup.
 */

/** The small slice of Cloudflare's D1 API this store uses (so we do not need the Workers type packages). */
export interface D1Statement {
  bind(...params: unknown[]): D1Statement;
  all(): Promise<{ results: Row[] }>;
  first(): Promise<Row | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<{ meta: { changes: number } }[]>;
}

const ITEM_COLS = 'id, schedule_id, kind, title, start_at, duration_min, all_day, timezone, locked, priority, category, deadline_at, release_at, is_deferrable, critical, blocking, rrule, exdates, source, external_id, created_at, updated_at';
const J = (k: string) => `json_extract(value, '$.${k}')`;
const BULK_INSERT = `INSERT INTO schedule_items (${ITEM_COLS}) SELECT ${ITEM_COLS.split(', ').map(J).join(', ')} FROM json_each(?)`;
const BULK_UPDATE = `UPDATE schedule_items SET title = j.title, start_at = j.start_at, duration_min = j.duration_min, all_day = j.all_day, timezone = j.timezone, deadline_at = j.deadline_at, release_at = j.release_at, blocking = j.blocking, rrule = j.rrule, exdates = j.exdates, updated_at = j.updated_at
  FROM (SELECT ${['id', 'title', 'start_at', 'duration_min', 'all_day', 'timezone', 'deadline_at', 'release_at', 'blocking', 'rrule', 'exdates', 'updated_at'].map((k) => `${J(k)} AS ${k}`).join(', ')} FROM json_each(?)) AS j
  WHERE schedule_items.id = j.id AND schedule_items.schedule_id = ?`;

const rowJson = (scheduleId: string, it: StoredItem, nowIso: string) => ({
  id: it.id, schedule_id: scheduleId, kind: it.kind, title: it.title, start_at: it.start, duration_min: Math.max(1, Math.round(it.durationMin)), all_day: n(it.allDay), timezone: it.timezone,
  locked: n(it.locked), priority: it.priority, category: it.category, deadline_at: it.deadline, release_at: it.release, is_deferrable: n(it.deferrable), critical: n(it.critical), blocking: n(it.blocking),
  rrule: it.recurrence?.rrule ?? null, exdates: JSON.stringify(it.recurrence?.exdates ?? []), source: it.source, external_id: it.externalId, created_at: nowIso, updated_at: nowIso,
});

export class D1Store implements Store {
  private readonly d1: D1Like;
  constructor(d1: D1Like) {
    this.d1 = d1;
  }

  private stmt(sql: string, p: unknown[]): D1Statement {
    return this.d1.prepare(sql).bind(...p.map((v) => (v === undefined ? null : v)));
  }
  private async all(sql: string, ...p: unknown[]): Promise<Row[]> {
    return (await this.stmt(sql, p).all()).results;
  }
  private async one(sql: string, ...p: unknown[]): Promise<Row | null> {
    return (await this.stmt(sql, p).first()) ?? null;
  }
  private async run(sql: string, ...p: unknown[]): Promise<number> {
    return Number((await this.stmt(sql, p).run()).meta.changes);
  }

  /** Migrations are applied with `wrangler d1 migrations apply`. */
  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  /* users */
  async createUser(u: Omit<User, 'createdAt' | 'lastSeenAt'>): Promise<User> {
    const now = new Date().toISOString();
    await this.run('INSERT INTO users (id, email, name, picture, google_sub, is_guest, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)', u.id, u.email, u.name, u.picture, u.googleSub, n(u.isGuest), now, now);
    return { ...u, createdAt: now, lastSeenAt: now };
  }
  async getUser(id: string) {
    const r = await this.one('SELECT * FROM users WHERE id = ?', id);
    return r ? userFrom(r) : null;
  }
  async findUserByGoogleSub(sub: string) {
    const r = await this.one('SELECT * FROM users WHERE google_sub = ?', sub);
    return r ? userFrom(r) : null;
  }
  async findUserByEmail(email: string) {
    const r = await this.one('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
    return r ? userFrom(r) : null;
  }
  async updateUserProfile(id: string, p: { email?: string | null; name?: string | null; picture?: string | null; googleSub?: string | null; isGuest?: boolean }) {
    await this.run(
      `UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), picture = COALESCE(?, picture), google_sub = COALESCE(?, google_sub), is_guest = COALESCE(?, is_guest) WHERE id = ?`,
      p.email ?? null, p.name ?? null, p.picture ?? null, p.googleSub ?? null, p.isGuest === undefined ? null : n(p.isGuest), id,
    );
  }
  async touchUser(id: string, now: string) {
    await this.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, id);
  }
  async deleteUser(id: string) {
    await this.d1.batch([this.stmt('DELETE FROM audit_log WHERE user_id = ?', [id]), this.stmt('DELETE FROM users WHERE id = ?', [id])]);
  }
  async purgeExpiredGuests(olderThanIso: string) {
    return this.run('DELETE FROM users WHERE is_guest = 1 AND last_seen_at < ?', olderThanIso);
  }

  /* sessions */
  async createSession(x: SessionRow) {
    await this.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)', x.tokenHash, x.userId, x.createdAt, x.expiresAt, x.userAgent);
  }
  async getSession(tokenHash: string) {
    const r = await this.one('SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
    if (!r) return null;
    const u = await this.one('SELECT * FROM users WHERE id = ?', String(r.user_id));
    if (!u) return null;
    return { session: { tokenHash: String(r.token_hash), userId: String(r.user_id), createdAt: String(r.created_at), expiresAt: String(r.expires_at), userAgent: s(r.user_agent) }, user: userFrom(u) };
  }
  async deleteSession(tokenHash: string) {
    await this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }
  async deleteUserSessions(userId: string) {
    await this.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }
  async extendSession(tokenHash: string, expiresAt: string) {
    await this.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', expiresAt, tokenHash);
  }
  async purgeExpiredSessions(nowIso: string) {
    return this.run('DELETE FROM sessions WHERE expires_at < ?', nowIso);
  }

  /* oauth state + login codes: consumed with an atomic DELETE ... RETURNING, so a value can be used exactly once */
  async saveOAuthState(x: OAuthStateRow) {
    await this.run('INSERT INTO oauth_states (state_hash, purpose, code_verifier, nonce, user_id, redirect_path, expires_at) VALUES (?,?,?,?,?,?,?)', x.stateHash, x.purpose, x.codeVerifier, x.nonce, x.userId, x.redirectPath, x.expiresAt);
  }
  async consumeOAuthState(stateHash: string, nowIso: string) {
    const r = await this.one('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *', stateHash);
    if (!r || String(r.expires_at) < nowIso) return null;
    return { stateHash: String(r.state_hash), purpose: r.purpose as OAuthStateRow['purpose'], codeVerifier: String(r.code_verifier), nonce: s(r.nonce), userId: s(r.user_id), redirectPath: String(r.redirect_path), expiresAt: String(r.expires_at) };
  }
  async purgeExpiredOAuthStates(nowIso: string) {
    await this.run('DELETE FROM login_codes WHERE expires_at < ?', nowIso);
    return this.run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso);
  }
  async saveLoginCode(codeHash: string, userId: string, expiresAt: string) {
    await this.run('INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES (?,?,?)', codeHash, userId, expiresAt);
  }
  async consumeLoginCode(codeHash: string, nowIso: string) {
    const r = await this.one('DELETE FROM login_codes WHERE code_hash = ? RETURNING user_id, expires_at', codeHash);
    if (!r) return null;
    return String(r.expires_at) < nowIso ? null : String(r.user_id);
  }

  /* connections */
  async createConnection(c: Connection) {
    await this.run('INSERT INTO connections (id, user_id, provider, account_label, scopes, access_token_enc, refresh_token_enc, token_expires_at, consent_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', c.id, c.userId, c.provider, c.accountLabel, JSON.stringify(c.scopes), c.accessTokenEnc, c.refreshTokenEnc, c.tokenExpiresAt, c.consentAt, c.createdAt);
  }
  async listConnections(userId: string) {
    return (await this.all('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at', userId)).map(connFrom);
  }
  async getConnection(userId: string, id: string) {
    const r = await this.one('SELECT * FROM connections WHERE id = ? AND user_id = ?', id, userId);
    return r ? connFrom(r) : null;
  }
  async updateConnectionTokens(id: string, t: { accessTokenEnc: string | null; refreshTokenEnc?: string | null; tokenExpiresAt: string | null }) {
    if (t.refreshTokenEnc === undefined) await this.run('UPDATE connections SET access_token_enc = ?, token_expires_at = ? WHERE id = ?', t.accessTokenEnc, t.tokenExpiresAt, id);
    else await this.run('UPDATE connections SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ? WHERE id = ?', t.accessTokenEnc, t.refreshTokenEnc, t.tokenExpiresAt, id);
  }
  async deleteConnection(userId: string, id: string) {
    return (await this.run('DELETE FROM connections WHERE id = ? AND user_id = ?', id, userId)) > 0;
  }

  /* schedules */
  async createSchedule(x: Schedule) {
    await this.run('INSERT INTO schedules (id, user_id, name, timezone, preferences, source_schedule_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', x.id, x.userId, x.name, x.timezone, JSON.stringify(x.preferences), x.sourceScheduleId, x.createdAt, x.updatedAt);
  }
  async listSchedules(userId: string) {
    return (await this.all('SELECT s.*, (SELECT COUNT(*) FROM schedule_items i WHERE i.schedule_id = s.id) AS item_count FROM schedules s WHERE s.user_id = ? ORDER BY s.created_at', userId)).map((r) => ({ ...schedFrom(r), itemCount: Number(r.item_count) }));
  }
  async getSchedule(userId: string, id: string) {
    const r = await this.one('SELECT * FROM schedules WHERE id = ? AND user_id = ?', id, userId);
    return r ? schedFrom(r) : null;
  }
  async updateSchedule(userId: string, id: string, p: { name?: string; preferences?: Preferences; timezone?: string }, nowIso: string) {
    return (await this.run('UPDATE schedules SET name = COALESCE(?, name), preferences = COALESCE(?, preferences), timezone = COALESCE(?, timezone), updated_at = ? WHERE id = ? AND user_id = ?', p.name ?? null, p.preferences ? JSON.stringify(p.preferences) : null, p.timezone ?? null, nowIso, id, userId)) > 0;
  }
  async deleteSchedule(userId: string, id: string) {
    return (await this.run('DELETE FROM schedules WHERE id = ? AND user_id = ?', id, userId)) > 0;
  }
  async countSchedules(userId: string) {
    return Number((await this.one('SELECT COUNT(*) AS c FROM schedules WHERE user_id = ?', userId))!.c);
  }
  async moveSchedules(fromUserId: string, toUserId: string) {
    const res = await this.d1.batch([
      this.stmt('UPDATE runs SET user_id = ? WHERE user_id = ?', [toUserId, fromUserId]),
      this.stmt('UPDATE imports SET user_id = ? WHERE user_id = ?', [toUserId, fromUserId]),
      this.stmt('UPDATE schedules SET user_id = ? WHERE user_id = ?', [toUserId, fromUserId]),
    ]);
    return Number(res[2]!.meta.changes);
  }

  /* items */
  private async count(scheduleId: string): Promise<number> {
    return Number((await this.one('SELECT COUNT(*) AS c FROM schedule_items WHERE schedule_id = ?', scheduleId))!.c);
  }
  async listItems(scheduleId: string) {
    return (await this.all('SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY COALESCE(start_at, deadline_at, created_at), id', scheduleId)).map(itemFrom);
  }
  async getItem(scheduleId: string, id: string) {
    const r = await this.one('SELECT * FROM schedule_items WHERE schedule_id = ? AND id = ?', scheduleId, id);
    return r ? itemFrom(r) : null;
  }
  async insertItems(scheduleId: string, items: StoredItem[], nowIso: string, maxItems: number) {
    if (items.length === 0) return;
    if ((await this.count(scheduleId)) + items.length > maxItems) throw new LimitError(`A schedule can hold at most ${maxItems} items.`);
    await this.run(BULK_INSERT, JSON.stringify(items.map((it) => rowJson(scheduleId, it, nowIso))));
  }
  async updateItem(scheduleId: string, id: string, it: StoredItem, nowIso: string) {
    return (
      (await this.run(
        `UPDATE schedule_items SET kind=?, title=?, start_at=?, duration_min=?, all_day=?, timezone=?, locked=?, priority=?, category=?, deadline_at=?, release_at=?, is_deferrable=?, critical=?, blocking=?, rrule=?, exdates=?, updated_at=? WHERE schedule_id=? AND id=?`,
        it.kind, it.title, it.start, Math.round(it.durationMin), n(it.allDay), it.timezone, n(it.locked), it.priority, it.category, it.deadline, it.release, n(it.deferrable), n(it.critical), n(it.blocking), it.recurrence?.rrule ?? null, JSON.stringify(it.recurrence?.exdates ?? []), nowIso, scheduleId, id,
      )) > 0
    );
  }
  async deleteItem(scheduleId: string, id: string) {
    return (await this.run('DELETE FROM schedule_items WHERE schedule_id = ? AND id = ?', scheduleId, id)) > 0;
  }

  async upsertImported(scheduleId: string, source: 'ics' | 'google' | 'notion', items: ImportedItem[], nowIso: string, maxItems: number, newId: () => string): Promise<UpsertResult> {
    const existing = new Map((await this.all('SELECT id, title, external_id FROM schedule_items WHERE schedule_id = ? AND source = ? AND external_id IS NOT NULL', scheduleId, source)).map((r) => [String(r.external_id), { id: String(r.id), title: String(r.title) }]));
    const incoming = new Set(items.map((i) => i.externalId));
    const fresh = items.filter((i) => !existing.has(i.externalId));
    if ((await this.count(scheduleId)) + fresh.length > maxItems) throw new LimitError(`A schedule can hold at most ${maxItems} items.`);
    const common = (i: ImportedItem) => ({ title: i.title, start_at: i.start, duration_min: Math.max(1, Math.round(i.durationMin)), all_day: n(i.allDay), timezone: i.timezone, deadline_at: i.deadline ?? null, release_at: i.release ?? null, blocking: n(i.blocking), rrule: i.recurrence?.rrule ?? null, exdates: JSON.stringify(i.recurrence?.exdates ?? []), updated_at: nowIso });
    const writes: D1Statement[] = [];
    const known = items.filter((i) => existing.has(i.externalId));
    // refresh what the SOURCE owns; never overwrite what the user decided (locked, priority, category, deferrable, critical)
    if (known.length) writes.push(this.stmt(BULK_UPDATE, [JSON.stringify(known.map((i) => ({ id: existing.get(i.externalId)!.id, ...common(i) }))), scheduleId]));
    if (fresh.length) {
      writes.push(
        this.stmt(BULK_INSERT, [
          JSON.stringify(fresh.map((i) => ({ id: newId(), schedule_id: scheduleId, kind: i.kind, ...common(i), locked: null, priority: i.priority ?? null, category: i.category ?? null, is_deferrable: null, critical: null, source, external_id: i.externalId, created_at: nowIso }))),
        ]),
      );
    }
    if (writes.length) await this.d1.batch(writes);
    const missing = [...existing.entries()].filter(([ext]) => !incoming.has(ext)).map(([, v]) => v);
    return { created: fresh.length, updated: known.length, missing };
  }

  /* runs, imports, audit */
  async saveRun(r: RunRecord, keep: number) {
    await this.d1.batch([
      this.stmt('INSERT INTO runs (id, schedule_id, user_id, kind, request, result, created_at) VALUES (?,?,?,?,?,?,?)', [r.id, r.scheduleId, r.userId, r.kind, JSON.stringify(r.request), JSON.stringify(r.result), r.createdAt]),
      this.stmt('DELETE FROM runs WHERE schedule_id = ? AND id NOT IN (SELECT id FROM runs WHERE schedule_id = ? ORDER BY created_at DESC, id LIMIT ?)', [r.scheduleId, r.scheduleId, keep]),
    ]);
  }
  async listRuns(userId: string, scheduleId: string, limit: number) {
    return (await this.all('SELECT id, schedule_id, user_id, kind, created_at FROM runs WHERE user_id = ? AND schedule_id = ? ORDER BY created_at DESC LIMIT ?', userId, scheduleId, limit)).map((r) => ({
      id: String(r.id), scheduleId: String(r.schedule_id), userId: String(r.user_id), kind: r.kind as RunRecord['kind'], createdAt: String(r.created_at),
    }));
  }
  async getRun(userId: string, id: string) {
    const r = await this.one('SELECT * FROM runs WHERE id = ? AND user_id = ?', id, userId);
    return r ? { id: String(r.id), scheduleId: String(r.schedule_id), userId: String(r.user_id), kind: r.kind as RunRecord['kind'], request: JSON.parse(String(r.request)) as unknown, result: JSON.parse(String(r.result)) as unknown, createdAt: String(r.created_at) } : null;
  }
  async recordImport(r: ImportRecord) {
    await this.run('INSERT INTO imports (id, schedule_id, user_id, source, connection_id, consent_at, created_count, updated_count, missing_count, warnings, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', r.id, r.scheduleId, r.userId, r.source, r.connectionId, r.consentAt, r.createdCount, r.updatedCount, r.missingCount, JSON.stringify(r.warnings), r.createdAt);
  }
  async audit(userId: string | null, action: string, detail: Record<string, unknown>, id: string, nowIso: string) {
    await this.run('INSERT INTO audit_log (id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)', id, userId, action, JSON.stringify(detail), nowIso);
  }
}
