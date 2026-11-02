# Orbit authentication and Mac acceptance — 2 November 2026

## Authentication findings and fix

The reported Google URL pointed a hosted website at `http://127.0.0.1:8788`.
That address is the visitor's own computer, not the hosted API. Its return URL also
used the old Workers web origin. The live API rejects that origin with HTTP 400
`bad_return`; its configured web origin is `https://orbitfs.io`.

At the start of this review, the current live web bundle already contained the
hosted API endpoint and redirected the old Workers hostname to `orbitfs.io`.
Those corrections and the production build guard were already in the working
tree. Verified the deployed bundle contains the hosted API and no loopback API;
also verified a production build with a loopback API fails before bundling.

Found and fixed a separate desktop authentication bug: `/auth/desktop/start`
dropped `switch=1` from the Mac's “Use a different account” request. The redirect
now forwards exactly that value, preserving state and PKCE parameters. Added an
API regression test covering switching, ordinary sign-in, and ignored values.

Applied only that expression change to the deployed API through Cloudflare's
code-only content endpoint. The live redirect now includes `switch=1`.
All settings and bindings were compared before and after and are identical.
Deployment ID: `4f7f093e0a9c42f886ef1bfec566acf3`.

## Checks on this Mac

- Real Google sign-in on `orbitfs.io` completed for the existing account and
  opened its hosted workspace and file listing.
- Downloaded the existing `Orbit-0.2.7-preview.dmg` over a localhost HTTP server.
  Chrome left its download unconfirmed; the completed test copy was downloaded
  with curl. This does **not** establish a working public/browser installer flow.
- Downloaded DMG SHA-256:
  `2108776e7da013eb4978e1580736e1e9ca9206050138469fa835a8052ee98055`.
  It matches the packaged DMG. Its read-only mount and bundled app signature passed.
- Installed the DMG's app as `~/Applications/Orbit.app`, alongside the previous
  app. Launched it, verified version 0.2.7-preview, restored account and mounted drive.
  Kept the existing background engine running to preserve its pending upload.
- Ran “Use a different account” from the installed app, used “Open browser”,
  selected the same Google account, reached “Your Orbit is ready”, and clicked
  “Open Orbit”. The callback returned to the installed app and completed sign-in.
  A different-user transition and fresh-account provisioning were not tested.
- Final engine RPC checks: signed in, one mounted drive, one pending operation;
  the original 6,148-byte `.DS_Store` upload is still present.
- 39 API authentication/Google tests and 24 web authentication/desktop/link tests
  passed. API typecheck, web production build, and targeted diff whitespace checks passed.

## Other issues identified

1. **Google consent branding:** Google shows `naveen-f3d.workers.dev` and links to
   Nuvi privacy/terms pages. Correct the OAuth consent configuration in Google Cloud
   for Orbit; this was not changed by the server patch.
2. **Installer distribution:** The website has no Mac installer download link or
   published DMG in its current static assets. The tested installer is a local preview.
3. **Installer signing:** The app is ad-hoc signed, without a Developer ID team or
   notarization. Normal distribution and Gatekeeper acceptance remain unverified.
4. **Expired-account controls:** The hosted workspace reports the trial ended, but
   its file browser still offers upload controls. `DriveContents` checks the drive
   role instead of workspace `writable` access. The native app likewise offers
   “Add a file…” beside the expired-trial message. Existing mounted writes can remain
   queued after access expires; this account already has one queued operation.
5. **System authentication presentation:** The system sign-in window was not visibly
   usable from the app during this test. The explicit browser fallback completed the
   flow. Default-window presentation still needs a separate fix/acceptance pass.
6. **Account-switch accessibility hint:** The Mac button says it signs out the current
   account, although its confirmation and implementation retain the desktop account
   until replacement sign-in succeeds.

No trial dates, billing state, saved files, or queued operations were changed.
Successful cloud writes could not be established on this expired account. A full
helper upgrade, clean-install setup, fresh signup, notarized public download, and
the non-authentication product flows remain outside this acceptance result.
