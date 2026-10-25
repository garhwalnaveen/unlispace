#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/Unlispace.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
DMG="${1:-$ROOT/build/Unlispace-$VERSION.dmg}"
if [[ -z "${ULS_NOTARY_PROFILE:-}" ]]; then echo 'NOTARIZE SKIP: ULS_NOTARY_PROFILE unset (ad-hoc mode)'; exit 0; fi
[[ -n "${ULS_SIGN_IDENTITY:-}" ]] || { echo 'Notarization requires ULS_SIGN_IDENTITY' >&2; exit 1; }
xcrun notarytool submit "$DMG" --keychain-profile "$ULS_NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
echo 'NOTARIZE PASS: submitted, stapled and validated'
