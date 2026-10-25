# Google Sheets: explicit import and export

This optional connector is **not enabled by this code change**. No real Google
account, contact, spreadsheet, grant, credential, API setting or deployment was
accessed or changed during implementation. Tests use synthetic data and mocked
Google responses. Production OAuth, account policies, API access and migration
application must be configured and independently verified by an authorized
operator before claiming the live integration works.

## User flow and exact scope consequences

Open Contacts → **Import or export with Google Sheets**, or
`/integrations/google-sheets`. Sign-in to muop is required. This flow is separate
from Google sign-in, Google Contacts import, Gmail and Calendar authorization.

- **Import** authorizes only
  `https://www.googleapis.com/auth/spreadsheets.readonly`. Google grants the
  ability to read all spreadsheets the selected account can access, not just a
  pasted spreadsheet ID. The UI discloses this before authorization. The app
  performs no file listing, reads only the file ID and worksheet the user
  explicitly loads, and never modifies the source spreadsheet.
- **Export** separately authorizes only
  `https://www.googleapis.com/auth/drive.file`. This permits app-created files
  and files explicitly opened/shared with the app. Pasting an arbitrary ID does
  **not** grant this access. The implemented export only creates a **new** file;
  it has no existing-file, append, sharing, overwrite or Drive-listing endpoint.
- The export consent callback reads Drive `about.get` with
  `fields=user(emailAddress)` using that same `drive.file` scope. The destination
  email, new file title, worksheet, exact range and every exported value appear
  in the final preview. No `openid`, `userinfo`, all-Drive or Drive-read-only
  scope is added. Failure to identify the destination prevents export.
- Google receives contact data only after **Create spreadsheet and export these
  values**. Preview and selecting fields do not send contact data to Google.
- Notes are excluded by default. Importing a notes column or exporting private
  contact notes requires an explicit notes checkbox, selected field/column and
  a preview showing the exact notes. No hidden fields are exported.
- Back/cancel before confirmation does not import contacts or create/write a
  spreadsheet. Ending the connection removes the app session only. It does not
  undo completed actions or cancel a request already sent to Google.

## Operator configuration (not performed by this implementation)

Use a web OAuth client for this connector, independent from the muop login
provider. Sheets import/export share this client but maintain distinct scopes,
callbacks, cookies and encrypted server sessions. Google may group grants at the
project level; separate projects are required if the operator needs fully
independent Google-side revocation. App disconnect deliberately does not revoke
an entire Google project grant and inadvertently disconnect other purposes.

1. Enable Google Sheets API and Google Drive API in the intended Google project.
   Drive is used only for the minimal export destination-account lookup.
2. Configure the consent screen accurately with the two exact scopes above,
   applicable test users, privacy policy, app verification and organizational
   restrictions. Import's broad read permission may require Google verification.
3. Register both exact redirect URIs using the app's canonical HTTPS origin:
   - `https://YOUR_APP/api/me/integrations/google/sheets-import/callback`
   - `https://YOUR_APP/api/me/integrations/google/sheets-export/callback`
4. Configure server-only `GOOGLE_SHEETS_CLIENT_ID` and
   `GOOGLE_SHEETS_CLIENT_SECRET`. Also configure the shared connector's
   `GOOGLE_CONNECTOR_ORIGIN` (origin only, no path/query) and
   `GOOGLE_CONNECTOR_ENCRYPTION_KEY` (32 random bytes encoded as canonical
   base64). Do not expose any of these as `NEXT_PUBLIC_*`, commit them or place
   credentials in URLs. Key creation/storage and access changes require the
   operator's explicit authorization.
5. Apply reviewed migration
   `supabase/migrations/20261025110000_google_contact_import.sql` and additive
   `supabase/migrations/20261025114000_google_session_replacement.sql`, then
   `supabase/migrations/20261025121500_google_purpose_readiness.sql`, in that
   order before releasing this application version, through the deployment's
   normal authorized procedure. The service-role client needs
   `SUPABASE_SERVICE_ROLE_KEY` and the normal Supabase URL/anon settings. The
   migrations are authored code, not evidence they have been applied. The
   replacement RPC and protected-action column are required for all shared
   connector purposes, including Contacts, Sheets, Gmail and Calendar. A missing
   migration blocks new sessions and mutation checkpoints; there is no upsert
   fallback.

   Status, connect and callback exchange use the read-only purpose capability
   probe; environment variables or the session table alone do not make this
   feature ready. Sheets import requires contact matching, duplicate preview
   and import routines; export requires contact fields and shared session
   infrastructure but not import routines or the optional Gmail/Calendar action
   migration. Missing, denied or failed probes stop before consent/session
   creation or token exchange, without inferring that a permission/transport
   error proves schema is absent. No fallback to the old session-only probe
   or reconnect/resend is attempted; unresolved receipts remain unchanged. Upgrade backfill protects all already-live
   sessions until explicit disconnect or their original expiry, since encrypted
   legacy payloads cannot safely be classified in SQL.
6. Schedule `cleanup_google_connector_sessions()` at least every 15 minutes
   using the platform's supported scheduler. No scheduler is installed by the
   migration. Expired sessions are already rejected; scheduled cleanup removes
   encrypted transient previews promptly when the app is idle.
