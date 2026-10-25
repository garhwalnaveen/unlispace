#!/usr/bin/env bash
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d /tmp/unlispace-e2e.XXXXXX)
work=$(cd "$work" && pwd -P)
runner=
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$runner" ]]; then
    kill -TERM "$runner" 2>/dev/null || true
    wait "$runner" 2>/dev/null || true
  fi
  # Never recurse through a mount, including when the Node runner was interrupted.
  if /sbin/mount | grep -Fq " on $work/mount ("; then
    /sbin/umount "$work/mount" || { echo 'FAIL  cleanup: unmount failed; temporary directory retained'; exit 1; }
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$here/harness.mjs" "$work" &
runner=$!
wait "$runner"
runner=
