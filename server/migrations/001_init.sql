-- Breakpoint database schema (SQLite; written to port 1:1 to Cloudflare D1).
-- Conventions: ids are UUIDs (TEXT); timestamps are ISO-8601 UTC strings; booleans are 0/1;
-- JSON columns hold validated JSON text. Every row that belongs to a person carries user_id
-- (directly or through its schedule) and every query filters by it.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,                 -- NULL for guests
  name          TEXT,
  picture       TEXT,
  google_sub    TEXT UNIQUE,                 -- stable Google account id (NULL for guests)
  is_guest      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- Opaque session tokens. Only the SHA-256 hash is stored: a database leak does not leak live sessions.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Short-lived OAuth state (CSRF protection, PKCE verifier, nonce). Consumed (deleted) on first use.
CREATE TABLE oauth_states (
  state_hash     TEXT PRIMARY KEY,
  purpose        TEXT NOT NULL CHECK (purpose IN ('login', 'connect_google')),
  code_verifier  TEXT NOT NULL,
  nonce          TEXT,
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,   -- who is connecting (or the guest being upgraded)
  redirect_path  TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_oauth_states_expiry ON oauth_states(expires_at);

-- External accounts the user explicitly connected. Tokens are AES-256-GCM encrypted. Read-only scopes only.
CREATE TABLE connections (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('google', 'notion')),
  account_label       TEXT,
  scopes              TEXT NOT NULL,           -- JSON array of the scopes the user consented to
  access_token_enc    TEXT,
  refresh_token_enc   TEXT,
  token_expires_at    TEXT,
  consent_at          TEXT NOT NULL,           -- when the user explicitly agreed
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_connections_user ON connections(user_id);

CREATE TABLE schedules (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  timezone            TEXT NOT NULL,
  preferences         TEXT NOT NULL,           -- JSON (validated Preferences)
  source_schedule_id  TEXT REFERENCES schedules(id) ON DELETE SET NULL,   -- set when created by "adopt" (a copy; the original is untouched)
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_schedules_user ON schedules(user_id);

-- The user's own copy of events/tasks/breaks. Calendar imports are READ-ONLY copies: nothing here is ever written back
-- to Google, Notion or an .ics file, and simulations never modify these rows.
CREATE TABLE schedule_items (
  id              TEXT PRIMARY KEY,
  schedule_id     TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('event', 'task', 'break')),
  title           TEXT NOT NULL,
  start_at        TEXT,                        -- ISO with offset; NULL = unscheduled task
  duration_min    INTEGER NOT NULL CHECK (duration_min > 0 AND duration_min <= 20160),
  all_day         INTEGER NOT NULL DEFAULT 0,
  timezone        TEXT NOT NULL,
  locked          INTEGER,                     -- NULL = default for the kind
  priority        INTEGER CHECK (priority BETWEEN 1 AND 5),
  category        TEXT,
  deadline_at     TEXT,
  release_at      TEXT,
  is_deferrable      INTEGER,
  critical        INTEGER,
  blocking        INTEGER NOT NULL DEFAULT 1,
  rrule           TEXT,
  exdates         TEXT NOT NULL DEFAULT '[]',  -- JSON array of ISO strings
  source          TEXT NOT NULL CHECK (source IN ('manual', 'ics', 'google', 'notion', 'demo')),
  external_id     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_items_schedule ON schedule_items(schedule_id);
-- idempotent re-imports: the same external item never creates a duplicate
CREATE UNIQUE INDEX idx_items_external ON schedule_items(schedule_id, source, external_id) WHERE external_id IS NOT NULL;

-- Audit trail of explicit imports (what, from where, with which consent).
CREATE TABLE imports (
  id              TEXT PRIMARY KEY,
  schedule_id     TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  connection_id   TEXT REFERENCES connections(id) ON DELETE SET NULL,
  consent_at      TEXT NOT NULL,
  created_count   INTEGER NOT NULL,
  updated_count   INTEGER NOT NULL,
  missing_count   INTEGER NOT NULL,            -- previously imported items absent from this import (never auto-deleted)
  warnings        TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_imports_schedule ON imports(schedule_id);

-- Saved simulation runs (optional; for history). Purely a record: running a simulation never changes schedule_items.
CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  schedule_id  TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('simulate', 'chaos', 'breaking_point', 'futures', 'fortify')),
  request      TEXT NOT NULL,
  result       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_runs_schedule ON runs(schedule_id, created_at);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
