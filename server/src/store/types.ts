import type { Preferences } from '../engine/index.ts';
import type { StoredItem } from '../calendar/expand.ts';
import type { ImportedItem } from '../calendar/ics.ts';

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  googleSub: string | null;
  isGuest: boolean;
  createdAt: string;
  lastSeenAt: string;
}

export interface SessionRow {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
}

export interface OAuthStateRow {
  stateHash: string;
  purpose: 'login' | 'connect_google';
  codeVerifier: string;
  nonce: string | null;
  userId: string | null;
  redirectPath: string;
  expiresAt: string;
}

export interface Connection {
  id: string;
  userId: string;
  provider: 'google' | 'notion';
  accountLabel: string | null;
  scopes: string[];
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: string | null;
  consentAt: string;
  createdAt: string;
}

export interface Schedule {
  id: string;
  userId: string;
  name: string;
  timezone: string;
  preferences: Preferences;
  sourceScheduleId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunKind = 'simulate' | 'chaos' | 'breaking_point' | 'futures' | 'fortify';

export interface RunRecord {
  id: string;
  scheduleId: string;
  userId: string;
  kind: RunKind;
  request: unknown;
  result: unknown;
  createdAt: string;
}

export interface ImportRecord {
  id: string;
  scheduleId: string;
  userId: string;
  source: string;
  connectionId: string | null;
  consentAt: string;
  createdCount: number;
  updatedCount: number;
  missingCount: number;
  warnings: string[];
  createdAt: string;
}

export interface UpsertResult {
  created: number;
  updated: number;
  /** previously imported items that were not in this import. They are KEPT; the user decides. */
  missing: { id: string; title: string }[];
}

export class LimitError extends Error {
  readonly code = 'limit_exceeded';
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

/** Async so a Cloudflare D1 implementation can replace the SQLite one without touching callers. */
export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;

  createUser(u: Omit<User, 'createdAt' | 'lastSeenAt'>): Promise<User>;
  getUser(id: string): Promise<User | null>;
  findUserByGoogleSub(sub: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<User | null>;
  updateUserProfile(id: string, p: { email?: string | null; name?: string | null; picture?: string | null; googleSub?: string | null; isGuest?: boolean }): Promise<void>;
  touchUser(id: string, now: string): Promise<void>;
  /** Deletes the user and, by cascade, every schedule, item, connection, session and run they own. */
  deleteUser(id: string): Promise<void>;
  purgeExpiredGuests(olderThanIso: string): Promise<number>;

  createSession(s: SessionRow): Promise<void>;
  getSession(tokenHash: string): Promise<{ session: SessionRow; user: User } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteUserSessions(userId: string): Promise<void>;
  extendSession(tokenHash: string, expiresAt: string): Promise<void>;
  purgeExpiredSessions(nowIso: string): Promise<number>;

  saveOAuthState(s: OAuthStateRow): Promise<void>;
  /** Returns the state once and deletes it (single use). */
  consumeOAuthState(stateHash: string, nowIso: string): Promise<OAuthStateRow | null>;
  purgeExpiredOAuthStates(nowIso: string): Promise<number>;

  saveLoginCode(codeHash: string, userId: string, expiresAt: string): Promise<void>;
  /** Returns the user id once and deletes the code (single use). */
  consumeLoginCode(codeHash: string, nowIso: string): Promise<string | null>;

  createConnection(c: Connection): Promise<void>;
  listConnections(userId: string): Promise<Connection[]>;
  getConnection(userId: string, id: string): Promise<Connection | null>;
  updateConnectionTokens(id: string, t: { accessTokenEnc: string | null; refreshTokenEnc?: string | null; tokenExpiresAt: string | null }): Promise<void>;
  deleteConnection(userId: string, id: string): Promise<boolean>;

  createSchedule(s: Schedule): Promise<void>;
  listSchedules(userId: string): Promise<(Schedule & { itemCount: number })[]>;
  getSchedule(userId: string, id: string): Promise<Schedule | null>;
  updateSchedule(userId: string, id: string, p: { name?: string; preferences?: Preferences; timezone?: string }, nowIso: string): Promise<boolean>;
  deleteSchedule(userId: string, id: string): Promise<boolean>;
  countSchedules(userId: string): Promise<number>;
  moveSchedules(fromUserId: string, toUserId: string): Promise<number>;

  listItems(scheduleId: string): Promise<StoredItem[]>;
  getItem(scheduleId: string, id: string): Promise<StoredItem | null>;
  insertItems(scheduleId: string, items: StoredItem[], nowIso: string, maxItems: number): Promise<void>;
  updateItem(scheduleId: string, id: string, item: StoredItem, nowIso: string): Promise<boolean>;
  deleteItem(scheduleId: string, id: string): Promise<boolean>;
  upsertImported(scheduleId: string, source: 'ics' | 'google' | 'notion', items: ImportedItem[], nowIso: string, maxItems: number, newId: () => string): Promise<UpsertResult>;

  saveRun(r: RunRecord, keep: number): Promise<void>;
  listRuns(userId: string, scheduleId: string, limit: number): Promise<Omit<RunRecord, 'request' | 'result'>[]>;
  getRun(userId: string, id: string): Promise<RunRecord | null>;
  recordImport(r: ImportRecord): Promise<void>;
  audit(userId: string | null, action: string, detail: Record<string, unknown>, id: string, nowIso: string): Promise<void>;
}
