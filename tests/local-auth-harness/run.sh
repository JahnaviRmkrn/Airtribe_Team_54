#!/bin/sh
# No .env files, inherited credentials, package scripts/hooks, or external services.
set -eu
mode=${1:-smoke}
case "$mode" in smoke|serve|proxy-serve|proxy-smoke) ;; *) echo 'Use: run.sh [smoke|serve|proxy-serve|proxy-smoke]'; exit 2;; esac
node_bin=$(command -v node)
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
exec env -i PATH=/usr/bin:/bin NODE_ENV=test "$node_bin" "tests/local-auth-harness/$mode.mjs"
