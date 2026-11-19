import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Preferences } from '../engine/index.ts';
import type { StoredItem } from '../calendar/expand.ts';
import type { ImportedItem } from '../calendar/ics.ts';
import { LimitError } from './types.ts';
import type { Connection, ImportRecord, OAuthStateRow, RunRecord, Schedule, SessionRow, Store, UpsertResult, User } from './types.ts';

type Row = Record<string, unknown>;
const b = (v: unknown): boolean => v === 1 || v === true;
const nb = (v: unknown): boolean | null => (v === null || v === undefined ? null : b(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: boolean | null | undefined): number | null => (v === null || v === undefined ? null : v ? 1 : 0);

function userFrom(r: Row): User {
  return { id: String(r.id), email: s(r.email), name: s(r.name), picture: s(r.picture), googleSub: s(r.google_sub), isGuest: b(r.is_guest), createdAt: String(r.created_at), lastSeenAt: String(r.last_seen_at) };
}
function connFrom(r: Row): Connection {
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
function schedFrom(r: Row): Schedule {
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
function itemFrom(r: Row): StoredItem {
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

export class SqliteStore implements Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  }

  private all(sql: string, ...p: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private one(sql: string, ...p: SQLInputValue[]): Row | null {
    return (this.db.prepare(sql).get(...p) as Row | undefined) ?? null;
  }
  private run(sql: string, ...p: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...p).changes);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async migrate(): Promise<void> {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (this.one('SELECT 1 AS x FROM schema_migrations WHERE version = ?', f)) continue;
      this.tx(() => {
        this.db.exec(readFileSync(join(dir, f), 'utf8'));
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', f, new Date().toISOString());
      });
    }
  }
  async close(): Promise<void> {
    this.db.close();
  }

  /* users */
  async createUser(u: Omit<User, 'createdAt' | 'lastSeenAt'>): Promise<User> {
    const now = new Date().toISOString();
    this.run('INSERT INTO users (id, email, name, picture, google_sub, is_guest, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)', u.id, u.email, u.name, u.picture, u.googleSub, n(u.isGuest), now, now);
    return { ...u, createdAt: now, lastSeenAt: now };
  }
  async getUser(id: string) {
    const r = this.one('SELECT * FROM users WHERE id = ?', id);
    return r ? userFrom(r) : null;
  }
  async findUserByGoogleSub(sub: string) {
    const r = this.one('SELECT * FROM users WHERE google_sub = ?', sub);
    return r ? userFrom(r) : null;
  }
  async findUserByEmail(email: string) {
    const r = this.one('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
    return r ? userFrom(r) : null;
  }
  async updateUserProfile(id: string, p: { email?: string | null; name?: string | null; picture?: string | null; googleSub?: string | null; isGuest?: boolean }) {
    this.run(
      `UPDATE users SET email = COALESCE(?, email), name = COALESCE(?, name), picture = COALESCE(?, picture), google_sub = COALESCE(?, google_sub), is_guest = COALESCE(?, is_guest) WHERE id = ?`,
      p.email ?? null, p.name ?? null, p.picture ?? null, p.googleSub ?? null, p.isGuest === undefined ? null : n(p.isGuest), id,
    );
  }
  async touchUser(id: string, now: string) {
    this.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, id);
  }
  async deleteUser(id: string) {
    this.run('DELETE FROM audit_log WHERE user_id = ?', id);
    this.run('DELETE FROM users WHERE id = ?', id);
  }
  async purgeExpiredGuests(olderThanIso: string) {
    return this.run('DELETE FROM users WHERE is_guest = 1 AND last_seen_at < ?', olderThanIso);
  }

  /* sessions */
  async createSession(x: SessionRow) {
    this.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)', x.tokenHash, x.userId, x.createdAt, x.expiresAt, x.userAgent);
  }
  async getSession(tokenHash: string) {
    const r = this.one('SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
    if (!r) return null;
    const u = this.one('SELECT * FROM users WHERE id = ?', String(r.user_id));
    if (!u) return null;
    return { session: { tokenHash: String(r.token_hash), userId: String(r.user_id), createdAt: String(r.created_at), expiresAt: String(r.expires_at), userAgent: s(r.user_agent) }, user: userFrom(u) };
  }
  async deleteSession(tokenHash: string) {
    this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }
  async deleteUserSessions(userId: string) {
    this.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }
  async extendSession(tokenHash: string, expiresAt: string) {
    this.run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', expiresAt, tokenHash);
  }
  async purgeExpiredSessions(nowIso: string) {
    return this.run('DELETE FROM sessions WHERE expires_at < ?', nowIso);
  }

  /* oauth state */
  async saveOAuthState(x: OAuthStateRow) {
    this.run('INSERT INTO oauth_states (state_hash, purpose, code_verifier, nonce, user_id, redirect_path, expires_at) VALUES (?,?,?,?,?,?,?)', x.stateHash, x.purpose, x.codeVerifier, x.nonce, x.userId, x.redirectPath, x.expiresAt);
  }
  async consumeOAuthState(stateHash: string, nowIso: string) {
    return this.tx(() => {
      const r = this.one('SELECT * FROM oauth_states WHERE state_hash = ?', stateHash);
      if (!r) return null;
      this.run('DELETE FROM oauth_states WHERE state_hash = ?', stateHash);
      if (String(r.expires_at) < nowIso) return null;
      return { stateHash: String(r.state_hash), purpose: r.purpose as OAuthStateRow['purpose'], codeVerifier: String(r.code_verifier), nonce: s(r.nonce), userId: s(r.user_id), redirectPath: String(r.redirect_path), expiresAt: String(r.expires_at) };
    });
  }
  async purgeExpiredOAuthStates(nowIso: string) {
    this.run('DELETE FROM login_codes WHERE expires_at < ?', nowIso);
    return this.run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso);
  }
  async saveLoginCode(codeHash: string, userId: string, expiresAt: string) {
    this.run('INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES (?,?,?)', codeHash, userId, expiresAt);
  }
  async consumeLoginCode(codeHash: string, nowIso: string) {
    return this.tx(() => {
      const r = this.one('SELECT user_id, expires_at FROM login_codes WHERE code_hash = ?', codeHash);
      if (!r) return null;
      this.run('DELETE FROM login_codes WHERE code_hash = ?', codeHash);
      return String(r.expires_at) < nowIso ? null : String(r.user_id);
    });
  }

  /* connections */
  async createConnection(c: Connection) {
    this.run('INSERT INTO connections (id, user_id, provider, account_label, scopes, access_token_enc, refresh_token_enc, token_expires_at, consent_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', c.id, c.userId, c.provider, c.accountLabel, JSON.stringify(c.scopes), c.accessTokenEnc, c.refreshTokenEnc, c.tokenExpiresAt, c.consentAt, c.createdAt);
  }
  async listConnections(userId: string) {
    return this.all('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at', userId).map(connFrom);
  }
  async getConnection(userId: string, id: string) {
    const r = this.one('SELECT * FROM connections WHERE id = ? AND user_id = ?', id, userId);
    return r ? connFrom(r) : null;
  }
  async updateConnectionTokens(id: string, t: { accessTokenEnc: string | null; refreshTokenEnc?: string | null; tokenExpiresAt: string | null }) {
    if (t.refreshTokenEnc === undefined) this.run('UPDATE connections SET access_token_enc = ?, token_expires_at = ? WHERE id = ?', t.accessTokenEnc, t.tokenExpiresAt, id);
    else this.run('UPDATE connections SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ? WHERE id = ?', t.accessTokenEnc, t.refreshTokenEnc, t.tokenExpiresAt, id);
  }
  async deleteConnection(userId: string, id: string) {
    return this.run('DELETE FROM connections WHERE id = ? AND user_id = ?', id, userId) > 0;
  }

  /* schedules */
  async createSchedule(x: Schedule) {
    this.run('INSERT INTO schedules (id, user_id, name, timezone, preferences, source_schedule_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', x.id, x.userId, x.name, x.timezone, JSON.stringify(x.preferences), x.sourceScheduleId, x.createdAt, x.updatedAt);
  }
  async listSchedules(userId: string) {
    return this.all('SELECT s.*, (SELECT COUNT(*) FROM schedule_items i WHERE i.schedule_id = s.id) AS item_count FROM schedules s WHERE s.user_id = ? ORDER BY s.created_at', userId).map((r) => ({ ...schedFrom(r), itemCount: Number(r.item_count) }));
  }
  async getSchedule(userId: string, id: string) {
    const r = this.one('SELECT * FROM schedules WHERE id = ? AND user_id = ?', id, userId);
    return r ? schedFrom(r) : null;
  }
  async updateSchedule(userId: string, id: string, p: { name?: string; preferences?: Preferences; timezone?: string }, nowIso: string) {
    return (
      this.run('UPDATE schedules SET name = COALESCE(?, name), preferences = COALESCE(?, preferences), timezone = COALESCE(?, timezone), updated_at = ? WHERE id = ? AND user_id = ?', p.name ?? null, p.preferences ? JSON.stringify(p.preferences) : null, p.timezone ?? null, nowIso, id, userId) > 0
    );
  }
  async deleteSchedule(userId: string, id: string) {
    return this.run('DELETE FROM schedules WHERE id = ? AND user_id = ?', id, userId) > 0;
  }
  async countSchedules(userId: string) {
    return Number(this.one('SELECT COUNT(*) AS c FROM schedules WHERE user_id = ?', userId)!.c);
  }
  async moveSchedules(fromUserId: string, toUserId: string) {
    this.run('UPDATE runs SET user_id = ? WHERE user_id = ?', toUserId, fromUserId);
    this.run('UPDATE imports SET user_id = ? WHERE user_id = ?', toUserId, fromUserId);
    return this.run('UPDATE schedules SET user_id = ? WHERE user_id = ?', toUserId, fromUserId);
  }

  /* items */
  private insertItem(scheduleId: string, it: StoredItem, nowIso: string) {
    this.run(
      `INSERT INTO schedule_items (id, schedule_id, kind, title, start_at, duration_min, all_day, timezone, locked, priority, category, deadline_at, release_at, is_deferrable, critical, blocking, rrule, exdates, source, external_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      it.id, scheduleId, it.kind, it.title, it.start, Math.round(it.durationMin), n(it.allDay), it.timezone, n(it.locked), it.priority, it.category, it.deadline, it.release, n(it.deferrable), n(it.critical), n(it.blocking),
      it.recurrence?.rrule ?? null, JSON.stringify(it.recurrence?.exdates ?? []), it.source, it.externalId, nowIso, nowIso,
    );
  }
  private count(scheduleId: string): number {
    return Number(this.one('SELECT COUNT(*) AS c FROM schedule_items WHERE schedule_id = ?', scheduleId)!.c);
  }
  async listItems(scheduleId: string) {
    return this.all('SELECT * FROM schedule_items WHERE schedule_id = ? ORDER BY COALESCE(start_at, deadline_at, created_at), id', scheduleId).map(itemFrom);
  }
  async getItem(scheduleId: string, id: string) {
    const r = this.one('SELECT * FROM schedule_items WHERE schedule_id = ? AND id = ?', scheduleId, id);
    return r ? itemFrom(r) : null;
  }
  async insertItems(scheduleId: string, items: StoredItem[], nowIso: string, maxItems: number) {
    this.tx(() => {
      if (this.count(scheduleId) + items.length > maxItems) throw new LimitError(`A schedule can hold at most ${maxItems} items.`);
      for (const it of items) this.insertItem(scheduleId, it, nowIso);
    });
  }
  async updateItem(scheduleId: string, id: string, it: StoredItem, nowIso: string) {
    return (
      this.run(
        `UPDATE schedule_items SET kind=?, title=?, start_at=?, duration_min=?, all_day=?, timezone=?, locked=?, priority=?, category=?, deadline_at=?, release_at=?, is_deferrable=?, critical=?, blocking=?, rrule=?, exdates=?, updated_at=? WHERE schedule_id=? AND id=?`,
        it.kind, it.title, it.start, Math.round(it.durationMin), n(it.allDay), it.timezone, n(it.locked), it.priority, it.category, it.deadline, it.release, n(it.deferrable), n(it.critical), n(it.blocking), it.recurrence?.rrule ?? null, JSON.stringify(it.recurrence?.exdates ?? []), nowIso, scheduleId, id,
      ) > 0
    );
  }
  async deleteItem(scheduleId: string, id: string) {
    return this.run('DELETE FROM schedule_items WHERE schedule_id = ? AND id = ?', scheduleId, id) > 0;
  }

  async upsertImported(scheduleId: string, source: 'ics' | 'google' | 'notion', items: ImportedItem[], nowIso: string, maxItems: number, newId: () => string): Promise<UpsertResult> {
    return this.tx(() => {
      const existing = new Map(this.all('SELECT id, title, external_id FROM schedule_items WHERE schedule_id = ? AND source = ? AND external_id IS NOT NULL', scheduleId, source).map((r) => [String(r.external_id), { id: String(r.id), title: String(r.title) }]));
      const incoming = new Set(items.map((i) => i.externalId));
      const fresh = items.filter((i) => !existing.has(i.externalId)).length;
      if (this.count(scheduleId) + fresh > maxItems) throw new LimitError(`A schedule can hold at most ${maxItems} items.`);
      let created = 0;
      let updated = 0;
      for (const i of items) {
        const have = existing.get(i.externalId);
        const rrule = i.recurrence?.rrule ?? null;
        const exdates = JSON.stringify(i.recurrence?.exdates ?? []);
        if (have) {
          // refresh what the SOURCE owns; never overwrite what the user decided (locked, priority, category, deferrable, critical)
          this.run('UPDATE schedule_items SET title=?, start_at=?, duration_min=?, all_day=?, timezone=?, deadline_at=?, release_at=?, blocking=?, rrule=?, exdates=?, updated_at=? WHERE id=?', i.title, i.start, Math.max(1, Math.round(i.durationMin)), n(i.allDay), i.timezone, i.deadline ?? null, i.release ?? null, n(i.blocking), rrule, exdates, nowIso, have.id);
          updated++;
        } else {
          this.run(
            `INSERT INTO schedule_items (id, schedule_id, kind, title, start_at, duration_min, all_day, timezone, locked, priority, category, deadline_at, release_at, is_deferrable, critical, blocking, rrule, exdates, source, external_id, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?)`,
            newId(), scheduleId, i.kind, i.title, i.start, Math.max(1, Math.round(i.durationMin)), n(i.allDay), i.timezone, i.priority ?? null, i.category ?? null, i.deadline ?? null, i.release ?? null, n(i.blocking), rrule, exdates, source, i.externalId, nowIso, nowIso,
          );
          created++;
        }
      }
      const missing = [...existing.entries()].filter(([ext]) => !incoming.has(ext)).map(([, v]) => v);
      return { created, updated, missing };
    });
  }

  /* runs, imports, audit */
  async saveRun(r: RunRecord, keep: number) {
    this.tx(() => {
      this.run('INSERT INTO runs (id, schedule_id, user_id, kind, request, result, created_at) VALUES (?,?,?,?,?,?,?)', r.id, r.scheduleId, r.userId, r.kind, JSON.stringify(r.request), JSON.stringify(r.result), r.createdAt);
      this.run('DELETE FROM runs WHERE schedule_id = ? AND id NOT IN (SELECT id FROM runs WHERE schedule_id = ? ORDER BY created_at DESC, id LIMIT ?)', r.scheduleId, r.scheduleId, keep);
    });
  }
  async listRuns(userId: string, scheduleId: string, limit: number) {
    return this.all('SELECT id, schedule_id, user_id, kind, created_at FROM runs WHERE user_id = ? AND schedule_id = ? ORDER BY created_at DESC LIMIT ?', userId, scheduleId, limit).map((r) => ({
      id: String(r.id), scheduleId: String(r.schedule_id), userId: String(r.user_id), kind: r.kind as RunRecord['kind'], createdAt: String(r.created_at),
    }));
  }
  async getRun(userId: string, id: string) {
    const r = this.one('SELECT * FROM runs WHERE id = ? AND user_id = ?', id, userId);
    return r ? { id: String(r.id), scheduleId: String(r.schedule_id), userId: String(r.user_id), kind: r.kind as RunRecord['kind'], request: JSON.parse(String(r.request)) as unknown, result: JSON.parse(String(r.result)) as unknown, createdAt: String(r.created_at) } : null;
  }
  async recordImport(r: ImportRecord) {
    this.run('INSERT INTO imports (id, schedule_id, user_id, source, connection_id, consent_at, created_count, updated_count, missing_count, warnings, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', r.id, r.scheduleId, r.userId, r.source, r.connectionId, r.consentAt, r.createdCount, r.updatedCount, r.missingCount, JSON.stringify(r.warnings), r.createdAt);
  }
  async audit(userId: string | null, action: string, detail: Record<string, unknown>, id: string, nowIso: string) {
    this.run('INSERT INTO audit_log (id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)', id, userId, action, JSON.stringify(detail), nowIso);
  }
}
