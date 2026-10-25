# Vendored source

- Project: https://github.com/paltaio/rust-smb-server
- Revision: `ac13f304c20d6ada43db3cb693835acae193965f` (2026-10-22)
- Package: `smb-server` 0.7.0
- License: MIT, preserved in `LICENSE`; original notices remain in source.
- Retrieved from the GitHub archive on 2026-10-25. No AGPL code was used.

This is the same project published as `smb-server`, formerly split into the
`paltaio-smb-*` packages. The current implementation already supplies NTLMv2,
SPNEGO, dialect negotiation, signing/encryption, credits, compounds, byte locks,
share/access enforcement, cancellable asynchronous requests, and directory watches.
Its existing unit/integration tests made a scoped fork preferable to rewriting
those security and concurrency mechanisms from MS-SMB2.

Local changes:

- Joined the enclosing isolated workspace, pinned dependencies, disabled the
  default host filesystem backend (enabled only for tests).
- Added final-component stream parsing, opt-in `named_streams` capabilities,
  `Handle::streams`, stream enumeration, and the named-stream filesystem flag.
  CREATE still rejects streams for backends without that capability.
- Propagated backend close/commit errors to explicit CLOSE responses, preserved
  cleanup and pending-request termination, and logged implicit close failures.
- Added Microsoft published signing-key/signature known-answer tests.
- Adapted deprecated atomic APIs to Rust 1.99 (`fetch_update` -> `try_update`).
  Allowed two cosmetic lints for async_trait-generated code and upstream slice
  interfaces; did not disable validation/security lints. Applied rustfmt.

The original README describes upstream. The enclosing README describes the
Unlispace adapter and the verification limitations of this fork.
