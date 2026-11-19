-- Single-use handoff codes so a frontend on a DIFFERENT site can finish Google sign-in without third-party cookies.
-- After sign-in the API redirects to the app with #bp_code=<code>; the app POSTs it to /api/auth/exchange and receives a
-- session token. The code is random, hashed at rest, valid for 2 minutes and consumed on first use.
CREATE TABLE login_codes (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_login_codes_expiry ON login_codes(expires_at);