7. Perform a separately authorized live test with a dedicated non-sensitive
   spreadsheet and verify the consent screen, account email, preview, created
   destination, formula-like literal values and disconnect behavior. Never use
   real contact data merely to test whether configuration works.

Missing/invalid configuration and missing schema fail closed with a setup
message. No fallback to account-wide Drive permissions or alternate credentials
is attempted. Local nonproduction HTTP is accepted only on localhost/127.0.0.1;
production requires HTTPS.

## Limits and normalization

- Spreadsheet ID only, 20–200 URL-safe ID characters; URLs, arbitrary hosts,
  paths and user-supplied A1 ranges are rejected.
- Choose a worksheet from verified spreadsheet metadata (at most 200 tabs).
  The server constructs an escaped, quoted A1 range `'<chosen tab>'!A1:Z101`.
- Row 1 is headers; at most 100 data rows and 26 columns are loaded. The UI
  explicitly states this bound. Larger inputs need separate small worksheets;
  nothing beyond the range is silently imported.
- Cell strings are at most 5,000 characters; a loaded range or export is at
  most 200,000 UTF-8 JSON bytes. Request bodies are streamed with a 16 KiB cap.
- Explicit import batches contain 1–5 distinct selected rows. Name is required
  (1–120 trimmed characters); email must be valid and at most 254 characters;
  category is personal/professional/community or the chosen default. Interests
  are comma-separated, up to 20 entries of at most 40 characters. Notes may be
  null or at most 5,000 characters. Invalid rows block confirmation, not silent
  coercion/truncation. Each source column may be mapped only once.
- Duplicates are skipped, never merged or overwritten: compare nonempty emails
  case-insensitively when both exist; otherwise compare trimmed names. Distinct
  nonempty emails are not conflated. The database serializes import batches per
  owner, including Contacts and Sheets, and rechecks duplicates transactionally.
- Export selects 1–100 distinct owned contact IDs and a subset of the five
  allowed fields. Contact ownership is enforced in the query and rechecked
  immediately before confirmation. The preview is a server-held snapshot;
  changed contact values are not silently substituted after review. The first
  1,000 contacts are available in the chooser; the UI discloses truncation.
- Export writes one header row plus selected rows to a new `Contacts` worksheet
  using a fixed range and `valueInputOption=RAW`. All values are strings. Text
  beginning with `=`, `+`, `-` or `@` remains literal text rather than an
  executable formula. `USER_ENTERED` and append are never used.

## Session, duplicate-click and uncertain-result safety

Sessions are encrypted with AES-256-GCM and bound to the owner, purpose and
random opaque session ID. Tables/RPCs are service-role only; cookies are
httpOnly, sameSite=lax and secure on HTTPS, scoped to the purpose's route prefix.
Tokens never reach browser storage or JSON responses and no refresh token is
retained. Original session/token lifetime is at most 15 minutes, not extended
by loading data. Changes use exact canonical Origin checks and one-time OAuth
state with PKCE. Provider redirects are disallowed; errors are sanitized and
not logged with credentials or contact payloads.

Final confirmations submit only the stored preview's random action ID. They
cannot supply alternate contacts, spreadsheet IDs or cell values. A client ref
blocks same-tick double clicks; a server lease and persisted operation state
handle separate requests. New connection creation is atomic by owner/purpose:
row/advisory locks reject an active lease or protected action even if a new
browser has no cookie, and close the gap between a cookie precheck and a
concurrent confirmation. Action checkpoints set a persistent protection marker;
reads, OAuth consumption, final saves and stale leases never clear it. Reconnect
after any action requires checking its result and explicitly ending that purpose
connection (or original session expiry). The same connected session can still
prepare subsequent batches after completion. Every operation checkpoints its intent before the
external action and retains that state on uncertainty.

Export creates a file only after confirmation, then checkpoints the returned
file ID **before** writing any contact data. A lost creation response may leave
an empty sheet. Because Sheets create has no caller-provided idempotency key,
the app never automatically retries creation, even if a provider error might
mean the request did not execute. Check Google Drive manually before explicitly
ending the session and starting another export.

After a known ID, an uncertain RAW write may be reconciled with the **Check
existing export (read only)** button. This reads the exact expected rectangle
and marks completion only if it matches the stored preview, allowing omitted
trailing blank cells. A mismatch stays uncertain. It never rewrites, appends,
deletes the sheet or undoes user edits. Repeated confirmations return the same
operation status without another provider write. A new preview is blocked while
an operation is unresolved. If the transient session expires, check Google
Drive/contacts manually before deliberately starting a fresh session.

## Verification

Focused tests: `lib/google/sheets-data.test.ts`,
`lib/google/sheets-routes.test.ts` and `lib/google/sheets-ui.test.tsx`; the last
is a deterministic component-event harness, not a browser test. Shared connector and SQL tests remain
applicable. All provider traffic is mocked, all sample identities synthetic.
The implementation does not run `scripts/smoke.mjs`, production migrations or
real OAuth during tests. See the parent integration report for exact aggregate
checks and browser-QA results; a unit-test pass is not a live Google claim.

Official references checked during implementation:
- https://developers.google.com/workspace/sheets/api/scopes
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update
- https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption
- https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
