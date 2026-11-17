-- Fork lookups run on every drive read; without this they scan the drives table.
CREATE INDEX drives_forked_from ON drives(forked_from) WHERE forked_from IS NOT NULL;
-- Scheduled pruning (src/maintenance.ts) selects by these columns.
CREATE INDEX sessions_revoked ON sessions(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE INDEX rate_limits_window ON rate_limits(window_start);
