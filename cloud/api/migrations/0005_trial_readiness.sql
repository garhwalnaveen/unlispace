-- New accounts start their trial only when storage becomes usable.
-- Existing paid, active, expired and null-trial rows must never acquire a new trial.
ALTER TABLE orgs ADD COLUMN trial_pending INTEGER NOT NULL DEFAULT 0;
