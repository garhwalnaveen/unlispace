#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -z "${ULS_EDDSA_KEY_FILE:-}" ]]; then echo 'APPCAST SKIP: ULS_EDDSA_KEY_FILE unset'; exit 0; fi
[[ -f "$ULS_EDDSA_KEY_FILE" ]] || { echo 'EdDSA key file missing' >&2; exit 1; }
TOOL="$(find "$ROOT/.build/artifacts" -type f -name generate_appcast -print -quit)"
[[ -n "$TOOL" && -x "$TOOL" ]] || { echo 'Resolved Sparkle artifact lacks generate_appcast' >&2; exit 1; }
# Explicit file avoids Sparkle keychain lookup. Feed directory must contain releases only.
FEED="$ROOT/build/feed"
mkdir -p "$FEED"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/build/Unlispace.app/Contents/Info.plist")"
cp "$ROOT/build/Unlispace-$VERSION.dmg" "$FEED/"
"$TOOL" --ed-key-file "$ULS_EDDSA_KEY_FILE" "$FEED"
echo 'APPCAST PASS: build/feed/appcast.xml generated'
