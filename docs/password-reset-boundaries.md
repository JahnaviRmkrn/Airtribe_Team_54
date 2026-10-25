# Password-reset account binding

The reset form is bound to the account verified when it opens. An account change
or sign-out invalidates its password draft and stops any success/redirect from a
late response. The submit handler has a synchronous pending/finished guard, and
rechecks the current user before sending one request.

`POST /api/me/password` is the authoritative mutation boundary. It requires:

- A same-origin request, with no cross-site fetch metadata.
- A nonempty `X-Contact-Owner` matching the authenticated request user.
- Request cookies only; mixed Authorization headers are rejected.
- A valid password body using the existing minimum of six characters.

The same request-scoped Supabase client verifies and updates that owner. Its
cookie input is a request snapshot. Switching the browser to Bob after Alice's
request has been sent cannot retarget that request to Bob. Alice's already-sent
update may still finish; changing browser accounts is not cancellation of an
in-flight provider operation. The UI ignores its late result after invalidation.

## No late session overwrite

Both the route's cookie persistence and **the exact password POST's** middleware
session refresh are disabled. The existing HTTPS redirect still applies.
Unrelated middleware routes and normal Supabase client callers keep their
existing behavior. Thus a late Alice update cannot overwrite Bob's newer browser
session through either a route or middleware `Set-Cookie`.

This password-only client denies refresh-token grants locally with a fixed,
non-retryable 401 response, before any refresh transport. This also covers expiry
between user verification and mutation. No rotated refresh token is discarded,
and the app does not claim durable session continuity from a suppressed refresh.
An expired or unverified session needs a fresh sign-in or reset link. The SDK may
log the fixed local denial message; no password, cookie, upstream error object,
or refresh token is supplied to that log. Ordinary client callers can still
refresh and persist their cookies.

## Origin configuration and proxies

`NEXT_PUBLIC_SITE_URL` is preferred and must be a valid HTTP(S) URL without
credentials. Without it, standard `Host` determines the exact public HTTPS
origin, allowing a proxy's internal localhost request URL while preserving its
public Host. Loopback Host uses the request's scheme/port for local testing.
Default ports and hostname case are normalized. Missing Host falls back to the
request URL origin. Malformed Host/configuration fails closed with setup guidance.

`X-Forwarded-Host` and `X-Forwarded-Proto` never expand this password endpoint's
allowed origin. A proxy that rewrites Host to an internal address must configure
`NEXT_PUBLIC_SITE_URL`; an external Origin is not trusted merely because a
forwarded header repeats it. No wildcard, origin reflection, or live deployment
configuration change is part of this fix.

## Uncertain outcomes

A password provider's explicit rejection can be corrected and resubmitted.
Transport loss, unexpected success payloads, and provider/server failures are
instead treated as unconfirmed outcomes. The app never automatically resubmits,
hides the reset form after uncertainty, clears password inputs, and advises
trying the new password at sign-in before requesting another reset. This is not
an idempotency or rollback guarantee. The route sanitizes upstream errors and
does not send them to the generic request error logger.

## Verification limits

Focused tests exercise actual installed Supabase SDK clients with synthetic
cookie adapters and mocked HTTP transport. They cover the before/during/after
account switch, route and middleware no-cookie behavior, locally blocked expiry,
unchanged default refresh behavior, invalid/missing owner, exact origins/proxy
fallback, mixed bearer rejection, provider uncertainty, duplicate submits, and
ignored late UI results. Separate loopback auth-fixture smoke covers real HTTP
and SDK cookie exchange. No live Supabase session, provider, real password,
admin/service-role credential, email, or migration is used. Hydrated-browser
acceptance must be run separately against the sanitized fixed-port build.
