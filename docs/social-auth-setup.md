# Social sign-in setup and release prerequisites

Documentation checked against the official references below on **2026-10-25**.
This is an operator checklist, not evidence that any provider or deployment is
configured. It does not authorize creating credentials, changing account access,
enabling providers, accepting agreements or starting a live OAuth flow. Follow
the target/credential checks in [feature rollout](feature-rollout.md) first.

## What this repository actually does

`app/login/page.tsx` calls Supabase `signInWithOAuth` for `google`, `facebook`,
`linkedin_oidc` and the custom identifier `custom:instagram`. The page starts
with Google visible, then filters these candidates using
`GET /auth/v1/settings` → `external`. If that lookup fails or returns no
`external` object, Google remains visible. A button is therefore **not proof of
a configured or working provider**. Other providers appear only when reported
enabled; this is not an unconditional four-button login screen.

The browser sends its current origin plus `/auth/callback?next=...` as the app
return URL. `app/auth/callback/route.ts` exchanges the code for a Supabase session
and redirects to a same-origin path validated by `safeNext`; the fallback is
`/`, not `/organizer/`. A missing code or failed exchange redirects to
`/login?error=auth`. Provider-start errors are displayed on the login form.

## Minimum operator prerequisites

Before a separately approved live test:

1. Identify the canonical public app origin, the actual Supabase Auth instance
   and the provider's intended project/app. Confirm remediation of previously
   exposed credentials. Repository examples, a successful build and a visible
   login button cannot establish these facts.
2. Verify the deployed app's Supabase URL/public key target and the provider's
   configuration in that same Auth instance. Keep provider secrets on the Auth
   server, not in browser-visible app variables or source control. Confirm the
   intended signup policy; first-time social sign-in can create a user when
   signups are allowed, and is not controlled by the email form's mode toggle.
3. Register the **Auth service's callback** with the external provider and the
   **app's callback** in Supabase. These are different URLs:

   | Boundary | Required target |
   | --- | --- |
   | Provider → Supabase Auth | Copy the callback shown by that provider's Supabase configuration. Hosted default: `https://<project-ref>.supabase.co/auth/v1/callback`. Custom-domain/self-hosted targets must use their actual public Auth endpoint. |
   | Supabase Auth → app | Allow the canonical `https://<app-host>/auth/callback` return path and verify the application's `next` return query against the allow-list. Use an exact production path rather than a broad wildcard. |
   | Supabase default/site origin | Set Site URL to the canonical app HTTPS origin. Verify email confirmation/reset redirects separately. |

   For local development, explicitly confirm the app port and Auth endpoint;
   `localhost` and `127.0.0.1` are not interchangeable registered URLs. Do not
   assume that a checked-in example is already allowed on the running service.
   See [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).
4. Verify provider audience, required identity permissions, app roles/test users
   and any applicable review/verification before offering sign-in to that
   audience. Enabling the Supabase provider alone is insufficient.
5. Verify the origin/proxy boundary below and exclude callback query strings,
   cookies and tokens from access logs/tracing. Then use explicitly approved
   test accounts to exercise success, cancellation, expired/reused callbacks,
   wrong audiences and the existing email-login fallback. Local fixtures do
   not prove provider acceptance, live cookies or email delivery.

## Origin settings and fallback rules differ across auth flows

These are descriptions of the current code, not suggested configuration changes:

| Flow | Origin source in this app |
| --- | --- |
| Start social sign-in | Browser `location.origin`. Open the app at its intended public URL. |
| `/auth/callback` redirect | `lib/urls.ts` → `publicOrigin`: valid origin-only `NEXT_PUBLIC_SITE_URL` wins. Without it, validated `X-Forwarded-Host`, then `Host`, then request URL; forwarded protocol uses the first value of an all-HTTP(S) list or a loopback-HTTP/external-HTTPS default. |
| Password update POST | Valid `NEXT_PUBLIC_SITE_URL` preferred; otherwise validated `Host`, then request URL. Forwarded headers do not expand its allow-list. See [password-reset boundaries](password-reset-boundaries.md). |
| Google data/action connectors | Exact `GOOGLE_CONNECTOR_ORIGIN`; no Host/forwarded-header fallback. |

For the social callback, `NEXT_PUBLIC_SITE_URL` must contain only an HTTP(S)
origin, with an optional trailing slash: no credentials, non-root path, query,
fragment or malformed authority. Valid configuration takes precedence even
when request/forwarded headers disagree. Invalid configuration fails before
code exchange with a generic server error and no redirect, not a friendly
login-page warning. Configure the same canonical origin for password updates.

With `NEXT_PUBLIC_SITE_URL` unset, a syntactically valid forwarded host is not
proof it belongs to this app. The deployment must ensure a trusted ingress
supplies/overwrites Host and forwarding headers rather than passing arbitrary
caller-supplied values. `safeNext` constrains the path relative to the selected
origin; it does not establish trust in that origin. If relying on this fallback
without a verified ingress guarantee, social-login readiness remains unresolved.
Neither this setting nor the Supabase Site URL configures
`GOOGLE_CONNECTOR_ORIGIN` or registers provider callbacks automatically.

## Google (`google`)

Use the intended Google Cloud project and a **Web application** OAuth client.
Configure Google Auth Platform branding, audience and the basic identity scopes
(`openid`, email and profile). Register the app origin under Authorized
JavaScript origins and the actual Supabase Auth callback under Authorized
redirect URIs; place the matching client ID/secret in that Supabase provider.
For local Auth, use the environment-variable names actually referenced by its
configuration, not assumed names from this document. Supabase's current example
keeps `skip_nonce_check = false`; do not disable nonce checking merely because
the app is local. [Supabase Google setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)

