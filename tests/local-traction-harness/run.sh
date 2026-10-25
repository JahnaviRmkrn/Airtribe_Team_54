#!/bin/sh
# No inherited credentials, package hooks, Next server, .env or provider access.
set -eu
mode=${1:-smoke}
case "$mode" in smoke|serve) ;; *) echo 'Usage: run.sh [smoke|serve]'; exit 2;; esac
node_bin=$(command -v node)
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
exec env -i PATH=/usr/bin:/bin NODE_ENV=test TZ=UTC TEAM54_TRACTION_HARNESS_MODE="$mode" \
  TRACTION_SINCE=2026-10-24T00:00:00Z TRACTION_TEST_DOMAINS=example.com TRACTION_TEAM_NAMES=FixtureTeam \
  "$node_bin" node_modules/vitest/vitest.mjs run --config tests/local-traction-harness/vitest.config.mjs --configLoader native --no-cache
