#!/usr/bin/env bash
# Check the packaged LaunchAgent declaration and run the signed helper in isolation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/build/Orbit.app}"

python3 - "$APP" <<'PY'
import json
import pathlib
import plistlib
import socket
import subprocess
import sys
import tempfile
import time

app = pathlib.Path(sys.argv[1])
agent = plistlib.loads((app / "Contents/Library/LaunchAgents/com.orbit.ulsd.plist").read_bytes())
assert agent["Label"] == "com.orbit.ulsd"
assert agent["BundleProgram"] == "Contents/MacOS/ulsd"
assert agent["ProgramArguments"] == [agent["BundleProgram"], "daemon"]
assert agent["RunAtLoad"] and agent["KeepAlive"]
helper = app / agent["BundleProgram"]
subprocess.run(["codesign", "--verify", "--strict", helper], check=True)
signature = subprocess.check_output(["codesign", "-dv", "--verbose=4", helper], stderr=subprocess.STDOUT, text=True)
fields = dict(line.split("=", 1) for line in signature.splitlines() if "=" in line)
if fields["TeamIdentifier"] != "not set":
    assert agent["SpawnConstraint"] == {
        "team-identifier": fields["TeamIdentifier"], "signing-identifier": fields["Identifier"],
    }
else:
    assert "SpawnConstraint" not in agent

# Only the installed Orbit app should register with ServiceManagement.
with tempfile.TemporaryDirectory(prefix="orbit-check-", dir="/tmp") as tmp:
    state = pathlib.Path(tmp)
    path = str(state / "ulsd.sock")
    with subprocess.Popen([
        helper, "daemon", "--state-dir", state / "state",
        "--socket", path, "--secret-store", "memory",
    ]) as engine:
        try:
            with socket.socket(socket.AF_UNIX) as conn:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        conn.connect(path)
                        break
                    except (FileNotFoundError, ConnectionRefusedError):
                        if engine.poll() is not None or time.monotonic() >= deadline:
                            raise
                        time.sleep(0.05)
                with conn.makefile("rb") as stream:
                    for ident, method in enumerate(("status", "auth.status"), 1):
                        request = json.dumps({"id": ident, "method": method}) + "\n"
                        conn.sendall(request.encode())
                        deadline = time.monotonic() + 5
                        while True:
                            conn.settimeout(max(0.001, deadline - time.monotonic()))
                            response = json.loads(stream.readline())
                            if response.get("id") == ident:
                                break
                            assert time.monotonic() < deadline, f"{method} timed out"
                        assert "error" not in response, f"{method} failed"
                        result = response["result"]
                        if method == "status":
                            assert result["state"] == "signed_out" and result["version"]
                        else:
                            assert result["signedIn"] is False
        finally:
            if engine.poll() is None:
                engine.terminate()
                try:
                    engine.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    engine.kill()
PY
echo 'INSTALLATION PASS: packaged LaunchAgent declaration and signed helper RPC'
