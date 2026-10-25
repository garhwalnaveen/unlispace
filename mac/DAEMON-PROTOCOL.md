# Daemon control protocol (app <-> `ulsd`)

Version 0. The Rust daemon implements the server; `Unlispace.app` is the client
(`Sources/UnlispaceKit/DaemonProtocol.swift`, `UnixSocketDaemonClient.swift`).

## Transport
- Unix domain socket, `SOCK_STREAM`, at `~/Library/Application Support/Unlispace/ulsd.sock`.
- Directory mode `0700`, socket mode `0600`. The server should verify the peer is the same uid
  (`LOCAL_PEERCRED` / `getpeereid`) and reject others.
- Framing: UTF-8 JSON objects, one per line, terminated by `\n`. No pretty-printing; objects must
  not contain raw newlines. Either side ignores empty lines.
- Multiple clients may connect. Events are broadcast to every connected client.
- Tokens must never appear in responses, events, or logs.

## Requests (client -> server)
```
{"id": <int>, "method": "<name>", "params": { ... }}     // params optional
```
`id` is chosen by the client and echoed in the response. Requests may be pipelined; responses may
arrive out of order.

## Responses (server -> client)
```
{"id": <int>, "result": { ... }}
{"id": <int>, "error": {"code": "<snake_case>", "message": "<human text>"}}
```
Exactly one of `result` / `error`. Methods without data return `"result": {}`.

## Events (server -> client, unsolicited)
```
{"event": "<name>", "data": { ... }}
```
Events have no `id`. Clients must ignore unknown event names. Unknown fields are ignored.

## Methods

| method | params | result |
|---|---|---|
| `status` | none | `{"version": str, "state": State, "message"?: str, "pendingOps"?: int}` |
| `drives.list` | none | `{"drives": [Drive]}` |
| `drive.mount` | `{"driveId": str}` | `{}` (returns once mounted or errors) |
| `drive.unmount` | `{"driveId": str}` | `{}` |
| `transfers` | none | `{"transfers": [Transfer]}` (active and queued) |
| `config.set` | `{"endpoint"?: str, "token"?: str, "cacheCapBytes"?: int}` | `{}` |

`config.set` is how the app hands the daemon the endpoint, token and cache cap it holds in the
Keychain/preferences. Omitted fields are unchanged. The daemon must not log `token`.

Error codes: `no_such_drive`, `already_mounted`, `not_mounted`, `unauthorized`, `offline`,
`bad_request`, `internal`. Unknown methods return `bad_request`.

## Types
- `State`: `"signed_out" | "idle" | "syncing" | "offline" | "error"`
- `Drive`: `{"driveId": str, "name": str, "mountState": MountState, "mountPath"?: str}`
- `MountState`: `"unmounted" | "mounting" | "mounted" | "unmounting" | "error"`
- `Transfer`: `{"id": str, "driveId": str, "path": str, "direction": "upload"|"download", "bytesDone": int, "bytesTotal": int, "status": "queued"|"active"|"done"|"failed"}`

## Events
| event | data |
|---|---|
| `transfer` | a `Transfer` (sent on start, throttled progress, and completion; `done`/`failed` ends it) |
| `change` | `{"driveId": str, "seq": int, "paths": [str]}` remote change from the drive WebSocket |
| `state` | `{"state": State, "message"?: str}` |

The server sends a `state` event immediately after a client connects.

## Example
```
-> {"id":1,"method":"status"}
<- {"id":1,"result":{"version":"0.1.0","state":"idle","pendingOps":0}}
-> {"id":2,"method":"drive.mount","params":{"driveId":"demo"}}
<- {"event":"transfer","data":{"id":"t1","driveId":"demo","path":"/a.bin","direction":"download","bytesDone":0,"bytesTotal":4096,"status":"active"}}
<- {"id":2,"result":{}}
<- {"event":"state","data":{"state":"syncing"}}
```
