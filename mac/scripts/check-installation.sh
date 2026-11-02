#!/usr/bin/env bash
# Registers an isolated copy of the bundled LaunchAgent, checks RPC, then unregisters it.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Orbit.app}"
WORK="$(mktemp -d /tmp/uls-install.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
PROBE="$WORK/Probe.app"
mkdir -p "$PROBE/Contents/MacOS" "$PROBE/Contents/Library/LaunchAgents"
cp "$APP/Contents/MacOS/ulsd" "$PROBE/Contents/MacOS/ulsd"
python3 - "$APP" "$PROBE" "$WORK" <<'PY'
import pathlib, plistlib, sys, uuid
app, probe, work = map(pathlib.Path, sys.argv[1:])
label = 'com.orbit.install-test.' + uuid.uuid4().hex
info = {'CFBundleIdentifier': label, 'CFBundleName': 'Orbit installation check', 'CFBundleExecutable': 'Probe', 'CFBundleVersion': '1', 'CFBundlePackageType': 'APPL'}
(probe/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
agent = plistlib.loads((app/'Contents/Library/LaunchAgents/com.orbit.ulsd.plist').read_bytes())
assert agent['BundleProgram'] == 'Contents/MacOS/ulsd'
agent['Label'] = label
agent['ProgramArguments'] = ['Contents/MacOS/ulsd', 'daemon', '--state-dir', str(work/'state'), '--socket', str(work/'ulsd.sock'), '--secret-store', 'memory']
(probe/'Contents/Library/LaunchAgents/com.orbit.ulsd.plist').write_bytes(plistlib.dumps(agent))
PY
cat > "$WORK/main.swift" <<'SWIFT'
import Foundation
import ServiceManagement
import Darwin
func check() throws {
    let service = SMAppService.agent(plistName: "com.orbit.ulsd.plist")
    var registered = false
    defer {
        if registered {
            do {
                let completion = UnregisterCompletion()
                service.unregister(completionHandler: { error in completion.finish(error) })
                try completion.wait(timeout: 15)
                print("PASS unregister and reap isolated LaunchAgent")
            }
            catch { fputs("FAIL unregister: \(error)\n", stderr); exit(1) }
        }
    }
    try service.register()
    registered = true
    guard service.status == .enabled else {
        throw NSError(domain: "OrbitInstallation", code: Int(service.status.rawValue), userInfo: [NSLocalizedDescriptionKey: "Background service needs macOS approval; no permission was changed automatically."])
    }
    print("PASS registered isolated LaunchAgent")
    let socket = ProcessInfo.processInfo.environment["ULS_INSTALL_TEST_SOCKET"]!
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: socket) { break }
        Thread.sleep(forTimeInterval: 0.1)
    }
    // A stale socket or enabled registration does not establish that the helper is alive.
    let rpc = Process()
    rpc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    rpc.arguments = ["-c", """
import json, socket, sys, time
with socket.socket(socket.AF_UNIX) as s:
    s.settimeout(5)
    s.connect(sys.argv[1])
    stream = s.makefile('r')
    for i, method in enumerate(('status', 'auth.status'), 1):
        s.sendall((json.dumps({'id': i, 'method': method}) + '\\n').encode())
        deadline = time.monotonic() + 5
        while True:
            s.settimeout(max(0.001, deadline - time.monotonic()))
            response = json.loads(stream.readline())
            if response.get('id') == i:
                break
            assert time.monotonic() < deadline, 'RPC response timed out'
        assert 'error' not in response, 'RPC failed'
        result = response['result']
        if method == 'status':
            assert result['state'] == 'signed_out' and result['version'], 'Unexpected engine status'
        else:
            assert result['signedIn'] is False, 'Isolated probe must be signed out'
print('PASS bundled engine answered status and auth.status RPC')
""", socket]
    try rpc.run()
    rpc.waitUntilExit()
    guard rpc.terminationStatus == 0 else {
        throw NSError(domain: "OrbitInstallation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bundled engine did not answer isolated RPC"])
    }
}
do { try check() } catch { fputs("FAIL \(error.localizedDescription)\n", stderr); exit(1) }
SWIFT
swiftc "$WORK/main.swift" "$ROOT/Sources/OrbitKit/UnregisterCompletion.swift" -o "$PROBE/Contents/MacOS/Probe"
# Keep the shipped helper signature: re-signing it here would mask packaging failures.
codesign --verify --strict "$PROBE/Contents/MacOS/ulsd"
codesign --force --sign - --timestamp=none "$PROBE"
ULS_INSTALL_TEST_SOCKET="$WORK/ulsd.sock" "$PROBE/Contents/MacOS/Probe"
echo 'INSTALLATION PASS: isolated registration, engine RPC and unregistration (installed upgrade still requires acceptance)'
