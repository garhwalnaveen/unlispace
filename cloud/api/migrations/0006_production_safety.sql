CREATE TABLE drive_usage_attempts (
  drive_id TEXT PRIMARY KEY REFERENCES drives(id),
  attempted_at INTEGER NOT NULL
);
ALTER TABLE billing_checkouts ADD COLUMN checkout_url TEXT;
ALTER TABLE billing_checkouts ADD COLUMN session_id TEXT;
ALTER TABLE billing_checkouts ADD COLUMN selection TEXT;
CREATE TABLE billing_checkout_locks (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES billing_checkouts(id)
);
