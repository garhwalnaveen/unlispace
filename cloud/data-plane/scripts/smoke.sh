#!/usr/bin/env bash
# Smoke test against a running `npm run dev` (wrangler dev, local R2 + DO).
# Usage: ULS_DEV_TOKEN=... [BASE=http://127.0.0.1:8787] scripts/smoke.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="${ULS_DEV_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$(dirname "$0")/../.dev.vars" ]; then
  TOKEN="$(grep '^ULS_DEV_TOKEN=' "$(dirname "$0")/../.dev.vars" | cut -d= -f2-)"
fi
[ -n "$TOKEN" ] || { echo "set ULS_DEV_TOKEN or create .dev.vars" >&2; exit 1; }

DRIVE="smoke-$(date +%s)-$RANDOM"
AUTH=(-H "Authorization: Bearer $TOKEN")
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

step() { printf '\n== %s\n' "$*"; }
expect_status() { # expected actual label
  [ "$1" = "$2" ] || { echo "FAIL: $3 expected HTTP $1 got $2" >&2; exit 1; }
}

step "create drive $DRIVE"
code=$(curl -s -o "$TMP/out" -w '%{http_code}' "${AUTH[@]}" -X PUT -H 'Content-Type: application/json' -d '{"placement":"enam"}' "$BASE/v0/drives/$DRIVE")
cat "$TMP/out"; echo; expect_status 201 "$code" "create drive"

step "upload shard"
printf 'hello unlispace smoke test\n' > "$TMP/shard.bin"
HASH="$(shasum -a 256 "$TMP/shard.bin" | cut -d' ' -f1)"
SIZE="$(wc -c < "$TMP/shard.bin" | tr -d ' ')"
code=$(curl -s -o "$TMP/out" -w '%{http_code}' "${AUTH[@]}" -X PUT --data-binary @"$TMP/shard.bin" "$BASE/v0/drives/$DRIVE/shards/$HASH")
cat "$TMP/out"; echo; expect_status 201 "$code" "upload shard"

step "missing (expect empty)"
curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"hashes\":[\"$HASH\"]}" "$BASE/v0/drives/$DRIVE/shards/missing"; echo

step "commit"
code=$(curl -s -o "$TMP/out" -w '%{http_code}' "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"ops\":[{\"op\":\"put\",\"path\":\"docs/hello.txt\",\"ifAbsent\":true,\"size\":$SIZE,\"contentType\":\"text/plain\",\"mtimeMs\":1792911671000,\"shards\":[{\"h\":\"$HASH\",\"n\":$SIZE}]}]}" \
  "$BASE/v0/drives/$DRIVE/commit")
cat "$TMP/out"; echo; expect_status 200 "$code" "commit"

step "stat"
code=$(curl -s -o "$TMP/out" -w '%{http_code}' "${AUTH[@]}" "$BASE/v0/drives/$DRIVE/stat?path=docs/hello.txt")
cat "$TMP/out"; echo; expect_status 200 "$code" "stat"

step "list"
curl -s "${AUTH[@]}" "$BASE/v0/drives/$DRIVE/list?path=docs/"; echo

step "get shard back"
code=$(curl -s -o "$TMP/back.bin" -w '%{http_code}' "${AUTH[@]}" "$BASE/v0/drives/$DRIVE/shards/$HASH")
expect_status 200 "$code" "get shard"
cmp "$TMP/shard.bin" "$TMP/back.bin" && echo "bytes identical"

step "unauthorized (expect 401)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v0/drives/$DRIVE")
expect_status 401 "$code" "no token"; echo "401 ok"

printf '\nSMOKE OK (drive %s)\n' "$DRIVE"
