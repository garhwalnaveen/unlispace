#!/usr/bin/env bash
# Runs `swift test` on a Command Line Tools-only machine, where Testing.framework
# lives outside the default search paths. With full Xcode, plain `swift test` works.
set -euo pipefail
cd "$(dirname "$0")/.."
CLT=/Library/Developer/CommandLineTools/Library/Developer
exec swift test \
  -Xswiftc -F"$CLT/Frameworks" \
  -Xlinker -F"$CLT/Frameworks" \
  -Xlinker -rpath -Xlinker "$CLT/Frameworks" \
  -Xlinker -rpath -Xlinker "$CLT/usr/lib" "$@"
