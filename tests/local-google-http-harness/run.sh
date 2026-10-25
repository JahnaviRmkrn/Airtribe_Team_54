#!/bin/sh
# Test-only: no inherited credentials, package hooks, Next server, or .env loading.
set -eu
mode=${1:-smoke}
case "$mode" in smoke|serve) ;; *) echo 'Usage: run.sh [smoke|serve]'; exit 2;; esac
node_bin=$(command -v node)
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
exec env -i PATH=/usr/bin:/bin NODE_ENV=test TZ=UTC TEAM54_GOOGLE_HTTP_MODE="$mode" \
  "$node_bin" node_modules/vitest/vitest.mjs run --config tests/local-google-http-harness/vitest.config.mjs
