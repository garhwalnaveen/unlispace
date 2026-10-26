# Hosted file-browser CORS repair

The signed-in hosted web app cannot list the account's drive because the data-plane Worker
returns HTTP 401 to an OPTIONS preflight. The actual authenticated GET never reaches the Worker.

Prepared patch: `mac/.build/hosted-cors-review/unlispace-data-plane/`.

- Uses an authenticated read-only download of the currently deployed Worker, not the unrelated modified M3 backend source.
- Adds `src/browser-cors.mjs` and `src/cors-entry.mjs`; the downloaded implementation and exported Durable Object classes remain unchanged.
- Allows the exact origin `https://unlispace-web.naveen-f3d.workers.dev` on file routes. OPTIONS returns 204 for that origin. Actual requests still pass through the original authentication and authorization logic, including 401 responses.
- Keeps the existing Durable Object and R2 bindings, compatibility date, issuer, disabled developer authentication, disabled GC deletion, and existing variables/secrets.
- Changes no database schema or data and performs no migration.
- Records the active baseline deployment and source hashes for review/rollback.

Validation: Node assertions passed for preflight, exact-origin matching, unchanged unauthorized
responses and non-file routes; Wrangler deploy dry-run passed. Deployment requires approval
because it changes the existing hosted service's traffic handling. After approval, verify
browser listing plus a small generated test-file upload/download.

Baseline version: `2215c14c-ad19-4fc3-898f-05a0703de95d`.


## Deployment result

Approved by the user and deployed as version `e4829d69-983a-4638-b29f-e614680be05c`.
Live hosted drive listing and a generated test-file upload/download succeeded afterward;
native SMB wrote a second version that the hosted browser independently observed.
