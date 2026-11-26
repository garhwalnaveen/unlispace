#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Orbit.app}"
IDENTITY="${ULS_SIGN_IDENTITY:--}"
OPTIONS=(--force --sign "$IDENTITY")
# Ad-hoc builds have no team identity for validating the embedded Sparkle framework.
# Hardened runtime is enabled for Developer ID distribution builds.
if [[ "$IDENTITY" == - ]]; then
  OPTIONS+=(--timestamp=none)
else
  OPTIONS+=(--options runtime --timestamp)
fi
sign() { codesign "${OPTIONS[@]}" "$@"; }
FRAMEWORK="$APP/Contents/Frameworks/Sparkle.framework"
# Inside-out; never --deep sign (it hides missing nested signing rules).
while IFS= read -r -d '' code; do sign "$code"; done < <(find "$FRAMEWORK" -type d -name '*.xpc' -print0)
while IFS= read -r -d '' code; do sign "$code"; done < <(find "$FRAMEWORK" -type f -name Autoupdate -print0)
while IFS= read -r -d '' code; do sign "$code"; done < <(find "$FRAMEWORK" -type d -name '*.app' -print0)
sign "$FRAMEWORK"
HELPER="$APP/Contents/MacOS/ulsd"
if [[ -f "$HELPER" ]]; then
  if [[ "$IDENTITY" == - ]]; then
    # Even an empty entitlement blob makes launchd require a trusted signature on helpers.
    sign "$HELPER"
  else
    sign --entitlements "$ROOT/entitlements/daemon.plist" "$HELPER"
  fi
  # Pin launchd to the signed helper identity; automatic inference can yield a zero hash on reinstall.
  python3 - "$HELPER" "$APP/Contents/Library/LaunchAgents/com.orbit.ulsd.plist" "$IDENTITY" <<'PY'
import pathlib, plistlib, subprocess, sys
helper, path, identity = sys.argv[1:]
plist = pathlib.Path(path)
agent = plistlib.loads(plist.read_bytes())
agent.pop("SpawnConstraint", None)
if identity != "-":
    info = subprocess.check_output(["codesign", "-dv", "--verbose=4", helper], stderr=subprocess.STDOUT, text=True)
    fields = dict(line.split("=", 1) for line in info.splitlines() if "=" in line)
    team = fields["TeamIdentifier"]
    if team == "not set":
        raise SystemExit("Developer ID signing must supply a team identifier")
    agent["SpawnConstraint"] = {"team-identifier": team, "signing-identifier": fields["Identifier"]}
plist.write_bytes(plistlib.dumps(agent))
PY
fi
if [[ "$IDENTITY" == - ]]; then sign "$APP"; else sign --entitlements "$ROOT/entitlements/app.plist" "$APP"; fi
codesign --verify --deep --strict "$APP"
echo "SIGN PASS: bundle verified ($([[ "$IDENTITY" == - ]] && echo ad-hoc || echo Developer-ID))"
