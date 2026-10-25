# Credential-free hydrated auth fixture

This test-only, loopback-only GoTrue-shaped fixture exercises the shipped React
login/reset pages, Supabase browser/SSR SDK cookie handling, and Next callback
routing. It is **not Supabase**, does not authenticate real users, never sends
email, never contacts an OAuth provider, and cannot authorize database access.
The opaque session strings are deliberately **not JWTs**. No production security,
refresh-token behavior, email delivery, MFA, or real provider grant is verified.

No application route imports this fixture. It has no database, service role,
secret reader, upstream forwarding, fetch implementation, package installation,
or deployment behavior. Unknown endpoints fail closed, including all REST,
storage, admin, refresh, and provider grant endpoints.

## Smoke checks (no build or persistent server)

From the checkout root, using already-installed dependencies:

```sh
./tests/local-auth-harness/run.sh smoke
```

The launcher starts Node under `env -i` with PATH and NODE_ENV only. The smoke
checks bind one ephemeral **127.0.0.1** port, exercise HTTP plus the real installed
Supabase browser/server SDK with synthetic cookie adapters, and close the server
on completion. They do not read `.env` files or start Next/a browser. They cover:

- Exact host/origin/method/header allowlists and disabled data/admin endpoints.
- Synthetic-only accounts, callback targets, and password updates.
- Password login, authenticated user lookup, and logout invalidation.
- PKCE cookie creation, server exchange, a subsequent server client's cookie read.
- Separate signup confirmation and magic-link account-creation intent.
- Expired links, missing codes, verifier mismatch, and one-time code replay.
- Local-only OAuth error return, never a provider connection.

## Coordinated browser run

Only the browser/build owner should run these steps. Use a dedicated clean
worktree with no `.env`, `.env.local`, `.env.production` or other Next-loaded env
files. `env -i` removes inherited secrets but **does not stop Next loading local
env files**. Do not copy or inspect any existing env/credential files.

Use a clean browser context without real app sessions. Fixture session cookies
use the actual SDK namespace (`sb-127-auth-token`), so existing localhost
Supabase sessions must not be mixed into this context.

Fixed origins, with no automatic port fallback:

- Fixture: `http://127.0.0.1:4318`
- Actual Next app: `http://127.0.0.1:4320`
- Callback: `http://127.0.0.1:4320/auth/callback`

Start the fixture in the same native environment/network namespace as Chrome:

```sh
./tests/local-auth-harness/run.sh serve
```

Wait for `LOCAL_AUTH_FIXTURE_READY`. It stops after 30 minutes or Ctrl-C, discards
all state, and fails rather than choosing a different interface/port. The fixture
control page is `http://127.0.0.1:4318/__fixture/`. Reload it after requesting a
magic/confirmation/recovery link; click the generated synthetic callback there.
No mail is sent. Controls also expire pending links or reset all fixture state.

The build owner must compile the app with this exact synthetic configuration,
then start that same build at 127.0.0.1:4320. For example, after verifying the
isolated checkout is free of Next-loaded env files:

```sh
node_bin=$(command -v node)
env -i PATH=/usr/bin:/bin NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SITE_URL=http://127.0.0.1:4320 \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:4318 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-auth-fixture-anon-key \
  "$node_bin" node_modules/next/dist/bin/next build --turbopack

env -i PATH=/usr/bin:/bin NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SITE_URL=http://127.0.0.1:4320 \
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:4318 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-auth-fixture-anon-key \
  "$node_bin" node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4320
```

Do not reuse a build compiled for port 9: browsers block that port. Changing only
runtime env does not rewrite Next's inlined public URLs or compiled CSP. Do not
disable browser security or modify production config to accommodate this test.
Block unrelated external traffic using the browser owner's supported test setup;
never navigate a real provider/login page. No real user input, secrets or claims.

## Fixed synthetic inputs

- Existing users: `alice@auth-fixture.test`, `bob@auth-fixture.test`
- New signup only: `new-user@auth-fixture.test`
- Initial/signup password: `fixture-password-123`
- Reset password: `fixture-new-password-123`

The fixture accepts no other identity and no other new password. Incorrect
synthetic sign-in passwords return an error. Reset controls restore all fixture
passwords and invalidate all its sessions; reload app tabs afterward. This is
synthetic test state, not an account operation outside the fixture.

## Bounded hydrated acceptance matrix

1. Open `/login?mode=signup&next=%2Flogin`, switch modes, navigate Back/Forward,
   show/hide password, and verify native required/email validation. Assert the
   initial purpose, visible errors, pending disabled controls, and recovery.
2. Log Alice in using `next=/login` (avoids unsupported organizer data reads).
   Reload and visit `/reset-password`: the actual SDK/server reads should retain
   the synthetic session. Use a fresh context for signed-out expired-link UI.
3. Submit an incorrect synthetic password. Confirm no signup occurred in fixture
   request kinds. Test new-user magic link in login versus explicit signup mode.
   Signup must show confirmation, not pretend there is a session.
4. Request a recovery link, open it from controls, and inspect matching-password
   validation and successful synthetic update. Expire a separate requested link
   before opening it; confirm no reset form/session is created from that code.
5. Exercise `next=/.//evil.example/path` and the absolute same-origin `//` variant
   on login, reset, and successful callback. Inspect the final localhost URL;
   do not visit an external destination to demonstrate the old defect.
6. The Google button deliberately returns a **synthetic denial**, all on
   loopback. Verify readable callback/login failure. This is not Google OAuth
   success coverage. Successful PKCE return is covered by magic/recovery links.
7. Open Alice's reset form, then sign Bob in in another normal tab on the same
   app origin. The form must not update Bob or display an obsolete success after
   the account change. Reloading both tabs is not an equivalent stale-form test.
8. Stop both servers and close the clean browser context. Record actual hydrated
   observations separately from HTTP/SDK smoke results; neither implies the other.

The fixture does not implement organizer/data APIs. A default post-login redirect
may reach organizer and show expected unsupported-data errors. Use a same-origin
`next=/login` destination for an isolated successful navigation check. Existing
server callback code consumes the SDK verifier cookie; it is not bypassed by a
fake success route. This fixture intentionally does not model every GoTrue edge
case or claim an exhaustive authentication security review.
