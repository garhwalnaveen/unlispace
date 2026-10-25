CREATE TABLE access_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  access TEXT NOT NULL CHECK(access IN ('read','write','admin')),
  drives TEXT,
  label TEXT,
  parent TEXT REFERENCES access_keys(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX access_keys_org ON access_keys(org_id);
CREATE INDEX access_keys_parent ON access_keys(parent);

CREATE TABLE billing (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  customer_id TEXT UNIQUE,
  subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'trialing',
  plan TEXT NOT NULL DEFAULT 'individual' CHECK(plan IN ('individual','teams')),
  cadence TEXT NOT NULL DEFAULT 'monthly' CHECK(cadence IN ('monthly','annual')),
  seats INTEGER NOT NULL DEFAULT 1 CHECK(seats > 0),
  storage_addons INTEGER NOT NULL DEFAULT 0 CHECK(storage_addons >= 0),
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  event_at INTEGER NOT NULL DEFAULT 0,
  event_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE billing_checkouts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX billing_checkouts_org ON billing_checkouts(org_id);
CREATE TABLE dodo_events(id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL);
