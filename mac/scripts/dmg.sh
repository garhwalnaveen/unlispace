#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Orbit.app}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release version' >&2; exit 1; }
DMG="$ROOT/build/Orbit-$VERSION.dmg"
MOUNT="$(mktemp -d /tmp/uls-dmg.XXXXXX)"
ATTACHED=0
cleanup() {
  if [[ "$ATTACHED" == 1 ]]; then hdiutil detach "$MOUNT" >/dev/null; fi
  rmdir "$MOUNT"
}
trap cleanup EXIT
codesign --verify --deep --strict "$APP"
dmgbuild -s "$ROOT/resources/installer.py" -D "app=$APP" -D "assets=$ROOT/resources" Orbit "$DMG"
if [[ -n "${ULS_SIGN_IDENTITY:-}" ]]; then codesign --force --timestamp --sign "$ULS_SIGN_IDENTITY" "$DMG"; fi
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG"
ATTACHED=1
[[ -d "$MOUNT/Orbit.app" && "$(readlink "$MOUNT/Applications")" == /Applications ]]
[[ -s "$MOUNT/.VolumeIcon.icns" && -s "$MOUNT/.DS_Store" ]]
[[ -s "$MOUNT/.background.tiff" || -s "$MOUNT/.background.png" ]]
[[ "$(xcrun GetFileInfo -a "$MOUNT")" == *C* ]]
# UDZO is a read-only compressed image; confirm the attached filesystem as well.
python3 -c 'import os,sys; assert os.statvfs(sys.argv[1]).f_flag & os.ST_RDONLY, "DMG is writable"' "$MOUNT"
codesign --verify --deep --strict "$MOUNT/Orbit.app"
hdiutil detach "$MOUNT"
ATTACHED=0
echo "DMG PASS: $DMG (read-only mount, app signature, Finder layout, custom icon, Applications link)"
