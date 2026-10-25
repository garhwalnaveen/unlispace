# 18 · Normal (gpt-6.1-sol): web app — forks, lineage, usage, aliases, hard delete, quota banner, history "as of"  — write in: web/
Spec: docs/design/m3-contract.md §1, §3.2, §3.4 (API shapes). Do NOT edit `web/src/AuthPages.tsx` (the
user has an uncommitted fix there).
1. Drive page/menu: "Fork drive…" (name + alias, shows fork point after), lineage panel (forked from,
   forks, links), alias shown/editable with `alias_taken` handling, hard delete behind a typed
   confirmation with `drive_has_forks` message, usage bytes per drive.
2. Billing/home: org used vs quota meter and an over-quota banner explaining writes are paused.
3. Version history: "View as of…" date-time picker that opens the version that was head then (client-side
   pick by `ts`), restore button reuses the existing restore flow.
4. Access keys page: show child keys nested under their parent, revoke shows that descendants go too.
Accessible (labels, focus order, keyboard), matches existing styles.css. Tests with fetch stubs for each.
Gate: `cd web && npx tsc --noEmit && npm test && npm run build`. Report ≤ 250 words.
