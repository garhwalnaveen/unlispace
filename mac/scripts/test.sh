#!/usr/bin/env bash
# Runs Swift tests with the Testing framework from the selected developer toolchain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/swift-env.sh"
# Keychain access is opt-in; distribution gates must never touch it.
KEYCHAIN_OPTIONS=()
if [[ "${ULS_TEST_KEYCHAIN:-0}" != 1 ]]; then
  KEYCHAIN_OPTIONS=(--skip "KeychainTests|HandoffTests")
fi
DEVELOPER_ROOT="${DEVELOPER_DIR:-$(xcode-select -p)}"
if [[ -d "$DEVELOPER_ROOT/Platforms/MacOSX.platform" ]]; then
  exec swift test "${SWIFT_OPTIONS[@]}" ${KEYCHAIN_OPTIONS[@]+"${KEYCHAIN_OPTIONS[@]}"} "$@"
fi
CLT="$DEVELOPER_ROOT/Library/Developer"
exec swift test "${SWIFT_OPTIONS[@]}" ${KEYCHAIN_OPTIONS[@]+"${KEYCHAIN_OPTIONS[@]}"} \
  -Xswiftc -F"$CLT/Frameworks" \
  -Xlinker -F"$CLT/Frameworks" \
  -Xlinker -rpath -Xlinker "$CLT/Frameworks" \
  -Xlinker -rpath -Xlinker "$CLT/usr/lib" "$@"
