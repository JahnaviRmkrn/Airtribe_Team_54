# Google route-to-SQL boundary tests (no server)

Run from a checkout with the dependencies already installed:

```sh
./tests/local-google-harness/run.sh
```

This focused, single-worker suite calls the checked-in `app/api` Google exports
with real `Request` objects and checks their `Response` status, headers and JSON.
It does not start a listener, browser, Next process, build or full test suite.
The launcher uses `env -i`, only safe runtime settings, direct installed Vitest,
and an empty temporary Vite environment directory. All client IDs, access tokens,
keys, cookies, users, email addresses, contacts, spreadsheets and events are
synthetic. No live account, provider, OAuth grant, service database, deployment or
remote migration is used or changed.

## Evidence added

Earlier Google route tests mock the connector/action store or emulate SQL with
arrays. Separate SQL tests exercise real functions. The organizer HTTP fixture
deliberately disables Google. This suite joins those previously separate layers:

- Actual Contacts, Sheets import/export, Gmail and Calendar route exports.
- Actual configuration checks, OAuth callback state consumption, opaque cookies,
  encrypted owner/purpose-bound sessions, leases and readiness checks.
- Actual contact duplicate/import SQL, action preview/claim/transition SQL,
  immutable previews, durable receipts and owner-scoped RLS queries.
- Actual Google provider request construction, with an explicit, ordered mock
  transport for each exact URL and method. There is no live transport fallback.

Checks cover auth/origin/owner-intent rejection across all five purposes;
owner-bound callbacks and replay; Contacts preview/selection, committed lost
import receipt and deduplicating retry; Sheets mapping/duplicate previews,
confirmation/cancellation, uncertain import receipts, exact export snapshots,
RAW writes, unknown create/write outcomes and read-only reconciliation;
Gmail/Calendar preview/cancel/confirm, cross-purpose IDs and cookie substitution,
one durable claim before one write, uncertain delivery retained across reconnect,
lost claim receipts and successful-provider/lost-persistence receipts. Calendar
reconciliation calls only the exact event GET; Gmail does not read a mailbox.

## Fixture boundary and safety

Synthetic authentication and per-request cookie storage replace only Next's
request-context adapters and Supabase client construction. The existing limited
PGlite query adapter executes real PostgreSQL transactions with RLS, never a
network client. Its new opt-in IN predicate binds every value, caps lists at 100,
and preserves the default 100-row limit; the export contact chooser explicitly
opts into a validated maximum of 1001 rows. Google RPCs have fixed allowlisted
signatures and preserve PostgREST object-row/timestamp JSON shapes. Lost-receipt
faults run the actual transaction first, then discard only its returned receipt.

The existing privacy database fixture loads checked-in SQL only into in-memory
PGlite, through the Google session replacement migration, plus purpose readiness.
It excludes the Vault migration before opening files. The file-read guard denies
environment/Vault/app-secret paths. No environment files or credential modules
are read. Only synthetic configuration is installed during each test.

Fetch is guarded before application imports; unmatched requests throw and remain
test failures even if a production error handler catches them. Imported HTTP,
HTTPS, socket and TLS connection/server helpers throw. Live Supabase/Auth,
secrets and payment SDK imports throw. Explicit guard probes and after-test
counters verify no unexpected network or secret access. This is a bounded
trusted-code fixture, not an operating-system network sandbox.

## Limits

Passing this suite is not a browser or socket-level HTTP test. It does not prove
Next routing/middleware, real Supabase authentication/JWTs, browser cookie
serialization or secure-cookie handling, PostgREST transport, real Google
consent/API compatibility or delivery, deployed schema readiness, or deployment
behavior. Existing browser/UI and isolated SQL/unit tests remain complementary.
Do not enable a provider, perform a live action, or claim live integration
verification based on these results.
