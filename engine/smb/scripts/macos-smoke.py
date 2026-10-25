#!/usr/bin/env python3
"""Exercise the built demo on macOS. All scratch paths stay inside engine/smb/."""
import fcntl
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT / ".tmp" / "macos-smoke"
MOUNT = SCRATCH / "mount"


def run(*args):
    result = subprocess.run([str(a) for a in args], check=True, capture_output=True,
                            text=True, timeout=60)
    print("PASS", args[0], result.stdout.strip(), flush=True)
    return result.stdout


def main():
    SCRATCH.mkdir(parents=True, exist_ok=True)
    MOUNT.mkdir(exist_ok=True)
    lines = queue.Queue()
    log = []
    env = dict(os.environ, RUST_LOG="smb_server=debug,uls_smb=debug")
    process = subprocess.Popen([str(ROOT / "target/debug/smb-demo"), str(MOUNT),
                                "--backend-event-after", "3"], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, env=env)
    def reader():
        for line in process.stdout:
            log.append(line)
            lines.put((time.monotonic(), line))
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    mounted = False
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                _, line = lines.get(timeout=.1)
                if "Mounted at " in line:
                    mounted = True
                    break
            except queue.Empty:
                if process.poll() is not None:
                    break
        if not mounted or not os.path.ismount(MOUNT):
            print("BLOCKED: macOS mount failed; no mounted filesystem operations ran.")
            return 1
        run("ls", "-la", MOUNT)
        assert "Hello from Unlispace" in run("cat", MOUNT / "hello.txt")
        event_time = None
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            try:
                at, line = lines.get(timeout=.1)
                if "BACKEND_EVENT" in line:
                    event_time = at
                    break
            except queue.Empty:
                pass
        assert event_time is not None, "no backend event"
        deadline = event_time + 2
        while not (MOUNT / "backend-arrival.txt").exists() and time.monotonic() < deadline:
            run("ls", MOUNT)
            time.sleep(.1)
        assert (MOUNT / "backend-arrival.txt").exists(), "backend change invisible"
        print("PASS backend change visible", flush=True)
        source = SCRATCH / "input"
        source.write_bytes(b"copy test\n")
        run("cp", source, MOUNT / "f")
        run("cp", MOUNT / "f", SCRATCH / "output")
        assert source.read_bytes() == (SCRATCH / "output").read_bytes()
        run("mv", MOUNT / "f", MOUNT / "moved")
        run("mv", MOUNT / "moved", MOUNT / "f")
        run("mkdir", "-p", MOUNT / "a/b/c")
        run("xattr", "-w", "com.test", "x", MOUNT / "f")
        assert run("xattr", "-p", "com.test", MOUNT / "f").strip() == "x"
        run("dd", "if=/dev/urandom", f"of={source}", "bs=1m", "count=50")
        run("cp", source, MOUNT / "large")
        assert run("shasum", source).split()[0] == run("shasum", MOUNT / "large").split()[0]
        for operation in ("flock", "lockf"):
            with open(MOUNT / "f", "r+b") as handle:
                lock = getattr(fcntl, operation)
                lock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                code = ("import fcntl,sys; f=open(sys.argv[1], 'r+b'); "
                        f"fcntl.{operation}(f, fcntl.LOCK_EX|fcntl.LOCK_NB)")
                probe = subprocess.run([sys.executable, "-c", code, str(MOUNT / "f")],
                                       capture_output=True, timeout=5)
                assert probe.returncode != 0, f"{operation}: conflicting lock succeeded"
                lock(handle, fcntl.LOCK_UN)
            print("PASS", operation, flush=True)
        run("rm", MOUNT / "f", MOUNT / "large")
        process.send_signal(signal.SIGINT)
        assert process.wait(timeout=15) == 0
        assert not os.path.ismount(MOUNT), "still mounted"
        mounted = False
        print("PASS unmount", flush=True)
        return 0
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                if os.path.ismount(MOUNT):
                    print("Unmount failed; preserving running server and mountpoint.")
                else:
                    process.terminate()
                    process.wait(timeout=5)
        thread.join(timeout=1)
        (ROOT / ".tmp/macos-smoke.log").write_text("".join(log))
        print("".join(log), end="")
        for name in ("input", "output"):
            (SCRATCH / name).unlink(missing_ok=True)
        if not os.path.ismount(MOUNT) and MOUNT.exists():
            MOUNT.rmdir()
        if SCRATCH.exists() and not any(SCRATCH.iterdir()):
            SCRATCH.rmdir()


if __name__ == "__main__":
    raise SystemExit(main())
