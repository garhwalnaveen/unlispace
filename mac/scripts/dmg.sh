#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Unlispace.app}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release version' >&2; exit 1; }
DMG="$ROOT/build/Unlispace-$VERSION.dmg"
STAGE="$(mktemp -d "$ROOT/build/dmg-stage.XXXXXX")"
MOUNT="$(mktemp -d /tmp/uls-dmg.XXXXXX)"
ATTACHED=0
cleanup() {
  if [[ "$ATTACHED" == 1 ]]; then hdiutil detach "$MOUNT" >/dev/null; fi
  rm -rf "$STAGE" "$MOUNT"
}
trap cleanup EXIT
codesign --verify --deep --strict "$APP"
ditto "$APP" "$STAGE/Unlispace.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -ov -format UDZO -volname "Unlispace $VERSION" -srcfolder "$STAGE" "$DMG"
if [[ -n "${ULS_SIGN_IDENTITY:-}" ]]; then codesign --force --timestamp --sign "$ULS_SIGN_IDENTITY" "$DMG"; fi
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG"
ATTACHED=1
[[ -d "$MOUNT/Unlispace.app" && -L "$MOUNT/Applications" ]]
# UDZO is a read-only compressed image; confirm the attached filesystem as well.
python3 -c 'import os,sys; assert os.statvfs(sys.argv[1]).f_flag & os.ST_RDONLY, "DMG is writable"' "$MOUNT"
codesign --verify --deep --strict "$MOUNT/Unlispace.app"
hdiutil detach "$MOUNT"
ATTACHED=0
echo "DMG PASS: $DMG (read-only mount, app signature, Applications link, detached)"
