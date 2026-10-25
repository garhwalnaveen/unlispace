-- Control-plane schema (docs/design/m1-contract.md section 6) plus lookup indexes.
CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE orgs(id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL, trial_ends_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE memberships(org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(org_id, user_id));
CREATE TABLE drives(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, placement TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, family TEXT NOT NULL, refresh_hash TEXT NOT NULL UNIQUE, prev_hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, user_agent TEXT);
CREATE TABLE otp_codes(email TEXT PRIMARY KEY COLLATE NOCASE, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE one_time_codes(code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, payload TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE rate_limits(k TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);

CREATE INDEX memberships_user ON memberships(user_id);
CREATE INDEX drives_org ON drives(org_id);
CREATE INDEX sessions_family ON sessions(family);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX one_time_codes_exp ON one_time_codes(expires_at);
