#!/usr/bin/env bash
# Assembles build/Unlispace.app from the SwiftPM release binary and ad-hoc signs it.
# Does not launch the app or register anything with the system.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

swift build -c release
BIN="$(swift build -c release --show-bin-path)/Unlispace"

APP="$ROOT/build/Unlispace.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Library/LaunchAgents"
cp "$BIN" "$APP/Contents/MacOS/Unlispace"

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
if [[ -n "${ULSD_BIN:-}" && -x "$ULSD_BIN" ]]; then
  cp "$ULSD_BIN" "$APP/Contents/MacOS/ulsd"
fi

plutil -lint "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Library/LaunchAgents/com.unlispace.ulsd.plist"

codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP"
