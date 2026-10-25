#!/bin/sh
# No .env, user profile, inherited credentials, package install, or package hooks.
set -eu
mode=${1:-smoke}
case "$mode" in smoke|serve) ;; *) echo 'Use: run.sh [smoke|serve]'; exit 2;; esac
node_bin=$(command -v node)
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
exec env -i PATH=/usr/bin:/bin NODE_ENV=test TEAM54_LOCAL_HARNESS_MODE="$mode" \
  "$node_bin" node_modules/vitest/vitest.mjs run --config tests/local-room-harness/vitest.config.mjs
