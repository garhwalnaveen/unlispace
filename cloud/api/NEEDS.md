# Integration needs from agent 15 (M3; supersedes agent 06's M2 usage notes)

- **Gateway:** bind `CONTROL_PLANE` to service `unlispace-api`, entrypoint `ControlPlane`.
  Implemented RPC surface and errors are in `M3-API.md`. Every operation rechecks live key
  authority. Use `BucketInfo.writable` for quota/entitlement write gating, and call
  `recordKeyUse` only after verified SigV4 and successful authorization. Forward the entire
  child-mint body so an explicitly foreign `workspaceId` is refused, not dropped.
- **Data plane:** provide the M3 `forkDrive`, `deleteDrive(id,{hard})`, and extended
  `driveStats` RPCs from `docs/design/m3-contract.md` §2.1. API tests use local fakes;
  cross-worker fork/lineage/GC behavior needs integration verification by its owner.
- **Coordinator / deployment:** apply `0003_m3.sql` after 0001/0002; deploy both default and
  production hourly cron `17 * * * *`. Configure versioned access-key masters, JWT keys,
  Dodo credentials/products and production origins. No migration or deployment was performed
  against any remote service by agent 15.
- **Web / CLI:** consume Drive `alias`, `forkOf`, `forks`, `usageBytes`; individual root limit
  excludes forks. Explicit write-token requests now fail with `403 over_quota` for expired
  entitlement as well as excess usage. Request read tokens to retain download access.
- **Accounting limits:** quota uses the latest hourly own-byte measurement; never-measured
  drives contribute zero. Tokens already issued remain valid up to 15 minutes. Coordinated
  enforcement during concurrent writes and process-crash recovery between D1 lifecycle rows
  and data-plane RPCs are not provided by this control-plane gate.
