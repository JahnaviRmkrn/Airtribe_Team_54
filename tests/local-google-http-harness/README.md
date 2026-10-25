# Google UI → HTTP exports → local SQL fixture

This bounded test fixture joins the checked-in Google UI to the **actual route
exports**, real encrypted connector sessions/action previews and import/claim SQL
running in in-memory PGlite, followed by an ordered synthetic provider transport.
It does not fake successful application API responses.

Run only from an isolated test checkout with the existing dependencies installed:

```sh
./tests/local-google-http-harness/run.sh smoke
# The sole coordinated browser operator may then run:
./tests/local-google-http-harness/run.sh serve
```

The launcher starts under `env -i`, `NODE_ENV=test` and an empty Vite env directory.
It never installs a package, builds/starts Next, reads local env/Vault/credential
files, connects a live database or provider, applies a remote migration, deploys,
or creates a real OAuth grant. The only listener is **127.0.0.1:4323**, with no
port/interface fallback. Smoke shuts down automatically; serve first repeats the
same smoke, resets the fixture, and prints `LOCAL_GOOGLE_HTTP_READY`. Serve ends
after 30 minutes, Ctrl-C, or the explicit stop control. The PGlite database and
in-memory browser bundle are disposed on exit. Temporary empty Vite directories
are removed too.

## What runs unchanged

- Organizer HTML/CSS/JS, including Google Contacts, Gmail and Calendar screens.
- The shipped `SheetsClient.tsx`, `sheets-data.ts`, CSS and installed React. Vite
  bundles them **in memory**, not into the app or `.next`; output goes only to the
  fixture response. The test entry mounts the component, with `next/link`
  explicitly replaced by an adapter for its one fixed internal back link.
- Google status/start/callback/preview/import/export/confirm/cancel/disconnect
  handlers and their production connector/action/provider helpers.
- The existing local Google database adapter and PGlite privacy migrations,
  excluding the Vault migration **before opening files**. No production schema
  is involved. Real SQL executes owner-bound session replacement/leases,
  duplicate detection/import, action creation/claim/transition and RLS queries.
- Selected read-only organizer profile/dashboard/contact exports, to show the
  contacts imported by these same local Google routes.

Status records SHA-256 hashes of the original source files, unchanged Sheets
client and generated in-memory bundle. JS/CSS are served byte-for-byte. HTML
responses alone prepend an exact, visibly labeled fixture safety script in the
head; source HTML is unchanged. Smoke verifies that exact adapter and verifies
the client source did not change during bundling. The adapter neutralizes
off-origin anchor/form targets (including dynamic insertions), intercepts click,
auxclick and submit, and rejects off-origin window.open across target variants.
It records aggregate blocked counts in a visible banner, never destinations,
queries or token values. This is test-only behavior, not production protection.

## Explicit synthetic consent boundary

Open `http://127.0.0.1:4323/__harness/` in the clean **synthetic-only** browser
context used for local tests. Purpose cookies use the actual app namespace and
path; do not mix real localhost sessions into that context.

1. Choose “Alice fixture owner” or “Bob fixture owner”. This sets a separate,
   test-only role cookie. Supabase Auth and JWT verification are not running.
2. Install the desired synthetic connection using a visible fixed button. The
   server invokes the actual start export and callback using one fixed fake code
   and a checked synthetic token response. Cookies, owner/purpose binding,
   encryption, PKCE state consumption and SQL are real application code.
3. This is **not Google consent**, not an OAuth grant, and not permission to use a
   live account. Browser-facing start/connect/callback operations return a clear
   fixture-boundary error rather than exposing a Google authorization URL.
4. Open the application screen from controls. Never click external spreadsheet
   result links and never enter real personal data, recipients or credentials.

Controls accept only exact field sets and enumerated actions: fixed role,
connection purpose, one fault target, reset or stop. There is no arbitrary SQL,
identity, URL, callback, token, provider response, record-count or fixture-body
injection endpoint. Unknown endpoints and unexpected control queries fail closed.

## Fixed inputs and browser acceptance

- Contacts: Existing Alice is a duplicate; New Person and Another Person are
  selectable. Select a category and only New Person, import, then verify that
  exactly that person appears in the real Contacts screen. Cancel/disconnect must
  discard the temporary preview without removing an already imported person.
