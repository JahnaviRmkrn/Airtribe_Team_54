# Scoped PostCSS build-pipeline hardening

The root pnpm workspace overrides only `next@15.5.28>postcss` to `8.5.31`.
The frozen lock replaces Next's `8.4.31` edge and removes the obsolete package;
other dependency edges, `pnpm@11.24.0`, and desktop/mobile npm workflows stay
unchanged. This is not a global PostCSS override.

[PostCSS advisory GHSA-fxqj-rqcc-2cmp](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp)
identifies `8.5.23` as the fix for external `.map` reads when `from` is unset.
The risk is conditional: an attacker must influence CSS processed by an affected
pipeline, and generated source maps must expose the loaded data. This change
hardens that build-processing boundary; it does not establish a reachable
production-request exploit in this application.

`tests/postcss-source-map-boundary.test.mjs` resolves PostCSS through Next's own
dependency path and requires stable 8.x at least `8.5.23` (currently `8.5.31`).
It checks no-base and outside-base map rejection, plus normal styling and a
valid in-tree map. Every map contains a synthetic marker inside a temporary
directory owned and cleaned by the test. No credentials or real external maps
are inspected.

After a frozen install, run:

```sh
node node_modules/vitest/vitest.mjs run tests/postcss-source-map-boundary.test.mjs --maxWorkers=1
```

Reassess this version-specific override when upgrading Next; remove it only
after verifying Next's resolved PostCSS remains patched and these tests pass.
