# Google Contacts: one-shot, selected import

## What is implemented

Contacts → Import Google Contacts is separate from Google sign-in. It asks only
for `https://www.googleapis.com/auth/contacts.readonly`. The server requests only
`names,emailAddresses` from `people/me/connections`, restricted to contact
sources. It previews up to 1,000 people in 100-person pages. People and categories
must be explicitly selected before saving, with at most five per batch. Existing
contacts are not overwritten. Onboarding's independent five-person cap is unchanged.

No Google client, credential, consent grant, enabled API, live contact request,
database migration, or deployment is created by adding this code. Without the
server configuration **and** database schema, the UI shows setup-needed and
manual contact entry remains available.

## Security prerequisite

Do not enable this integration until any previously exposed application/service
credentials have been remediated by an authorized operator. In particular, a
leaked Supabase service-role key defeats database access restrictions. This
feature does not rotate, retrieve, inspect, or validate real credentials.

Store the new encryption key and OAuth secret only in the deployment's protected
server environment/secret manager, never in source control, public environment
variables, browser storage, or a previously compromised secret store. The new
connector settings are deliberately not added to the existing Vault bootstrap.

## Operator setup (requires separate approval)

1. Select a Google Cloud project and enable the **People API**. Configure Google
   Auth Platform branding, audience, test users as appropriate, and the consent
   screen/data access scope above. Follow Google's verification requirements
   before making the app publicly available. This is not a Contacts API (legacy)
   integration.
2. Create an OAuth client of type **Web application**, separate from login
   configuration. Register this exact authorized redirect URI, substituting the
   app's public origin:
   `https://your-app.example/api/me/integrations/google/contacts/callback`.
   Do not register user-supplied hosts, arbitrary return URLs, or wildcard
   callbacks. The implementation does not read Host or forwarded headers for it.
3. Supply these server-only variables:
   - `GOOGLE_CONTACTS_CLIENT_ID`: the Web application client ID.
   - `GOOGLE_CONTACTS_CLIENT_SECRET`: its protected client secret.
   - `GOOGLE_CONNECTOR_ORIGIN`: exact public HTTPS origin, no path/query/fragment.
   - `GOOGLE_CONNECTOR_ENCRYPTION_KEY`: a newly generated cryptographically random
     32-byte key encoded as standard base64. Do not reuse another credential.
   Local development may use an explicitly configured `http://localhost:PORT`
   or `http://127.0.0.1:PORT` only outside production. Do not use real data for
   development. No `NEXT_PUBLIC_` Google credential variables are supported.
4. Review and apply `20261025110000_google_contact_import.sql` and the additive
   `20261025114000_google_session_replacement.sql` through the normal
   authorized database-change process. It creates an RLS-protected service-only
   session table and service-only import/preview/cleanup RPCs. The ordinary
   signed-in user and anonymous roles cannot access them directly. The second
   migration is required by every shared connector purpose (Contacts, Sheets,
   Gmail and Calendar): missing RPC/column schema fails closed, not back to an
   unsafe upsert.
5. Schedule `select public.cleanup_google_connector_sessions();` at least every
   15 minutes using the deployment's supported privileged scheduler. This
   migration does **not** install cron or create a schedule. Expired rows are
   also removed on expired-session access; a new connection safely replaces an
   expired same-owner/purpose row only after checking its lease. Access is
   rejected after 15 minutes even if cleanup has not run; scheduled cleanup
   bounds physical ciphertext retention for abandoned imports.
6. Redact query strings for the OAuth callback in edge/proxy/access logging and
   error collection. An OAuth authorization code necessarily arrives in Google's
   callback query, but the application never logs it and immediately redirects
   to a fixed app page with only a generic result. Disable callback analytics.

