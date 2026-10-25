#!/usr/bin/env python3
"""Strict native SMB checks; scratch lives under /tmp for NetFS."""
import ctypes
import errno
import ctypes.util
import fcntl
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "verification/native-server.log"


_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
_libc.setxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                           ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
_libc.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                           ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
_libc.getxattr.restype = ctypes.c_ssize_t


def setxattr(path, name, value):
    if _libc.setxattr(os.fsencode(path), name.encode(), value, len(value), 0, 0) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), str(path))


def getxattr(path, name):
    size = _libc.getxattr(os.fsencode(path), name.encode(), None, 0, 0, 0)
    if size < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), str(path))
    buf = ctypes.create_string_buffer(max(size, 1))
    n = _libc.getxattr(os.fsencode(path), name.encode(), buf, size, 0, 0)
    if n < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), str(path))
    return buf.raw[:n]


def run(*args):
    return subprocess.run([str(a) for a in args], check=True, capture_output=True,
                          text=True, timeout=60).stdout


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def lock_conflict(path, operation):
    """Only EACCES/EAGAIN from a second process proves lock contention."""
    lock = getattr(fcntl, operation)
    args = (10, 0) if operation == "lockf" else ()
    with path.open("r+b") as handle:
        lock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB, *args)
        probe = r'''
import errno, fcntl, sys
with open(sys.argv[1], 'r+b') as f:
    args = (10, 0) if sys.argv[2] == 'lockf' else ()
    try:
        getattr(fcntl, sys.argv[2])(f, fcntl.LOCK_EX | fcntl.LOCK_NB, *args)
    except OSError as e:
        if e.errno in (errno.EACCES, errno.EAGAIN):
            sys.exit(0)
        raise
    raise AssertionError('conflicting lock succeeded')
'''
        try:
            run(sys.executable, "-I", "-c", probe, path, operation)
        finally:
            lock(handle, fcntl.LOCK_UN, *args)
    run(sys.executable, "-I", "-c",
        "import fcntl,sys; f=open(sys.argv[1],'r+b'); "
        f"fcntl.{operation}(f,fcntl.LOCK_EX|fcntl.LOCK_NB"
        + (",10,0)" if args else ")"), path)


