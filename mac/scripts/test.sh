#!/usr/bin/env bash
# Runs `swift test` on a Command Line Tools-only machine, where Testing.framework
# lives outside the default search paths. With full Xcode, plain `swift test` works.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/swift-env.sh"
# Keychain access is opt-in; distribution gates must never touch it.
KEYCHAIN_OPTIONS=()
if [[ "${ULS_TEST_KEYCHAIN:-0}" != 1 ]]; then
  KEYCHAIN_OPTIONS=(--skip "KeychainTests|HandoffTests")
fi
CLT=/Library/Developer/CommandLineTools/Library/Developer
exec swift test "${SWIFT_OPTIONS[@]}" ${KEYCHAIN_OPTIONS[@]+"${KEYCHAIN_OPTIONS[@]}"} \
  -Xswiftc -F"$CLT/Frameworks" \
  -Xlinker -F"$CLT/Frameworks" \
  -Xlinker -rpath -Xlinker "$CLT/Frameworks" \
  -Xlinker -rpath -Xlinker "$CLT/usr/lib" "$@"
