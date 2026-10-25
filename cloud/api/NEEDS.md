# Integration needs from agent 06

- **Gateway / coordinator (agent 07, M3 binding):** wire an internal service binding to the
  access-key resolver and usage recorder described in `M2-API.md`. There is deliberately no
  public secret lookup endpoint. Check the key's org, drive allowlist and access before every
  operation; record last use only after valid SigV4 + authorization. The current M2 gateway
  task explicitly uses an in-memory KeyResolver. Child keys can already be created with a
  session bearer and a narrower `parent`; a SigV4-authenticated child issuance path belongs
  at the gateway boundary.
- **Data plane / coordinator:** quota currently uses existing `driveStats().bytes`, which is
  logical current-head bytes. Add retained/deduplicated lineage usage and a quota-aware
  write-path check before paid launch. Token issuance cannot prevent an in-flight token or
  concurrent writes from crossing quota; M1 drive tokens retain their 15-minute TTL.
- **Web (agent 09):** use `M2-API.md` for the keys and billing routes. Key creation's secret is
  `secretAccessKey`, shown once; workspace IDs are org IDs. Checkout/portal return `{url}`.
  Invoices are payment summaries; use the portal for PDF downloads. Prices must come from
  chosen Dodo product configuration; none were invented from Space's reference pricing.
- **Coordinator / deployment owner:** apply `0002_keys_billing.sql`, configure versioned key
  masters, Dodo credentials, explicit test/live mode and the six catalog identifiers. Register
  `/webhooks/dodo` for the documented subscription lifecycle events. Choose production prices
  and storage accounting before launch. No resources or products were created and nothing was
  deployed. Nightly usage metering is outside this task's listed endpoints.
