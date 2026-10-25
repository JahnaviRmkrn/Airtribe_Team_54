# Magic-link sign-in, retry and account boundaries

## Shipped behavior

`/login` starts email/password sign-in. **Use Magic Link** replaces the password
input with email-link submission; the separate **Create account** mode is the
only email mode that passes `shouldCreateUser: true`. Login mode always passes
`false`. Requesting a link is not proof of an authenticated session.

The UI serializes pending authentication starts, including a second form submit
before React rerenders. Email/password inputs and other sign-in choices stay
disabled while a request is pending. Explicit failures release the controls for
retry. A successful send clears an earlier callback error and shows a status,
not an error alert. Editing the email clears the previous recipient's sent-link
notice; changing methods or signup/signin mode also clears it.

The app uses the installed Supabase browser SDK's default PKCE configuration and
sends the browser origin plus `/auth/callback?next=...`. The callback passes only
the code to the server SDK and keeps the existing safe-next and origin guards.
The SDK must find the requesting browser's verifier cookie to exchange the code.
A successful callback stores the returned session cookies. A missing or rejected
code returns `/login?error=auth`; it does not follow the requested next path.

## Repeated links and cancellation

The current stable SDK mode uses the **latest** verifier for callbacks without
a flow identifier. Requesting another email link can make the earlier one
unusable. In the actual SDK/SSR fixture test, attempting the earlier link fails
without signing in or invalidating the latest link; the latest then succeeds.
After any failed or expired link, the straightforward recovery is to request a
**fresh link and open that latest link in the requesting browser**. The UI says
this after sending. There is no promise that two outstanding links can complete
in either order.

Supabase 2.118.0 includes experimental per-flow redirect support, but the app
does **not** enable it. Enabling it would change redirect URLs and would require
separate callback/allow-list validation. This change does not opt in or alter
provider settings, URL allow-lists, email templates, or callback origin logic.

Leaving the page or choosing password sign-in does not revoke a link already
sent. No session is created until a callback succeeds. Opening a link in a
browser without its verifier fails; the original browser can still use an
unconsumed matching link. A failed or expired link does not replace an already
signed-in account. Successfully consuming a valid link for another account
intentionally replaces the current browser session with that account.

## Credential-free verification

- `tests/auth-pages.test.mjs` invokes actual page handlers with mocked auth
  calls: same-render repeats, cross-method overlap, disabled inputs, success
  status after callback failure, changed-recipient notice, and existing
  signup/password/provider and reset-owner regressions.
- `tests/magic-link-callback.test.mjs` runs the actual Next callback with real
  installed Supabase browser/server SDK cookie adapters against the isolated
  [loopback-only fixture](../tests/local-auth-harness/README.md). It verifies
  session creation on a subsequent server read, one-time replay with restored
  synthetic verifier cookies, expiry and a fresh retry, an abandoned callback,
  missing browser cookies, latest-link success despite an older-link failure,
  account switching, and explicit magic-link signup.

These are handler/SDK/HTTP tests, not hydrated-browser acceptance. The fixture
models one-time codes and expiration locally; it is not a real Supabase Auth
service and does not establish production expiry durations, email delivery,
rate limits, live redirect settings, refresh/MFA behavior, or provider readiness.
No real account, email, provider grant, database or deployment is involved.
