#!/bin/sh
# No .env, user profile, inherited credentials, package install, or package hooks.
set -eu
mode=${1:-smoke}
receipts=${2:-legacy}
case "$mode" in smoke|serve|verify) ;; *) echo 'Use: run.sh [smoke|serve|verify] [legacy|receipts]'; exit 2;; esac
case "$receipts" in legacy) enabled=false;; receipts) enabled=true;; *) echo 'Use: run.sh [smoke|serve|verify] [legacy|receipts]'; exit 2;; esac
node_bin=$(command -v node)
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
exec env -i PATH=/usr/bin:/bin NODE_ENV=test TEAM54_ORGANIZER_HARNESS_MODE="$mode" CONTACT_CREATE_RETRY_ENABLED="$enabled" \
  "$node_bin" node_modules/vitest/vitest.mjs run --config tests/local-organizer-harness/vitest.config.mjs