def main():
    scratch = Path(tempfile.mkdtemp(prefix="uls-smb-native-", dir="/tmp"))
    mount = scratch / "mount"
    mount.mkdir()
    LOG.parent.mkdir(exist_ok=True)
    ok = bad = 0
    xfails = []

    def check(name, operation):
        nonlocal ok, bad
        try:
            operation()
            ok += 1
            print("PASS ", name, flush=True)
        except (OSError, AssertionError, subprocess.SubprocessError) as error:
            bad += 1
            detail = getattr(error, "stderr", None) or str(error)
            print(f"FAIL  {name}: {detail.strip()}", flush=True)

    env = dict(os.environ)
    env.setdefault("RUST_LOG", "smb_server=debug,uls_smb=debug")
    process = None
    try:
        with LOG.open("w") as log:
            process = subprocess.Popen(
                [str(ROOT / "target/debug/smb-demo"), str(mount)], cwd=ROOT,
                stdout=log, stderr=subprocess.STDOUT, env=env)
            deadline = time.monotonic() + 20
            while not os.path.ismount(mount) and process.poll() is None and time.monotonic() < deadline:
                time.sleep(.1)
            check("native mount (no sudo, no prompt)",
                  lambda: require(os.path.ismount(mount), "mount failed before filesystem checks"))
            if not os.path.ismount(mount):
                print(LOG.read_text(), end="", flush=True)
                return 1

            file = mount / "a.txt"
            check("ls -la", lambda: run("ls", "-la", mount))

            def write_read():
                file.write_text("hello smb\n")
                require(run("cat", file) == "hello smb\n", "contents differ")
            check("write + cat", write_read)

            def copy():
                run("cp", file, mount / "b.txt")
                require((mount / "b.txt").read_bytes() == file.read_bytes(), "copy differs")
            check("cp in", copy)

            def rename():
                run("mv", mount / "b.txt", mount / "c.txt")
                require((mount / "c.txt").is_file() and not (mount / "b.txt").exists(), "rename failed")
            check("mv", rename)

            def remove():
                run("rm", mount / "c.txt")
                require(not (mount / "c.txt").exists(), "file still present")
            check("rm", remove)

            def mkdir():
                run("mkdir", "-p", mount / "x/y/z")
                require((mount / "x/y/z").is_dir(), "directory missing")
            check("mkdir -p", mkdir)

            def xattr():
                for value in ("hello", "x"):
                    run("xattr", "-w", "com.test", value, file)
                    require(run("xattr", "-p", "com.test", file).strip() == value, "xattr differs")
            check("xattr write/read + shorter overwrite", xattr)

            resource = b"Unlispace resource fork\x00\xff"

            def resource_fork():
                setxattr(file, "com.apple.ResourceFork", resource)
                require(getxattr(file, "com.apple.ResourceFork") == resource, "resource fork differs")
            check("com.apple.ResourceFork write/read", resource_fork)

            # Local seeding keeps these checks independent of native setxattr.
            source = scratch / "metadata-source"
            source.write_bytes(b"copy with metadata\n")
            setxattr(source, "com.test", b"copy attribute")
            setxattr(source, "com.apple.ResourceFork", resource)

            def preserve(command):
                destination = mount / f"{command}-metadata"
                output = scratch / f"{command}-output"
                args = ("cp", "-p") if command == "cp" else ("ditto", "--rsrc", "--extattr")
                run(*args, source, destination)
                run(*args, destination, output)
                for path in (destination, output):
                    require(path.read_bytes() == source.read_bytes(), "data differs")
                    for name in ("com.test", "com.apple.ResourceFork"):
                        require(getxattr(path, name) == getxattr(source, name), f"{name} differs")
            check("cp -p preserves xattrs + resource fork in/out", lambda: preserve("cp"))
            check("ditto preserves xattrs + resource fork in/out", lambda: preserve("ditto"))

            def large_io():
                source = scratch / "large-source"
                try:
                    run("dd", "if=/dev/urandom", f"of={source}", "bs=1m", "count=50")
                    run("dd", f"if={source}", f"of={mount / 'big.bin'}", "bs=1m")
                    require(run("shasum", "-a", "256", source).split()[0]
                            == run("shasum", "-a", "256", mount / "big.bin").split()[0], "SHA-256 differs")
                finally:
                    source.unlink(missing_ok=True)
            check("50 MiB dd write + shasum read-back", large_io)
            check("flock: second process conflict + release", lambda: lock_conflict(file, "flock"))

            def lockf_limit():
                """XFAIL: smbfs never enables POSIX fcntl locks (vnops.c:5788)."""
                try:
                    lock_conflict(file, "lockf")
                except OSError as error:
                    require(error.errno == errno.ENOTSUP, f"unexpected errno {error.errno}")
                    return
                except subprocess.CalledProcessError as error:
                    require("Errno 45" in (error.stderr or ""), "unexpected lockf failure")
                    return
                raise AssertionError("lockf unexpectedly worked; promote this to a real check")
            xfails.append("lockf byte range (macOS smbfs client limitation, ENOTSUP)")
            check("lockf byte range: ENOTSUP from smbfs, no LOCK sent (known XFAIL)", lockf_limit)

            def safe_save():
                (mount / "save.txt").write_text("v1")
                (mount / ".save.tmp").write_text("v2")
                os.replace(mount / ".save.tmp", mount / "save.txt")
                require((mount / "save.txt").read_text() == "v2", "replacement differs")
            check("safe-save replace (rename over existing)", safe_save)

            def unmount():
                process.send_signal(signal.SIGINT)
                require(process.wait(timeout=20) == 0, "demo exited with failure")
                require(not os.path.ismount(mount), "still mounted")
            check("unmount on Ctrl-C", unmount)
        return int(bad != 0)
    finally:
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                if os.path.ismount(mount):
                    print(f"NEEDS: release open files; preserving server PID {process.pid} and {scratch}")
                else:
                    process.terminate()
                    process.wait(timeout=5)
        if not os.path.ismount(mount):
            shutil.rmtree(scratch)
        print(f"RESULT: {ok} passed, {bad} failed (of which known client-limitation XFAILs: "
              f"{len(xfails)})", flush=True)
        if LOG.exists():
            warnings = sum("warn" in line.lower() or "error" in line.lower()
                           for line in LOG.read_text().splitlines())
            print(f"server log error/warn lines: {warnings}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
