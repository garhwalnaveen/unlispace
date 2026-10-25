#!/bin/bash
# M1 cloud end-to-end: OTP sign-in -> provisioning -> drive token -> data plane.
set -u
A=http://127.0.0.1:8788; LOG=/tmp/wdev-api.log
ok=0; bad=0; pass(){ echo "PASS  $1"; ok=$((ok+1)); }; fail(){ echo "FAIL  $1"; bad=$((bad+1)); }
j(){ python3 -I -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1],{'d':d}))" "$1"; }
EMAIL="e2e+$(date +%s)@example.com"

curl -s -X POST $A/auth/otp/start -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\"}" | grep -q '"ok":true' && pass "otp start" || fail "otp start"
sleep 1
CODE=$(grep -A1 "To: $EMAIL" $LOG | grep -oE "code: [0-9]{6}" | tail -1 | grep -oE "[0-9]{6}")
[ -n "$CODE" ] && pass "dev OTP logged (not printed here)" || { fail "no OTP in log"; tail -5 $LOG; exit 1; }
curl -s -X POST $A/auth/otp/verify -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"code\":\"000000\"}" -o /dev/null -w '%{http_code}' | grep -q 400 && pass "wrong code -> 400" || fail "wrong code"
S=$(curl -s -X POST $A/auth/otp/verify -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")
AT=$(echo "$S" | j "d['accessToken']"); RT=$(echo "$S" | j "d['refreshToken']")
[ "$(echo "$S" | j "d['accountCreated']")" = True ] && pass "verify -> session, accountCreated" || fail "verify: $S"

ORGS=$(curl -s $A/orgs -H "authorization: Bearer $AT")
DRIVE=$(echo "$ORGS" | j "d['orgs'][0]['drives'][0]['id']"); ST=$(echo "$ORGS" | j "d['orgs'][0]['drives'][0]['status']")
echo "    org=$(echo "$ORGS" | j "d['orgs'][0]['name']") drive=$DRIVE status=$ST role=$(echo "$ORGS" | j "d['orgs'][0]['role']")"
[ "$ST" = ready ] && pass "first sign-in provisioned 'My Space' + ready drive via service binding" || fail "drive not ready ($ST)"

T=$(curl -s -X POST $A/drives/$DRIVE/token -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"access":"write"}')
DT=$(echo "$T" | j "d['token']"); EP=$(echo "$T" | j "d['endpoint']")
[ -n "$DT" ] && pass "drive token minted (endpoint $EP)" || fail "token: $T"

# data plane with the real token
code=$(curl -s -o /dev/null -w '%{http_code}' "$EP/v0/drives/$DRIVE" -H "authorization: Bearer $DT"); [ "$code" = 200 ] && pass "data plane accepts api-signed token" || fail "dp drive info $code"
printf 'hello unlispace' > /tmp/uls-m1/h.txt; H=$(shasum -a 256 /tmp/uls-m1/h.txt | cut -d' ' -f1)
curl -s -o /dev/null -w '%{http_code}' -X PUT "$EP/v0/drives/$DRIVE/shards/$H" -H "authorization: Bearer $DT" --data-binary @/tmp/uls-m1/h.txt | grep -qE '20[01]' && pass "shard PUT with drive token" || fail "shard put"
C=$(curl -s -X POST "$EP/v0/drives/$DRIVE/commit" -H "authorization: Bearer $DT" -H 'content-type: application/json' -d "{\"ops\":[{\"op\":\"put\",\"path\":\"hello.txt\",\"size\":15,\"shards\":[{\"h\":\"$H\",\"n\":15}]}]}")
echo "$C" | grep -q versionId && pass "commit" || fail "commit: $C"
ACT=$(curl -s "$EP/v0/drives/$DRIVE/versions?path=hello.txt" -H "authorization: Bearer $DT" | j "d['versions'][0]['actor']")
[ "${ACT:0:2}" = u_ ] && pass "version actor = user id from token sub" || fail "actor=$ACT"

# negative checks
code=$(curl -s -o /dev/null -w '%{http_code}' "$EP/v0/drives/some-other-drive" -H "authorization: Bearer $DT"); [ "$code" = 404 ] && pass "token for drive A on drive B -> 404" || fail "cross-drive $code"
RTOK=$(curl -s -X POST $A/drives/$DRIVE/token -H "authorization: Bearer $AT" -H 'content-type: application/json' -d '{"access":"read"}' | j "d['token']")
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$EP/v0/drives/$DRIVE/commit" -H "authorization: Bearer $RTOK" -H 'content-type: application/json' -d '{"ops":[{"op":"mkdir","path":"x/"}]}'); [ "$code" = 404 ] && pass "read token cannot commit (404)" || fail "read-token commit $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$EP/v0/drives/$DRIVE" -H "authorization: Bearer $AT"); [ "$code" = 401 ] && pass "api access token rejected by data plane (wrong typ)" || fail "access token on dp $code"

# refresh rotation + reuse detection
R2=$(curl -s -X POST $A/auth/refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$RT\"}"); RT2=$(echo "$R2" | j "d['refreshToken']")
[ -n "$RT2" ] && [ "$RT2" != "$RT" ] && pass "refresh rotates" || fail "refresh: $R2"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $A/auth/refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$RT\"}"); [ "$code" = 401 ] && pass "reused old refresh token -> 401" || fail "reuse $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $A/auth/refresh -H 'content-type: application/json' -d "{\"refreshToken\":\"$RT2\"}"); [ "$code" = 401 ] && pass "reuse revoked whole family (new token dead too)" || fail "family not revoked $code"

echo "RESULT: $ok passed, $bad failed"
rm -f /tmp/uls-m1/h.txt
