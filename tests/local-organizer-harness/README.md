# Credential-free organizer integration harness

This **dev-only** harness extends the local room fixture pattern. It serves the
**unchanged checked-in organizer and room assets** and dispatches HTTP requests
to the **actual checked-in Next route functions**. Data is held only in PGlite's
in-memory PostgreSQL database, using the real SQL schema, triggers, functions,
and row-level security. There is no parallel implementation of the app API.
Nothing under `app/`, `lib/`, `public/`, Auth, deployment, or configuration is
modified by this harness. Its only synthetic API is the visibly separate
`/__harness/` fixture lifecycle/role control surface.

## Launch

Use the already-installed dependencies. Do not install packages, launch Next,
load `.env` files, run secret scripts, apply migrations to a service, or connect
any provider. Run from the checkout root:

```sh
# Default: receipts OFF, legacy saves work through the real route.
./tests/local-organizer-harness/run.sh smoke

# Optional: real in-memory receipt readiness/create SQL functions, not fake RPCs.
./tests/local-organizer-harness/run.sh smoke receipts

# Focused helper, real RLS/privacy, meetup-locking and contact-receipt regressions.
./tests/local-organizer-harness/run.sh verify

# Browser operator: launch in the native terminal connected to that browser's
# machine, not a different executor/network namespace. Do not launch a second
# copy if this port is already in use.
./tests/local-organizer-harness/run.sh serve
# Optional alternative, after stopping the first server:
./tests/local-organizer-harness/run.sh serve receipts
```

`serve` first runs the complete smoke and then resets to a clean seeded fixture.
Wait for `LOCAL_ORGANIZER_HARNESS_READY`. Open:

- Controls: `http://127.0.0.1:4319/__harness/`
- Organizer: `http://127.0.0.1:4319/organizer/`
- Manual onboarding: `http://127.0.0.1:4319/organizer/#/onboarding`

The server binds **127.0.0.1 only**, port **4319**, and never tries another host
or port on failure. `smoke` uses an ephemeral loopback port and closes on exit.
The launcher invokes installed Vitest directly under `env -i`, without package
scripts/hooks, and passes only PATH, NODE_ENV, synthetic harness mode and an
explicit local receipt toggle. Vite's envDir is an empty temporary directory,
removed on process exit. Checks use one worker; no production build is needed.
The database timezone is explicitly UTC, rather than a machine-dependent default.

## Browser exercise

Use **synthetic data only**. No real personal information, credentials, locations,
payment details, tokens, or cookies. Do not follow mailto/share links or send
anything to anyone. No browser exercise is implied by a passing HTTP smoke.

1. In controls, choose **Alice fixture organizer**, then open the organizer.
   Dashboard and profile should load. Add a contact with synthetic details,
   edit only its notes, log a call/check-in, and verify dates/history on reload.
   Delete the contact and verify it no longer appears in activity/history.
2. In Contacts, verify category filters and empty filters. On Profile, try goals
   totaling more than 100, then save a valid split and reload. These are real
   GET/PUT route calls and SQL upserts, not fabricated successful responses.
3. Reset with **empty Alice**, reload all tabs, choose Alice, and use manual
   onboarding. Test Back, add/remove rows, invalid goal totals, Save and finish,
   and reload persistence. Typed/voice extraction deliberately returns 503;
   enter contacts directly in the normal editable onboarding rows instead.
4. Create a meetup, open its edit form, change the title, reschedule, and clear
   an optional field. Reload and verify persistence. HTTP smoke additionally
   proves a GET's exact microsecond updated_at token succeeds unchanged and
   that replaying the stale token gets 409, not a false first-save conflict.
5. Open two normal tabs for a stale-edit UI check: load the same meetup editor,
   save in the first, then save in the second. Expect the real 409 reload
   message. Close the room and check closed edits are rejected (410).
6. Switch to **Bob** in controls and reload the organizer. Alice's private
   contacts, notes, goals and meetups must not appear. Alice detail URLs return
   404 through the real RLS-scoped handlers. Switching a shared browser account
   while an Alice save form is open should trigger the real owner-header guard.
7. Normal tabs share cookies and are not independent accounts. Use independent
   profiles/private contexts for simultaneous Alice/Bob or guest sessions.
   HTTP smoke uses independent cookie jars and verifies account/guest isolation.
   If only one browser context is available, report role switching as sequential.
8. Optionally visit a newly created room link and exercise guest joining/voting,
   then owner confirm/close. The original room fixture smoke is also included.
9. Provider screens/commands must fail closed with 503, never show a fabricated
   Google connection, payment, generated draft or successful voice session.
10. Stop the local server from controls or Ctrl-C when done. It automatically
    stops after **30 minutes** and discards the database.

