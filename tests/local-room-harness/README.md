# Credential-free local room integration harness

This dev-only harness serves the **unchanged checked-in room assets** and dispatches
browser HTTP requests to the **actual Next route functions**, backed by the existing
PGlite PostgreSQL adapter and migrations. It is not a second implementation of the
room API. Nothing is added to `public/`, production routing, app authentication,
or deployment configuration.

## Run without inherited credentials

Use the installed dependencies. Do not install packages, launch Next, load `.env`
files, run secret scripts, or connect a real provider for this test.

```sh
# From your repository checkout root:
./tests/local-room-harness/run.sh smoke
```

For a browser, run this in the **native terminal connected to the browser's
machine**, not a separate executor namespace:

```sh
# From your repository checkout root:
./tests/local-room-harness/run.sh serve
```

When the ready line appears, open:

- Controls: `http://127.0.0.1:4318/__harness/`
- Alice's room: `http://127.0.0.1:4318/m/local_harness_room_alice_0001`
- Bob's room: `http://127.0.0.1:4318/m/local_harness_room_bob_000001`

The launcher resolves the installed Node executable, then invokes Vitest directly
under `env -i` with only `PATH`, `NODE_ENV=test`, and the synthetic harness mode.
No package script or package-manager lifecycle hook is run. Vite's `envDir` is a
new, empty temporary directory, removed on process exit. A credential-like
environment-variable check also fails closed. The separate `.harness.mjs` file
is intentionally not selected by the repository's ordinary test-file pattern.

`serve` first runs the same local HTTP smoke and then resets all fixture data.
It binds **127.0.0.1 only**, on port 4318, with no alternate-host fallback. If that
port is already in use, stop the known earlier harness rather than killing an
unknown process. `smoke` chooses an ephemeral loopback port and closes it on exit.

## Browser exercise

Use synthetic names only. Do not paste real tokens, cookies, credentials, payment
information, personal data, or location into this harness.

1. Choose **Observer / new guest** on the controls page. Open Alice's room and
   check the join form, no organizer controls, and initial shortlist.
2. Join as `Local Browser Guest A`. Save a name, area, budget, food preference,
   and availability. Reload to verify the actual HTTP-only guest cookie persists.
3. Vote for Synthetic Cafe. Click the selected vote to withdraw it, then vote
   again so the organizer has a leading venue to confirm.
4. Use a separate browser profile/private context for another concurrent guest.
   Normal tabs share cookies and do **not** constitute independent guest sessions.
   The automated smoke separately verifies two independent real HTTP cookie jars.
   If independent contexts are unavailable, choose **Observer / new guest** to
   clear this browser's cookie and join as Guest B; this is a sequential test and
   should be reported as such.
5. Choose **Bob fixture organizer** on controls. Alice's room must not show
   organizer controls. Bob is only the owner of Bob's fixture room.
6. Choose **Alice fixture organizer**, then open Alice's room. Confirm the voted
   venue, verify the confirmed banner and disabled voting, and close the room.
7. Choose **Observer / new guest** and reload Alice's room. It stays readable,
   but closed planning no longer offers joining or voting. Existing guest
   mutations also return 410, as covered by the HTTP smoke.
8. **Reset local fixture** creates fresh in-memory room IDs, deletes all old
   synthetic rows, and invalidates all former guest sessions. Reload other room
   tabs after reset. **Stop local server** shuts down the listener and database.

Each role selection clears this browser's guest cookies. The fixture-role cookie
is openly synthetic and only interpreted by this dev harness; it is not a token
or production authentication mechanism. Authorization/Bearer and `x-test-user`
headers cannot select an organizer. The real handlers perform their ownership
checks; owner-scoped writes then run under the adapter's PostgreSQL authenticated
role with transaction-local `auth.uid()`.

## Safety boundaries and what is mocked

- Explicit allowlist of paths and methods. Only the room assets, their checked-in
  local script/icon dependencies, controls, and selected room endpoints are
  served. No repository-directory browsing or arbitrary file serving.
- Host must equal the exact `127.0.0.1:<port>` authority. Foreign Fetch Metadata
  is rejected. All mutations, including controls, require the exact same Origin.
  Reset and stop each require an explicit fixed confirmation value. These are
  local fixture controls, not a hardened multi-user administration service.
- Self-only resource CSP, no frames/workers/media, no forms to external sites,
  DNS-prefetch disabled, no-store, no-referrer, same-origin resource policy, and
  camera/microphone/geolocation/payment permissions disabled. External fonts,
  Leaflet/OpenStreetMap, and inline style attributes are intentionally blocked;
  font/avatar/map visuals therefore differ from a production browser session.
- Exact local assets may still *attempt* external resource loads; the browser
  CSP blocks them. The server does not proxy external resources. The analytics
  asset's existing loopback check disables analytics here.
- `fetch` is replaced **before application imports** with a throwing guard.
  Imported HTTP helpers allow only this exact harness origin; imported HTTPS
  helpers throw. Smoke probes prove these guards throw without invoking a
  transport. Unexpected request attempts are counted and asserted to be zero.
  This is a bounded trusted-code test fixture, not an OS-level network sandbox.
- Supabase admin/server clients are replaced by the existing limited PGlite
  query adapter. Synthetic owner/other/observer identity replaces Auth. Rate
  limits are no-op mocks. No claim is made about actual Supabase JWTs, sessions,
  PostgREST, deployed middleware, infrastructure rate limiting, or HTTPS cookies.
- The real room/guest/vote/confirmation/close handlers, validation, public
  projections, SQL schema, triggers, RLS policies, and HTTP guest-cookie path are
  exercised. PGlite uses an in-memory database, not the user's database.
- Payment `/pay` and `/voice-token` endpoints deliberately return 503 from the
  harness and never execute provider routes. The Pine Labs module is fully
  mocked, including its pure price helper; its SDK is not imported. Secret and
  live-token modules are fail-closed mocks. No payment or live voice is tested.
- The shared privacy helper explicitly excludes the Vault migration. A file-read
  guard additionally rejects `.env` and Vault/app-secrets file reads, and the
  loaded migration-name list is checked. Guard probes do not read either file.
- Cookie/guest-secret values are never logged. Even assertions compare them as
  booleans to avoid printing values on failure. Controls return aggregate counts,
  synthetic role, and safety counters only. Application exception objects are
  suppressed and counted, not dumped.
- Maximum lifetime is 30 minutes, request/header timeout 5 seconds, request body
  limit 16 KiB, max header size 8 KiB, and max connections 32. Requests and resets
  are serialized so no handler sees a half-reset fixture.

The stop button, Ctrl-C/SIGTERM, automatic deadline, and test cleanup close the
listener and in-memory database. No database persistence or credential files are
written. Do not leave a browser test running after its observation window.

## Automated proof included

One bounded smoke scenario checks:

- byte-for-byte served asset equality and security headers;
- path, host, cross-origin, and invalid-control denials;
- observer access and two independent guest-cookie sessions;
- duplicate join, invalid budget, foreign-room cookie, and bad-header denials;
- preferences persistence, vote/unvote isolation, owner/non-owner authorization;
- confirm/close state guards and read-only closed rooms;
- direct cross-owner PostgreSQL RLS mutation denial and anonymous guest-row denial;
- disabled provider endpoints and zero unexpected fetch/provider/secret access;
- reset invalidation and shutdown.

A successful HTTP smoke is **not** proof of a completed browser exercise. Record
browser observations separately, including limitations of browser profile or
network visibility. This harness makes no production deployment, login, provider,
payment, WhatsApp, or full end-to-end claim.
