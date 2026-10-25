# 09-web-polish integration needs

- **Data-plane agent / coordinator:** `cloud/data-plane/src/index.ts` currently has no CORS handling.
  The separately hosted SPA needs OPTIONS responses and an exact allowed web origin on all `/v0`
  responses (including errors), methods GET/POST/PUT, and allowed headers Authorization/Content-Type.
  Without this, real browser listings/downloads/uploads fail cross-origin, although mocked gates pass.
  Typed-array PUTs let the browser supply the required Content-Length; no manual length header is sent.
- **API agent (future cookie migration):** implement browser HttpOnly refresh cookies, credentialed CORS,
  Origin/CSRF checks and cookie clearing before durable browser sessions can return. The migration
  requirements and desktop separation are documented in README.md. Current M1 JSON auth still works
  with memory-only credentials; closing all live tabs requires sign-in.
- **Coordinator:** run live browser upload/conflict and Dodo sandbox checkout/portal smoke checks once
  backend CORS and payment configuration are available. The browser tool in this session required
  unavailable approval, so no visual browser verification was performed.

# 18-web-m3 integration notes

- **Coordinator:** run a real-browser smoke check with the integrated API/data plane: create a
  fork, inspect its fork point/lineage, collide and edit aliases, reject hard delete with live forks,
  verify metered quota banners, restore an as-of version, and revoke an ancestor key. All new web
  tests use fetch stubs; no external services were called.
- **Interpretation:** the existing web UI exposed history downloads but no restore flow. M3 adds
  one confirmed, `ifVersion`-guarded data-plane `/restore` flow, shared by history rows and as-of
  selection. As-of selection requires loading every history page before selecting by timestamp
  (sequence breaks equal-timestamp ties); a deletion head shows the file as deleted.
