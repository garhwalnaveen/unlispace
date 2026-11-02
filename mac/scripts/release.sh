#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for name in ULSD_BIN ULS_VERSION ULS_BUILD; do
  [[ -n "${!name:-}" ]] || { echo "Release requires $name" >&2; exit 1; }
done
if [[ -n "${ULS_SIGN_IDENTITY:-}" || -n "${ULS_NOTARY_PROFILE:-}" ]]; then
  [[ -n "${ULS_SIGN_IDENTITY:-}" && "$ULS_SIGN_IDENTITY" != - && -n "${ULS_NOTARY_PROFILE:-}" ]] || { echo 'Signed releases require both a Developer ID identity and notary profile' >&2; exit 1; }
fi
[[ -x "$ULSD_BIN" ]] || { echo 'Release requires an executable engine' >&2; exit 1; }
[[ -n "${ULS_API_URL:-}${ULS_WORKERS_DOMAIN:-}" ]] || { echo 'Release requires a production API endpoint' >&2; exit 1; }
python3 - <<'PYURL'
import os, urllib.parse
url = os.environ.get('ULS_API_URL') or 'https://orbit-api.' + os.environ.get('ULS_WORKERS_DOMAIN', '')
u = urllib.parse.urlparse(url)
if u.scheme != 'https' or not u.hostname or u.hostname in ('localhost', '127.0.0.1') or u.username or u.password or u.query or u.fragment:
    raise SystemExit('Release requires a valid HTTPS production API endpoint')
PYURL
bash "$ROOT/scripts/test.sh"
bash "$ROOT/scripts/bundle.sh" "$@"
bash "$ROOT/scripts/check-installation.sh"
bash "$ROOT/scripts/dmg.sh"
if [[ -n "${ULS_SIGN_IDENTITY:-}" ]]; then
  bash "$ROOT/scripts/notarize.sh"
  bash "$ROOT/scripts/appcast.sh"
else
  echo 'Unsigned DMG: macOS Gatekeeper will require the user to allow the app.'
fi
shasum -a 256 "$ROOT/build/Orbit-${ULS_VERSION}.dmg" > "$ROOT/build/Orbit-${ULS_VERSION}.dmg.sha256"
echo 'RELEASE PASS: installer and SHA-256 manifest created'
