-- "Log in with Notion": one more reason an OAuth state can exist. SQLite cannot change a CHECK constraint in place and these rows
-- only live for 10 minutes, so the table is rebuilt (an in-flight sign-in at the moment of migrating just has to be started again).
DROP TABLE oauth_states;
CREATE TABLE oauth_states (
  state_hash     TEXT PRIMARY KEY,
  purpose        TEXT NOT NULL CHECK (purpose IN ('login', 'connect_google', 'connect_notion')),
  code_verifier  TEXT NOT NULL,
  nonce          TEXT,
  user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
  redirect_path  TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_oauth_states_expiry ON oauth_states(expires_at);
