#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "$ROOT/scripts/test.sh"
bash "$ROOT/scripts/bundle.sh" "$@"
bash "$ROOT/scripts/dmg.sh"
bash "$ROOT/scripts/notarize.sh"
bash "$ROOT/scripts/appcast.sh"
echo 'RELEASE PASS'
