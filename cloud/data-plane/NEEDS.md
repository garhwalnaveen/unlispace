# Agent 14 integration notes

- Deployment/config agent: set production `ULS_WEB_ORIGINS` to the exact deployed web origin.
  The only production value visible in `cloud/api/wrangler.jsonc` is the unresolved
  `https://unlispace-web.__WORKERS_DOMAIN__`; production is intentionally empty. Dev allows
  `http://localhost:5173`. The allowlist accepts exact origins only, never wildcard patterns.
- Control-plane agent: consume `forkDrive`, `deleteDrive(id, {hard})`, and extended `driveStats`
  from `DataPlaneAdmin`. Enforce the control-plane live-fork hard-delete restriction before
  calling the data plane, as specified by M3 §3.2. RPC errors have stable code messages and
  local `code` properties; workerd transports error name/message across service bindings.
- GC interpretation: while multiple live members exist, local sweeps return a no-delete dry-run
  result. A future lineage-wide union marker is needed to reclaim orphan bytes in shared
  lineages. Failed fork reservations remain registered conservatively. Restored drives also
  disable destructive local sweeping because their snapshot may predate sibling membership.
- Fork export includes all retained version rows (including deleted-path history), a safe
  superset of versions reachable through imported head paths. Heads are embedded in `nodes`
  in this schema; there is no separate `heads` table. Export pages are capped at 100 rows and
  approximately 512 KiB; source state is frozen in SQLite before the first page is returned.
- Hard deletion clears visible metadata and shard registrations, but retains the root's lineage
  registry and any frozen export currently being consumed. It never deletes R2 bytes.
- No deployed Cloudflare resources, production CORS origin, cross-worker API integration,
  multi-gigabyte databases, or process-crash recovery of an interrupted import were verified.
