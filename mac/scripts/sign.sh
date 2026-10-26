#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Unlispace.app}"
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
if [[ "$IDENTITY" == - ]]; then
  # Even an empty entitlement blob makes launchd require a trusted signature on helpers.
  if [[ -f "$APP/Contents/MacOS/ulsd" ]]; then sign "$APP/Contents/MacOS/ulsd"; fi
  sign "$APP"
else
  if [[ -f "$APP/Contents/MacOS/ulsd" ]]; then sign --entitlements "$ROOT/entitlements/daemon.plist" "$APP/Contents/MacOS/ulsd"; fi
  sign --entitlements "$ROOT/entitlements/app.plist" "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "SIGN PASS: bundle verified ($([[ "$IDENTITY" == - ]] && echo ad-hoc || echo Developer-ID))"
