#!/usr/bin/env bash
# Registers an isolated copy of the bundled LaunchAgent, checks its socket, then unregisters it.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Unlispace.app}"
WORK="$(mktemp -d /tmp/uls-install.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
PROBE="$WORK/Probe.app"
mkdir -p "$PROBE/Contents/MacOS" "$PROBE/Contents/Library/LaunchAgents"
cp "$APP/Contents/MacOS/ulsd" "$PROBE/Contents/MacOS/ulsd"
python3 - "$APP" "$PROBE" "$WORK" <<'PY'
import pathlib, plistlib, sys, uuid
app, probe, work = map(pathlib.Path, sys.argv[1:])
label = 'com.unlispace.install-test.' + uuid.uuid4().hex
info = {'CFBundleIdentifier': label, 'CFBundleName': 'Unlispace installation check', 'CFBundleExecutable': 'Probe', 'CFBundleVersion': '1', 'CFBundlePackageType': 'APPL'}
(probe/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
agent = plistlib.loads((app/'Contents/Library/LaunchAgents/com.unlispace.ulsd.plist').read_bytes())
assert agent['BundleProgram'] == 'Contents/MacOS/ulsd'
agent['Label'] = label
agent['ProgramArguments'] = ['Contents/MacOS/ulsd', 'daemon', '--state-dir', str(work/'state'), '--socket', str(work/'ulsd.sock'), '--secret-store', 'memory']
(probe/'Contents/Library/LaunchAgents/com.unlispace.ulsd.plist').write_bytes(plistlib.dumps(agent))
PY
cat > "$WORK/probe.swift" <<'SWIFT'
import Foundation
import ServiceManagement
import Darwin
func check() throws {
    let service = SMAppService.agent(plistName: "com.unlispace.ulsd.plist")
    var registered = false
    defer {
        if registered {
            do { try service.unregister(); print("PASS unregister isolated LaunchAgent") }
            catch { fputs("FAIL unregister: \(error)\n", stderr); exit(1) }
        }
    }
    try service.register()
    registered = true
    guard service.status == .enabled else {
        throw NSError(domain: "UnlispaceInstallation", code: Int(service.status.rawValue), userInfo: [NSLocalizedDescriptionKey: "Background service needs macOS approval; no permission was changed automatically."])
    }
    print("PASS registered isolated LaunchAgent")
    let socket = ProcessInfo.processInfo.environment["ULS_INSTALL_TEST_SOCKET"]!
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: socket) { print("PASS bundled engine created isolated socket"); return }
        Thread.sleep(forTimeInterval: 0.1)
    }
    throw NSError(domain: "UnlispaceInstallation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Engine did not create its isolated socket"])
}
do { try check() } catch { fputs("FAIL \(error.localizedDescription)\n", stderr); exit(1) }
SWIFT
swiftc "$WORK/probe.swift" -o "$PROBE/Contents/MacOS/Probe"
# Keep the shipped helper signature: re-signing it here would mask packaging failures.
codesign --verify --strict "$PROBE/Contents/MacOS/ulsd"
codesign --force --sign - --timestamp=none "$PROBE"
ULS_INSTALL_TEST_SOCKET="$WORK/ulsd.sock" "$PROBE/Contents/MacOS/Probe"
echo 'INSTALLATION PASS: isolated registration, engine startup and unregistration'
