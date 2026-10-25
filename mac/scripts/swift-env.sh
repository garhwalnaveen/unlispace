#!/usr/bin/env bash
# Workspace-local caches also work on restricted CLT build hosts.
mkdir -p "$ROOT/.build/cache" "$ROOT/.build/config" "$ROOT/.build/security" "$ROOT/.build/clang"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT/.build/clang"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/clang"
SWIFT_OPTIONS=(--disable-sandbox --cache-path "$ROOT/.build/cache" --config-path "$ROOT/.build/config" --security-path "$ROOT/.build/security")
