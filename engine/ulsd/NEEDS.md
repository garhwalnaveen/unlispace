# Changes ulsd/uls-auth need from crates I may not edit

## 1. uls-client: token provider (not blocking)

`Client` holds a `String` token, fixed at `build()`. Drive tokens last <= 15 min, so the daemon
currently rebuilds the client on every rotation (`ulsd/src/mount.rs::SharedClient`, a timer in
`engine.rs::spawn_rotation`). That works, but in-flight requests at the swap use the old token
and a 401 mid-read is possible.

Wanted:

```rust
#[async_trait]
pub trait TokenProvider: Send + Sync { async fn token(&self) -> Result<String, Error>; }
ClientBuilder::token_provider(Arc<dyn TokenProvider>)   // alternative to the static token
```

`Client::req()` becomes async (or resolves the token before building the request). On a 401
response, call the provider once more (it may force a refresh) and retry the request once.
`uls-auth` already offers `TokenProvider` (error type `AuthError`) and `DriveTokenSource`; a small
adapter, or making the trait generic over the error, is enough. The endpoint can also change with
the token (`DriveToken.endpoint`), so allow the provider to return `(endpoint, token)` or keep the
endpoint static.

## 2. uls-client / uls-proto: change feed per m0-contract §3.5 (amended)

The daemon does NOT use `Client::watch` today; `ulsd/src/watch.rs` implements its own loop. To
let it (and the CLI `uls watch`) use the shared one:

- uls-proto `Change`: add `ev: i64`. `WatchMessage::Change` needs `ev`, and a new variant
  `Resync { head_seq: u64, last_ev: i64 }` (`{"type":"resync","headSeq","lastEv"}`).
  `ChangesResponse` needs `lastEv`, `more`, and per-change `ev`.
- `Client::changes(drive, after_ev, limit)` should send `?after=<ev>` (keep `since` as an alias).
- `Client::watch(drive, after_ev)`: connect with `?after=<ev>`, track the last `ev` (dedup on `ev`,
  not `seq`, since one commit yields many events), and expose the cursor so callers can persist it.
- Close codes: `4401` -> ask the token provider for a fresh token and reconnect immediately;
  `4404` -> end the stream (drive deleted); `resync` -> yield a `Resync { head_seq, last_ev }` item
  so the caller re-lists, then continue from `last_ev`.
- The stream must be able to take a fresh token on each reconnect (see item 1).

## 3. uls-mock: change feed

To test the daemon's watch against the mock it must serve `ev`, `?after=`, `resync`, and close
codes 4401/4404. Until then `ulsd/src/watch.rs` has unit tests for URL building and message
parsing only; there is no end-to-end watch test.
