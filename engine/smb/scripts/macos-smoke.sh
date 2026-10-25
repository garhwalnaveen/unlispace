#!/bin/bash
set -u
D=/Users/naveen/unlispace/engine/smb/target/debug/smb-demo
MP=$(mktemp -d /tmp/uls-smb-mp.XXXX); LOG=/tmp/uls-smbt/server.log
ok=0; bad=0; pass(){ echo "PASS  $1"; ok=$((ok+1)); }; fail(){ echo "FAIL  $1"; bad=$((bad+1)); }
"$D" "$MP" > $LOG 2>&1 & SP=$!
for i in $(seq 1 40); do mount | grep -q " on $(realpath $MP) " && break; sleep 0.5; done
mount | grep -q " on $(realpath $MP) " && pass "mount_smbfs via NetFS (no sudo, no prompt)" || { fail "mount"; tail -20 $LOG; kill $SP; exit 1; }
cd "$MP"
ls -la > /dev/null && pass "ls -la ($(ls | wc -l | tr -d ' ') seeded entries)" || fail "ls"
echo "hello smb" > a.txt && [ "$(cat a.txt)" = "hello smb" ] && pass "write + cat" || fail "write/cat"
cp a.txt b.txt && cmp -s a.txt b.txt && pass "cp in" || fail "cp"
mv b.txt c.txt && [ -f c.txt ] && [ ! -e b.txt ] && pass "mv" || fail "mv"
rm c.txt && [ ! -e c.txt ] && pass "rm" || fail "rm"
mkdir -p x/y/z && [ -d x/y/z ] && pass "mkdir -p" || fail "mkdir -p"
xattr -w com.test hello a.txt 2>/tmp/uls-smbt/xa.err && [ "$(xattr -p com.test a.txt 2>/dev/null)" = hello ] && pass "xattr write/read" || fail "xattr: $(cat /tmp/uls-smbt/xa.err)"
head -c 52428800 /dev/urandom > /tmp/uls-smbt/src.bin
dd if=/tmp/uls-smbt/src.bin of=big.bin bs=1m 2>/dev/null; s1=$(shasum -a 256 /tmp/uls-smbt/src.bin | cut -c1-64); s2=$(shasum -a 256 big.bin | cut -c1-64)
[ "$s1" = "$s2" ] && pass "50 MiB dd write + shasum read-back" || fail "50MiB hash mismatch"
python3 -I -c "import fcntl,sys;f=open(sys.argv[1],'r+');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(f,fcntl.LOCK_UN);print('ok')" a.txt >/dev/null 2>&1 && pass "flock" || fail "flock"
python3 -I -c "import fcntl,sys;f=open(sys.argv[1],'r+');fcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB,10,0);fcntl.lockf(f,fcntl.LOCK_UN,10,0)" a.txt >/dev/null 2>&1 && pass "lockf byte range" || fail "lockf"
echo v1 > save.txt; echo v2 > .save.tmp && mv -f .save.tmp save.txt && [ "$(cat save.txt)" = v2 ] && pass "safe-save replace (rename over existing)" || fail "safe-save"
cd /; rm -f /tmp/uls-smbt/src.bin
kill -INT $SP; for i in $(seq 1 20); do mount | grep -q " on $(realpath $MP 2>/dev/null) " || break; sleep 0.5; done
mount | grep -q "uls-smb-mp" && { fail "unmount"; umount -f "$MP"; } || pass "unmount on Ctrl-C"
wait $SP 2>/dev/null; rmdir "$MP" 2>/dev/null
echo "RESULT: $ok passed, $bad failed"; grep -ciE 'error|warn' $LOG | xargs echo "server log error/warn lines:"
