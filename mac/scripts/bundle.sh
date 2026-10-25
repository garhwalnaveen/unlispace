#!/usr/bin/env bash
# Assembles build/Unlispace.app from the SwiftPM release binary and ad-hoc signs it.
# Does not launch the app or register anything with the system.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/swift-env.sh"

API_ENDPOINT="${ULS_API_URL:-}"
if [[ -z "$API_ENDPOINT" && -n "${ULS_WORKERS_DOMAIN:-}" ]]; then
  API_ENDPOINT="https://unlispace-api.${ULS_WORKERS_DOMAIN}"
fi

swift build "${SWIFT_OPTIONS[@]}" -c release "$@"
BIN="$(swift build "${SWIFT_OPTIONS[@]}" -c release --show-bin-path "$@")/Unlispace"

APP="$ROOT/build/Unlispace.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Library/LaunchAgents"
cp "$BIN" "$APP/Contents/MacOS/Unlispace"
FRAMEWORK="$(find "$ROOT/.build/artifacts" -type d -path '*/macos-arm64_x86_64/Sparkle.framework' -print -quit)"
if [[ -z "$FRAMEWORK" ]]; then echo "Sparkle framework missing from resolved artifacts" >&2; exit 1; fi
mkdir -p "$APP/Contents/Frameworks"
ditto "$FRAMEWORK" "$APP/Contents/Frameworks/Sparkle.framework"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.unlispace.app</string>
  <key>CFBundleName</key><string>Unlispace</string>
  <key>CFBundleDisplayName</key><string>Unlispace</string>
  <key>CFBundleExecutable</key><string>Unlispace</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.unlispace.app.auth</string>
      <key>CFBundleURLSchemes</key>
      <array><string>uls</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

if [[ -n "$API_ENDPOINT" ]]; then
  /usr/libexec/PlistBuddy -c "Add :UnlispaceAPIEndpoint string $API_ENDPOINT" "$APP/Contents/Info.plist"
fi

# LaunchAgent plist for SMAppService.agent(plistName:). BundleProgram is relative to the bundle.
cat > "$APP/Contents/Library/LaunchAgents/com.unlispace.ulsd.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.unlispace.ulsd</string>
  <key>BundleProgram</key><string>Contents/MacOS/ulsd</string>
  <key>ProgramArguments</key>
  <array><string>Contents/MacOS/ulsd</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST

# Optional: use a real engine binary if provided (ULSD_BIN=/path/to/ulsd). Otherwise none is
# placed and the app shows "engine not installed".
if [[ -n "${ULSD_BIN:-}" ]]; then
  [[ -x "$ULSD_BIN" ]] || { echo "ULSD_BIN is not executable" >&2; exit 1; }
  cp "$ULSD_BIN" "$APP/Contents/MacOS/ulsd"
fi

plutil -lint "$APP/Contents/Library/LaunchAgents/com.unlispace.ulsd.plist"

python3 - "$APP/Contents/Info.plist" <<'PYPLIST'
import os, plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as f: info = plistlib.load(f)
info['CFBundleShortVersionString'] = os.environ.get('ULS_VERSION', '0.2.0')
info['CFBundleVersion'] = os.environ.get('ULS_BUILD', '1')
feed, key = os.environ.get('ULS_SU_FEED_URL'), os.environ.get('ULS_SU_PUBLIC_ED_KEY')
if feed and key:
    if not feed.startswith('https://'): raise SystemExit('ULS_SU_FEED_URL must use HTTPS')
    info['SUFeedURL'], info['SUPublicEDKey'] = feed, key
    info['SUEnableInstallerLauncherService'] = True
    info['SUEnableDownloaderService'] = True
with open(path, 'wb') as f: plistlib.dump(info, f)
PYPLIST
plutil -lint "$APP/Contents/Info.plist"
otool -L "$APP/Contents/MacOS/Unlispace" | grep -Fq '@rpath/Sparkle.framework/'
otool -l "$APP/Contents/MacOS/Unlispace" | grep -Fq '@executable_path/../Frameworks'
bash "$ROOT/scripts/sign.sh" "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP"
