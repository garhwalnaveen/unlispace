#!/bin/bash
set -eu
exec python3 -I "$(cd "$(dirname "$0")" && pwd)/macos-smoke.py"