- Sheets import: ID `synthetic_spreadsheet_00000001`, worksheet `People`.
  Columns A/B/C are Name/Email/Notes. Row 2 duplicates Alice, row 3 is Sheet Person,
  row 4 is Second Sheet Person. Map B to email; notes require the app’s explicit
  notes toggle/mapping. Preview, Back without importing, re-preview and confirm.
  Confirm must write only selected nonduplicate rows. Inspect Contacts afterward.
- Sheets export: install the separate export connection and choose the export
  tab. Destination is `destination@example.test`. Select contacts and fields,
  preview, Back without exporting, then confirm. Provider validation compares
  the exact saved snapshot, title and RAW values and checks real durable SQL
  checkpoints before each create/write. Do not open the synthetic external link.
- Gmail: sender `sender@example.test`, recipient `recipient@example.test`.
  Use synthetic subject/body. Review exact content, Back to edit or cancel, and
  confirm with sender acknowledgment. The stub compares the immutable MIME and
  SQL claim. It never sends mail or reads a mailbox.
- Calendar: no attendees or `recipient@example.test`, synthetic title/details and
  UTC start time. Preview/cancel/confirm; the stub checks the saved event body,
  deterministic ID and durable claim. No real event or notification is created.

The existing UI’s trusted native click requirements remain unchanged. Use normal
browser clicks/keyboard; no synthetic DOM click or bypass is introduced.

One-shot controls support lost receipts after a real Contacts/Sheets import
commit, and lost synthetic responses after one Sheets create/write, Gmail send
or Calendar insert. Other purposes do not consume an armed fault. Check status
and retry only through the app’s offered controls. Uncertain Gmail cannot be
resent. Calendar reconciliation is one exact read, not another insert. Sheets
write reconciliation reads only the existing export, never creates another.

Role switching intentionally preserves purpose cookies: an Alice connection
must not work for Bob. Normal tabs share cookies; use separate clean contexts
for simultaneous accounts. Reset clears this browser’s fixture purpose cookies
and all server data; reload other tabs afterward.

## Guard/evidence contract

Before app imports, global fetch is an exact ordered stub with **no network
fallback**. Imported HTTP clients permit only this exact loopback origin;
HTTPS/socket/TLS paths and additional servers are denied. Live Supabase/Auth,
secret readers and payment SDK imports throw. Filesystem read guards reject env,
Vault, app-secret, credential and authconfig paths. This is a bounded trusted-code
test fixture, **not an OS-level sandbox**.

HTTP requires exact loopback Host, same-origin mutations and non-cross-site
fetch metadata. Controls are exact JSON POSTs. Bodies, header sizes, connection
count, request duration, provider-call count and server lifetime are bounded.
Only enumerated assets/routes are served. Headers block external subresources,
connections, frames, workers and device permissions. These headers do not block top-level navigation. The separate response-only
safety adapter neutralizes external anchors/forms/windows. Neither it nor CSP
claims to intercept arbitrary location.assign/replace or address-bar input;
provider consent starts remain explicitly disabled at the fixture HTTP boundary.

The smoke exercises deny guards without opening the denied resources, resets
only those deliberate probe counters, and then requires:

- `external_transport_attempts: 0`
- `secret_access_attempts: 0`
- `internal_errors: 0`

Controls/status retain those counters for browser work. A nonzero counter is a
failed fixture boundary, even if the application caught the exception. Serve
also asserts counters on stop and prints `LOCAL_GOOGLE_HTTP_STOP_COUNTS`.
No cookie handles, OAuth states, token values, encrypted payloads or draft bodies
are logged. `provider_calls` contains only ordered operation labels; RPC counts
and SQL action states provide independent state-change evidence.

## Honest limitations

This checks browser UI → socket HTTP → shipped exports → local SQL → checked
synthetic transport. It does **not** check Next page routing, hydration,
middleware, production CSP, real Supabase Auth/JWTs, live PostgREST, HTTPS secure
cookies, real Google consent/API compatibility, real delivery, deployed schema
readiness or deployment behavior. The React Sheets component is mounted, not
Next-hydrated. Other organizer writes, payments, voice, assistant, live auth and
unrelated endpoints are deliberately unavailable. No live integration or product
readiness claim should be based on this fixture alone.