Google's External/Testing restrictions have an exception for basic-identity-only
requests: `openid`, `email`, `profile` do not require the test-user allow-list.
Do not apply that exception to Contacts, Sheets, Gmail or Calendar access.
Publishing status, brand verification, scope verification and Workspace admin
restrictions are distinct checks; "In production" alone does not prove all
audiences or scopes are approved. [Google OAuth app states](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)

## Facebook (`facebook`)

Configure the intended Meta app's Facebook Login use case and exact Supabase
callback. Confirm `public_profile` and `email` permissions; Supabase's setup
requires email permission, and a user's email may still be absent. Add the
matching app ID/secret to the Supabase Facebook provider. Development-mode access
is limited to accepted app-role users. For public access, verify the app's
required settings, permission access/review and Live status rather than assuming
one toggle suffices. Facebook sign-in is not a substitute for signing in with
Instagram credentials. [Supabase Facebook setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-facebook)

## LinkedIn (`linkedin_oidc`)

Create/use the intended LinkedIn app with its legitimate LinkedIn Page and logo,
request **Sign In with LinkedIn using OpenID Connect**, and confirm that product
access and the required `openid`, `profile`, `email` scopes are provisioned.
Register the exact Supabase callback and add the client ID/secret to Supabase's
**LinkedIn (OIDC)** provider, not the legacy LinkedIn provider. Neither a dummy
Page nor instant approval is a release prerequisite or guarantee.
[Supabase LinkedIn setup](https://supabase.com/docs/guides/auth/social-sign-in/auth-linkedin)

LinkedIn documents `email` and `email_verified` as optional response fields.
Include the missing-email case in acceptance testing; requesting the scope is
not proof every account will return it. [LinkedIn OIDC documentation](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)

## Instagram (`custom:instagram`): not a verified integration recipe

The UI's identifier is a **custom provider**, not built-in Instagram support.
Creating a custom provider does not establish that Instagram's token exchange,
userinfo response and identity claims are compatible with the deployed Auth
version. The earlier endpoint-only recipe has not been validated end to end.

Supabase requires email by default for custom providers. No-email sign-in needs
explicit `email_optional = true` configuration **and** verification that the
app's account flows handle that identity; "email stays empty and works" is not
a safe assumption. Confirm the provider's callback, identity/subject handling,
scope and PKCE compatibility without silently weakening validation. Supabase's
current hosted limits are three custom providers on Free and unlimited on Pro
and above; check the target's actual version/plan rather than assuming these
limits describe a local/self-hosted deployment.
[Supabase custom providers](https://supabase.com/docs/guides/auth/custom-oauth-providers)

Meta's Instagram API with Instagram Login targets professional (business/creator)
accounts, not general personal-account login. See [Meta's published API collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login).
The direct Meta setup pages returned HTTP 429 during this documentation review,
so current endpoint details and app-specific review/access requirements remain
unverified. Consult [Meta's current Instagram Login documentation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login)
before planning an authorized integration test. Do not advertise this provider
as live-ready from the candidate button or the old recipe.

## Social identity is not Google feature consent

Signing in to muop creates an app session. It does **not** connect Google
Contacts, Sheets, Gmail or Calendar in this implementation. Those flows have
independent purpose scopes, callbacks and temporary encrypted sessions:

| Purpose | Exact requested scope suffix | App callback after the canonical origin |
| --- | --- | --- |
| Contacts import | `auth/contacts.readonly` | `/api/me/integrations/google/contacts/callback` |
| Sheets import | `auth/spreadsheets.readonly` | `/api/me/integrations/google/sheets-import/callback` |
| Sheets export | `auth/drive.file` | `/api/me/integrations/google/sheets-export/callback` |
| Gmail send | `auth/gmail.send` | `/api/me/integrations/google/gmail/callback` |
| Calendar events | `auth/calendar.events.owned` | `/api/me/integrations/google/calendar/callback` |

Each scope above has the prefix `https://www.googleapis.com/`. Register these
with their connector clients, **not** as the Supabase social-login callback.
Follow the separate [Contacts](google-contacts-setup.md),
[Sheets](google-sheets-setup.md) and [Gmail/Calendar](google-actions-setup.md)
guides for dedicated credentials, API enablement, reviewed schema/readiness,
encryption, cleanup and purpose-level user confirmation. Gmail and Calendar
also require their independent default-off feature flags. The selected Google
account need not match the app sign-in account. Successful social login proves
none of these connector prerequisites.

Review each requested scope under Google's current sensitive/restricted-scope
rules before public rollout; basic sign-in approval cannot be reused as proof
that data/action scopes are approved. [Google scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)

## Historical demo notes are not current deployment evidence

Earlier notes described a CachyOS/Tailscale Funnel demo and a named Google
project/client as already configured. They do not establish today's app origin,
Auth endpoint, project ownership, credential validity or consent status. No
live environment or provider settings were inspected for this review. Do not
reuse an old hostname/project or restart a local Supabase service based on
those notes.

For an approved self-hosted deployment, obtain its actual public Auth callback
and configure it using that runtime's supported settings. A hosted Dashboard,
Supabase CLI setup and self-hosted Auth environment are not interchangeable.
[Supabase self-hosted OAuth guidance](https://supabase.com/docs/guides/self-hosting/self-hosted-oauth)
