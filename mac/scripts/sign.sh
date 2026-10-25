#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Unlispace.app}"
IDENTITY="${ULS_SIGN_IDENTITY:--}"
OPTIONS=(--force --sign "$IDENTITY" --options runtime)
if [[ "$IDENTITY" == - ]]; then OPTIONS+=(--timestamp=none); else OPTIONS+=(--timestamp); fi
sign() { codesign "${OPTIONS[@]}" "$@"; }
FRAMEWORK="$APP/Contents/Frameworks/Sparkle.framework"
# Inside-out; never --deep sign (it hides missing nested signing rules).
while IFS= read -r -d '' code; do sign "$code"; done < <(find "$FRAMEWORK" -type d -name '*.xpc' -print0)
while IFS= read -r -d '' code; do sign "$code"; done < <(find "$FRAMEWORK" -type f -name Autoupdate -print0)
while IFS= read -r -d '' code; do sign "$code"; done < <(find "$FRAMEWORK" -type d -name '*.app' -print0)
sign "$FRAMEWORK"
if [[ -f "$APP/Contents/MacOS/ulsd" ]]; then sign --entitlements "$ROOT/entitlements/daemon.plist" "$APP/Contents/MacOS/ulsd"; fi
sign --entitlements "$ROOT/entitlements/app.plist" "$APP"
codesign --verify --deep --strict "$APP"
echo "SIGN PASS: bundle verified ($([[ "$IDENTITY" == - ]] && echo ad-hoc || echo Developer-ID))"