Google's [Web Server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
documents API enablement, Web application credentials, exact redirect matching,
authorization code exchange, online vs offline access, and verification. The
[People connections reference](https://developers.google.com/people/api/rest/v1/people.connections/list)
defines the supported scope and field mask, page size (1–1,000), page tokens,
consistent paging parameters, and quota errors. These official sources were
reviewed on 2026-10-25. The implementation intentionally uses a smaller page size
and a bounded one-shot preview, not ongoing sync.

## Credential and session behavior

- Authorization state is unpredictable, owner-bound and one-use. PKCE uses S256;
  code verification and client-secret exchange happen only on the server.
  It uses Node's crypto, URL/URLSearchParams and fetch implementations following
  Google's documented HTTP flow. Google's [OAuth client implementation](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts)
  confirms S256/code-verifier parameters for this authorization-code flow.
- OAuth access is `online`; no offline/refresh access is requested and any
  unexpected refresh token is discarded. `include_granted_scopes=false` avoids
  requesting earlier grants as part of this purpose.
- AES-256-GCM encrypts the payload with a fresh IV and binds it to the session ID,
  signed-in app owner and connector purpose. The HttpOnly, SameSite=Lax cookie
  contains only an opaque random handle; HTTPS cookies are Secure. The database
  stores only its hash. OAuth tokens do not appear in JSON, browser JS/storage,
  or application-generated URLs.
- A session lasts at most 15 minutes and its expiry is not extended by reads or
  imports. A 30-second lease serializes work across server instances. Finishing
  all preview pages drops the access token immediately, leaving only the
  encrypted preview until cancellation or expiry.
- Cancel & disconnect deletes the server preview/token and cookie, while keeping
  already imported contacts. A late cancelled request cannot restore the row.
  A failed old callback cannot delete a newer connection in another tab.
- Cancellation removes **this app's temporary access**, not the Google Account's
  authorization record. To remove that grant, the user can manage it in
  [Google Account connections](https://myaccount.google.com/connections).
  Automatic token revocation is deliberately avoided: Google's current guide
  warns revocation affects all scopes/clients in that Cloud project. Use separate
  projects if independent provider-level revocation from login/other connectors
  is needed; do not accidentally revoke unrelated access.
- Imports are owner-scoped, transactionally deduplicated under an owner lock,
  and safe to retry after a lost HTTP response. Email matching ignores case;
  name matching is used if either contact lacks an email. Different nonempty
  emails are kept distinct. Existing fields and categories are never overwritten.
  This is conservative matching, not a claim that people can always be uniquely
  identified by name. Review selected rows before import.

The [Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
cover secure credentials/tokens, state checking and purpose-specific consent.

## Shared connector interface

`lib/google/connector.ts` contains the server-only helpers. Contacts uses purpose
`contacts`. Other explicitly implemented features may use `sheets-import`
(`spreadsheets.readonly`), `sheets-export` (`drive.file`), `gmail` (`gmail.send`),
or `calendar` (`calendar.events.owned`), each with independent
cookie/state/callback and an explicit scope allowlist. Merely reserving a purpose
in SQL does not grant its scope or expose a feature. There is no automatic scope
union, cross-purpose token reuse, login change, or refresh operation.
These later purposes use their own `GOOGLE_SHEETS_*`, `GOOGLE_GMAIL_*`, and
`GOOGLE_CALENDAR_*` client settings and purpose-specific consent UI. Their scope
entries do not enable them or imply approval to send messages/create events.

- `createGoogleSession(config, owner, payload)` calls an atomic service-only
  owner/purpose replacement RPC. An active lease or unexpired protected action
  blocks replacement regardless of cookies, including a different browser.
  Check the prior result and explicitly disconnect before reconnecting.
- `googleConnectorSchemaReady()` calls the read-only service-role readiness RPC.
  Status routes must check it before reporting configuration ready. It verifies
  the replacement function and protection column, without creating a session.
  Upgrade backfill conservatively protects all already-live ciphertext because
  a migration cannot inspect its encrypted action state.
- `googleAccessToken(session)` is a server-only expiry check after acquiring the
  authenticated owner's session; it never refreshes or makes a provider request.
- `acquireGoogleSession<T>(config, owner)` returns
  `{ id, owner, lease, expiresAt, payload }` and acquires a short lease.
- `consumeGoogleAuthorization(config, session)` invalidates stored state before
  exchanging a code, without releasing the lease.
- `saveGoogleSession(config, session)` verifies ID/owner/purpose/lease/expiry,
  stores payload, and unlocks. `releaseGoogleSession` unlocks without rewriting.
- `checkpointGoogleSession(config, session)` saves a durable mutation intent or
  result while retaining/renewing an unexpired 30-second lease. It never extends
  the absolute session lifetime or revives an expired lease. Checkpoint before
  a side effect, not only afterward; an uncertain action must not be replayed.
  Checkpoint atomically sets `protected_action=true`. Ordinary saves, reads,
  OAuth consumption and lease release cannot clear this marker. It remains until
  explicit disconnect or original session expiry, including after completed
  actions; the same session may still prepare subsequent confirmed batches.
- `discardGoogleSession(config, session)` removes only that session;
  `deleteGoogleSession(config, owner)` is explicit current-purpose cancellation.
- `googleJson` is for bounded provider requests and never automatically retries.
  Its generic retry message is suitable for reads only. Future email/event/sheet
  mutations must persist a purpose-bound action intent and handle uncertain
  completion without encouraging duplicate writes or blindly retrying.

## Verification and limits

Tests use synthetic names/emails/tokens, mocked Google/Supabase and a fresh
in-memory PostgreSQL-compatible PGlite database. They do not read local secrets,
initialize Vault, access real contacts, or enable provider APIs. SQL tests verify
role restrictions, owners/purposes, leases, expiry, retries, duplicates and atomic
rollback. PGlite serializes requests internally; overlapping request tests are
not a substitute for production multi-connection load testing.

Authorized staging validation is still required for actual Google consent,
client verification status, redirect registration, People API enablement, proxy
cookie behavior, production database roles/concurrency and cleanup scheduling.
Do not describe mocked tests as a real Google OAuth or live import success.
