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
[[ -n "${ULS_API_URL:-}" ]] || { echo 'Release requires ULS_API_URL for the production API endpoint' >&2; exit 1; }
python3 - <<'PYURL'
import os, urllib.parse
url = os.environ['ULS_API_URL']
u = urllib.parse.urlparse(url)
host = (u.hostname or '').rstrip('.')
if u.scheme != 'https' or not host or host in ('localhost', '127.0.0.1', '::1') or host.endswith('.workers.dev') or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment:
    raise SystemExit('Release requires a public HTTPS API origin on a custom domain')
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
(cd "$ROOT/build" && shasum -a 256 "Orbit-${ULS_VERSION}.dmg" > "Orbit-${ULS_VERSION}.dmg.sha256")
echo 'RELEASE PASS: installer and SHA-256 manifest created'