Reset replaces all in-memory rows, invalidates this harness's old guest sessions,
and clears `org_` browser storage keys in the control page's origin. Reload all
other tabs because their in-memory UI state is not reset by the server. Role
changes do not silently erase another account's retry/draft markers. The empty
scenario removes Alice's contacts/goals/meetups only; Bob remains seeded. Alice's
fixed seeded room link is therefore unavailable until the seeded reset.

The organizer fixture role cookie is separate from the room fixture role cookie.
Only guest-cookie names issued by this server are cleared, so a separate room
harness running on another port is not logged out by these controls. This is
synthetic identity, not production security or a claim about Supabase sessions.

## Exact source versus fixture boundary

### Fixed large-contact scenario and one-shot read failure

The controls page adds **Reset with 1,001 Alice contacts**, **Fail next Contacts
second page**, and **Fail next Dashboard contact second page**. These controls
modify only this in-memory fixture; organizer/room assets and application routes
remain unchanged.

The bulk reset uses the existing reset endpoint with the exact body
`{ "confirm": "reset-local-fixture", "scenario": "bulk1001" }` and accepts no
extra fields. It seeds exactly 1,001 Alice contacts, not 1,001 additional contacts:

- Personal: 334; professional: 334; community: 333.
- Names: `Alice Bulk 0001` through `Alice Bulk 1000`, then
  `ZZZ Synthetic Alice 1001` (professional).
- Final marker UUID: `44444444-4444-4444-8444-000000001001`.
- Exactly two overdue check-ins: contacts 1 and 2, reset-day IST minus 3 and
  minus 1 calendar days. Exactly two upcoming check-ins: contact 3 at plus 2
  days and the final contact at plus 7 days. None is due today. All other
  contacts have no scheduled check-in.
- Alice's original contact and its interaction are replaced, leaving zero
  Alice recorded interactions. Her seeded goals and meetup remain. Bob keeps
  his one private seeded contact and interaction, goals and meetup. Aggregate
  fixture counts are 1,002 contacts, one interaction and six goal rows.

`bulk_expectations` in visible status supplies these expected seed counts,
synthetic due dates, reset IST day and final marker. It describes the reset
baseline, not fresh expected totals after an operator edits or deletes contacts.
Ordinary seeded and empty-Alice reset scenarios retain their original behavior.

The failure endpoint is `POST /__harness/read-failure`, with exactly
`{ "confirm": "fail-next-contact-page2", "target": "contacts" }` or the same
body with target `"dashboard"`. It requires the bulk fixture; invalid targets,
extra fields and arbitrary page/count/SQL input are rejected. A pending fault
cannot be overwritten. Every reset clears it and its counters.

Choose Alice, arm one target, then open/reload the matching screen. The Contacts
target matches only `GET /api/me/contacts`; Dashboard matches only
`GET /api/me/dashboard`. Bob, signed-out requests and the other API do not
consume it. A Dashboard screen can itself request the Contacts API for its
graph, so do not open Dashboard after arming the Contacts target if you intend
to exercise the Contacts screen specifically.

The first contact page executes real PostgreSQL under Alice's RLS role. The
test-only query adapter returns one database-style error on the second cursor
page, and the actual application handler produces the explicit 503. This is
not a fabricated whole-API failure response. `contact_read_failure` in status
shows `pending_target`, cumulative `armed_count`/`consumed_count`, and
`last_failure` with the target path, page 2 and `first_page_rows: 100`.
The next normal request succeeds without rearming. No real backend fault or
PostgREST transport is simulated beyond this explicit adapter boundary.

Both smoke modes retain all existing seeded/empty checks, additionally verify
the fixed bulk counts, Bob isolation, target scoping, real first-page evidence,
one-shot consumption, retry success and reset cleanup, then restore the normal
seeded fixture before browser serving. All existing external-service, secret,
origin/host, file and network guards remain active.

Actual handlers dispatched:

- `GET /api/me`, `GET /api/me/dashboard`, `GET /api/me/followups`
- `GET, POST /api/me/contacts`
- `GET, PATCH, DELETE /api/me/contacts/:id`
- `GET, PUT /api/me/goals`
- `GET, POST /api/me/interactions`
- `GET, POST /api/me/meetups`
- `GET, PATCH, DELETE /api/me/meetups/:id`
- `GET /api/rooms/:token`, `POST .../join`, `GET, PATCH .../me`,
  `POST, DELETE .../vote`, `POST .../confirm`, `POST .../close`

Explicitly **not implemented/executed**:

- Supabase sign-in, OAuth callbacks, production login/signout and middleware.
  `/login` and `/auth/signout` return 503; use synthetic controls instead.
- All Google connector/import/preview/action/provider handlers, including Gmail,
  Calendar and Sheets. Known provider paths return 503; other paths return 404.
