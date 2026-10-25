ALTER TABLE drives ADD COLUMN alias TEXT;
ALTER TABLE drives ADD COLUMN forked_from TEXT;
ALTER TABLE drives ADD COLUMN fork_point INTEGER;
ALTER TABLE drives ADD COLUMN lineage TEXT;
CREATE UNIQUE INDEX drives_live_alias ON drives(org_id, alias) WHERE status != 'deleted' AND alias IS NOT NULL;
CREATE TABLE drive_usage(drive_id TEXT PRIMARY KEY, logical_bytes INTEGER NOT NULL, own_bytes INTEGER NOT NULL, measured_at INTEGER NOT NULL);
