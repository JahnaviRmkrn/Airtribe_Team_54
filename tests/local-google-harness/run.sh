#!/bin/sh
# No inherited credentials, package hooks, servers, browsers, or .env loading.
set -eu
node_bin=$(command -v node)
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
exec env -i PATH=/usr/bin:/bin NODE_ENV=test TZ=UTC \
  "$node_bin" node_modules/vitest/vitest.mjs run --config tests/local-google-harness/vitest.config.mjs