- Extraction/assistant, generated contact drafts, voice token/signed URL/audio
  transcription, and payment routes. Their exposed paths return fixed 503.
- Real rate limits, PostgREST embedding/transport, actual JWTs, HTTPS cookies,
  remote payment/voice/LLM/Google/email/event delivery, production infrastructure,
  clipboard/share/mail client behavior, or full deployment end-to-end coverage.

The server forwards only content-type, X-Guest-Secret, Idempotency-Key and
X-Contact-Owner. Authorization/Bearer, x-test-user and forwarded-host headers
cannot select an identity. Query strings are retained (category, limit, days).
Entity IDs must match the fixture's UUID path allowlist; malformed IDs may be
rejected by that allowlist before reaching a handler.

Supabase admin/user-client construction is replaced with a **test-only limited
query adapter**. Every app data operation executes real SQL under a transaction-
local role and auth.uid(). The organizer options explicitly allow tables and
RPC names; relation projection is restricted to the actual interaction/contact
shape; the dashboard OR expression is a fixed validated shape with a bound
value. No arbitrary SQL, RPC name, relation expression, or URL is accepted.
`record_interaction`, and opt-in `create_contacts_once`/readiness, call the actual
SQL functions. Goals' default upsert conflict target is the schema's composite
primary key. Heterogeneous bulk rows use SQL DEFAULT for missing fields.

JSON row serialization happens **inside PostgreSQL**, preserving all timestamp
fractional digits and timezone offsets. No JS Date round-trip is used for
optimistic tokens. Existing adapter callers keep their original Date behavior
unless they explicitly opt into this mode. The optional abortSignal checks
entry/exit only; it does not claim to cancel an already-running SQL statement.

Receipts are **off by default**, including the real capability response. Legacy
single/bulk saves work, and identical names remain separate contacts. Keyed
requests return 503 rather than silently becoming unsafe unkeyed inserts. In
explicit receipt mode the actual local functions prove same-owner replay,
changed-body conflict, deleted-ID tombstones, and distinct owner scopes.
Changing the fixture mode does not enable any deployed feature.

## Safety and resource limits

- Exact asset/route/method allowlists; no repository directory browsing or generic
  file server. The checked-in organizer/room HTML, scripts and CSS are served
  byte-for-byte. Voice worklet/media access is not enabled.
- Exact Host authority and loopback client required. Foreign Fetch Metadata is
  rejected. Every mutation, including controls, requires the exact Origin.
  Reset and stop also require explicit fixed confirmation values.
- Self-only CSP; no external scripts/styles/fonts/images/connect targets, media,
  workers, frames or objects. Inline styles are intentionally blocked, so visual
  details can differ from production. Camera, microphone, geolocation, payment,
  USB and Bluetooth are disabled. No-store/no-referrer and DNS-prefetch off.
- Application fetch is replaced before imports by a throwing guard. Imported
  HTTP helpers permit only this precise loopback origin; HTTPS helpers throw.
  Guard probes execute no transport and counters must remain zero afterward.
  This is a bounded trusted-code fixture, not an OS-level network sandbox.
- Provider/credential modules are fail-closed mocks; Supabase SDKs and the Pine
  Labs SDK cannot be imported through the harness. The pure amount conversion
  helper is explicitly local, not imported from the payment provider module.
- The shared SQL fixture excludes the Vault migration without opening it.
  A file-read guard rejects environment/Vault/app-secret paths, and loaded SQL
  names are checked. This never reads `.env` or credential files. No database
  connection, external migration, deployment, config change, or push is made.
- Cookie and guest-secret values are never logged or printed by assertions;
  aggregate status contains only synthetic role/counts and safety counters.
  Application exception objects are suppressed and counted.
- 30-minute maximum lifetime; 5-second request/header timeout; 16 KiB body cap;
  8 KiB header cap; maximum 32 connections. Requests and resets are serialized.
  Stop, signals, deadline and cleanup close the listener and in-memory database.

## Reproducible proof and limits

Initial implementation base: `42163e3cb8e7da91411fd824342f42b0fb2cc535`.
The harness always serves the assets/routes of the checkout where it is launched;
rerun both smoke modes after integrating onto newer production code.

The HTTP smoke checks exact assets/security headers, host/origin/path denials,
independent cookies, synthetic Auth isolation, contact CRUD/validation/filters,
goals and empty-account onboarding saves, real interaction RPC/history and
followups, private dashboard projections, meetup create/edit/reschedule/close/
delete, precise/stale optimistic locking, direct RLS denials, legacy/optional
receipt behavior, disabled providers, zero unexpected network/provider/secret
access, fixture reset invalidation and shutdown. A passing automated smoke is
**not proof of a completed browser exercise**. Record browser observations and
browser/network/profile limitations separately.
