# Social sign-in setup (Google, Facebook, LinkedIn, Instagram)

The `/login` page has **Continue with Google / Facebook / LinkedIn / Instagram**
buttons. All four run through Supabase Auth (`signInWithOAuth`), so the only
backend change needed is enabling each provider with its client ID + secret.
Until a provider is enabled, its button shows the API's error message on the
page; nothing else breaks.

## Callback and redirect URLs (same for every provider)

| Where | Value |
|---|---|
| Supabase callback URL (register this with each provider) | `https://<project-ref>.supabase.co/auth/v1/callback` (hosted) or `http://localhost:54321/auth/v1/callback` (local `supabase start`) |
| App redirect (allow-list in Supabase) | `http://localhost:3000/auth/callback` is already allowed locally via `additional_redirect_urls`; for production add `https://<your-domain>/auth/callback` under Authentication -> URL Configuration |
| Site URL | Set to `https://<your-domain>` in production (Authentication -> URL Configuration) |

## Google (provider id: `google`)

1. Google Cloud Console -> APIs & Services -> Credentials -> Create Credentials
   -> **OAuth client ID** -> Application type **Web application**.
2. Under **Authorized redirect URIs** add the Supabase callback URL above.
3. Configure the OAuth consent screen (External). While the app is in "Testing"
   only listed test users can sign in - add your teammates' Gmail addresses.
4. Copy the **Client ID** and **Client secret** into Supabase:
   Dashboard -> Authentication -> Sign In / Providers -> **Google** -> Enable ->
   paste -> Save. For local dev, export `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`
   / `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` and set `enabled = true` under
   `[auth.external.google]` in `supabase/config.toml` (`skip_nonce_check` is
   already on for localhost).

## Facebook (provider id: `facebook`)

1. developers.facebook.com -> My Apps -> **Create App** -> type **Consumer**
   -> add the **Facebook Login** product (Web).
2. Facebook Login -> Settings -> **Valid OAuth Redirect URIs**: add the
   Supabase callback URL.
3. App ID and App Secret are under Settings -> Basic. Paste them into the
   Supabase dashboard's **Facebook** provider (or the
   `SUPABASE_AUTH_EXTERNAL_FACEBOOK_*` env vars locally).
4. Note: a new Meta app starts in **development mode** - only admins,
   developers and testers listed under App Roles can sign in until the app is
   switched to Live.

Contact import: normal Facebook sign-in asks for `email` only. The organizer's **Import Facebook friends**
button (`/connect/facebook`) re-runs OAuth asking for `user_friends` so friends who use the app can be
offered for import. Meta only returns those friends, and `user_friends` needs app review (Advanced
Access) for anyone who is not an admin/developer/tester on the app; the friends-file upload always works.

## LinkedIn (provider id: `linkedin_oidc`)

1. developer.linkedin.com -> **Create app** (needs a LinkedIn Page; any page
   works, even a dummy one).
2. Products tab -> request access to **Sign In with LinkedIn using OpenID
   Connect** (approved instantly).
3. Auth tab -> **Authorized redirect URLs for your app**: add the Supabase
   callback URL. Note the **Client ID** and **Client Secret** on the same tab.
4. Paste them into the Supabase dashboard's **LinkedIn (OIDC)** provider
   (or the `SUPABASE_AUTH_EXTERNAL_LINKEDIN_OIDC_*` env vars locally).

## Instagram (provider id: `custom:instagram`)

**Supabase Auth has no built-in Instagram provider.** The login button calls
`signInWithOAuth({ provider: 'custom:instagram' })`, which works once a custom
OAuth2 provider is created (Dashboard -> Authentication -> Sign In / Providers
-> **New Provider** -> Manual configuration):

| Field | Value |
|---|---|
| Identifier | `custom:instagram` |
| Client ID / Secret | From the Meta app below |
| Authorization URL | `https://www.instagram.com/oauth/authorize` |
| Token URL | `https://api.instagram.com/oauth/access_token` |
| UserInfo URL | `https://graph.instagram.com/me?fields=user_id,username` |
| Scopes | `instagram_business_basic` |

Meta side: developers.facebook.com -> Create App -> add the **Instagram API
with Instagram Login** product -> register the Supabase callback URL in that
product's OAuth redirect URIs.

Caveats to know before demoing with it:

- Instagram Login returns only the Instagram **user id and username** - no
  email address. Accounts still work in Supabase (email stays empty).
- It is meant for Instagram **professional** (business/creator) accounts.
- Free-plan Supabase projects can have up to 3 custom providers.
- If this turns out too heavy for the demo, the Facebook button already covers
  Meta accounts; the Instagram button can be removed from
  `app/login/page.tsx` (one line in `SOCIAL_PROVIDERS`).

## Testing checklist

1. `pnpm dev` + click each button -> should leave for the provider's consent
   page (a "provider is not enabled" API error means credentials are missing).
2. Complete consent -> lands back on `/auth/callback` -> session cookie set ->
   redirected to the page in `?next=` (default `/organizer/`).
3. First sign-in also creates the account - no separate sign-up step needed.
4. Cancel the provider's consent screen -> back at `/login` with a readable
   error, email options still usable.

## Self-hosted demo (local Supabase behind Tailscale Funnel)

The team demo runs the app and a local Supabase on one machine and exposes them
with Tailscale Funnel, which gives fixed HTTPS URLs that OAuth providers accept:

| What | URL |
|---|---|
| App (share this link) | `https://cachyos-x8664.tail389ef0.ts.net:8443` |
| Supabase API / auth | `https://cachyos-x8664.tail389ef0.ts.net:10000` |
| OAuth callback to register with each provider | `https://cachyos-x8664.tail389ef0.ts.net:10000/auth/v1/callback` |

- `supabase/config.toml`: `[auth] external_url` must end in `/auth/v1` (otherwise
  Supabase sends providers `.../callback` and Google answers `redirect_uri_mismatch`);
  `site_url` and `additional_redirect_urls` include the app URL.
- Google: OAuth client "Airtribe Team 54 (Supabase)" in the Google Cloud project
  `electric-armor-388216`, consent screen published (In production, basic
  `openid email profile` scopes only, so no verification needed).
- Credentials live in the git-ignored `supabase/.env`
  (`SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `_SECRET`); `supabase stop && supabase start`
  after changing them.
- `app/auth/callback` builds its redirect from the forwarded Host / proto headers, so
  sign-in returns to the public URL instead of `localhost:3000` behind a proxy.

## Google Contacts import (scope `contacts.readonly`)

The organizer's **Import from Google Contacts** button (`/connect/google`) re-runs Google sign-in with
`https://www.googleapis.com/auth/contacts.readonly`; normal Google sign-in never requests it. Requirements:
enable the **People API** in the GCP project, and add the scope on the OAuth consent screen. It is a Google
"sensitive" scope, so users see an "unverified app" warning until Google verifies the app. The token is used
once in `/auth/callback?import=google` to list connections and is not stored.

Note: Supabase's SSR cookie keeps the session's `provider_token` for the life of the session, so the
Google/Facebook token also sits in the user's own auth cookie. The import code never persists it elsewhere.
