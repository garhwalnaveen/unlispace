#!/bin/bash
set -euo pipefail
engine="$(cd "$(dirname "$0")/../.." && pwd)"
scratch="$(mktemp -d /tmp/uls-vfs-native.XXXXXX)"
mountpoint="$scratch/mount"
mkdir "$mountpoint"
# rmdir cannot remove a mounted or nonempty volume after a failed check.
trap 'rmdir "$mountpoint" "$scratch" 2>/dev/null || true' EXIT
binary="${SMB_DEMO:-$engine/target/debug/smb-demo}"
"$binary" "$mountpoint" --vfs native-test --native-test
