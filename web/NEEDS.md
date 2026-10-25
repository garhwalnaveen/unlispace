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
