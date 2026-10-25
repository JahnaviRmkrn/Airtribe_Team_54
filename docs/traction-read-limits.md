# Traction read completeness and finite limits

Traction uses a service-role client, **not owner-scoped RLS**. This change does
not add anonymous database access or change the public ledger's exclusions and
privacy projection. Only the referenced organizers are looked up, never all auth
users. The public page still renders anonymous numbered guests/rooms, not names,
IDs, organizer emails or room tokens.

All three sources are complete-or-error: attendees, votes and each referenced
meetup-ID chunk. Ascending ID keysets continue after short pages. A candidate
empty SELECT is followed by an **exact HEAD count with identical filters and
cursor**; only count zero establishes the end. Null/malformed SELECT data,
missing/null/positive/error HEAD counts, later-page errors and exhausted budgets
raise an error. They must not become partial totals or be relabeled as unknown
organizer exclusions. The existing page catches a failed load and displays its
load-error message instead of a success headline/funnel.

## Per scan and aggregate budgets

- Requested page size: 1,000. A lower backend cap is supported only within the
  remaining finite budget; there is no unlimited scan guarantee.
- Each `allById` scan or meetup chunk permits 51 SELECT page attempts, including
  its terminal empty probe, plus one independent HEAD verification. Exactly
  50,000 rows at a 1,000-row cap still succeeds (50 nonempty + one empty + HEAD).
  A 50,001st unique row fails. A sufficiently low cap can fail sooner on requests.
- Raw pages are checked before normalization: array, at most the requested row
  count, nonempty string IDs and received ascending order. Repeated IDs within
  or across advancing pages retain the legacy dedup behavior; sorting never
  hides bad order, and duplicate-only/nonadvancing pages cannot imply emptiness.
- Standalone `allById`: 50,000 unique rows, 52 total queries, 16 MiB and 10 seconds.
- `readTractionData` shares one aggregate envelope across both event streams and
  all meetup chunks: 150,000 collected rows, 1,604 queries, 32 MiB and 10 seconds.
  The normal-cap request allowance is `2 × 52 + 500 × 3`: two 50,000-row streams
  and up to 500 chunks of 100 referenced rooms, each requiring one data page,
  an empty probe and HEAD. Lower caps spend this same allowance, not a new one.
- Raw data-page JSON bytes are counted **before dedup** across the load. The
  unchanged shared reader additionally bounds collected and returned JSON.
  Query counters describe application query invocations, not a guarantee about
  every internal SDK retry or underlying network byte allocation.

Attendee `joined_at` and vote `created_at` share the same load-start cutoff and
same supplied lower bound on every page and HEAD. Meetup queries retain the
fixed referenced `.in()` chunk and ascending `.gt()` cursor on every page/HEAD.
This avoids offset drift, **not a transactional snapshot**: edits, deletes or
backdated inserts during a scan can still affect results.

## Organizer lookup behavior

Relevant organizer IDs are deduplicated, capped at 50,000, and looked up at most
four at a time. The production load carries the shared remaining deadline into
these lookups with a separate abort race; it stops scheduling new users once
expired. A hanging SDK lookup cannot keep the page waiting indefinitely. Admin
SDK transport cancellation is not promised: an already-issued lookup may finish
later, but it cannot publish a late result or start the remaining backlog.
Listeners are removed as each attempt settles; the shared timer is cleaned up.

Ordinary missing-user/email or lookup failures remain `organizer_email: null`,
so the existing ledger reports genuinely unverified visits separately. Expiry
is **not** swallowed into this fallback: it fails the complete load. Calling the
standalone `organizerEmails` helper without a signal retains its prior lookup
semantics; the production `readTractionData` path always supplies the load signal.

## Automated evidence

`lib/traction-read.test.ts` checks all three capped sources, exact HEAD behavior,
cutoff/chunk preservation, duplicate and raw-order checks, 50,000/50,001
boundaries, finite low-cap/per-load budgets, raw bytes, identity failures and
hanging-lookup deadline cleanup.

`tests/traction-complete-page.test.tsx` runs the checked-in **page + reader +
shared helper + ledger**, with the actual Supabase query builder over a fixed
in-memory synthetic transport. All three sources capped at two produce five
completions and zero unverified exclusions. Later errors, a cap changing from
two to zero, missing HEAD counts and exhausted request budgets show the real
page's load error, never partial success totals. Private values do not appear in
rendered HTML. Missing identities retain the distinct unverified disclosure.

Only admin-client construction, synthetic auth lookup and Next cache plumbing
are substituted there. It is not a real PostgREST/Next server, live cache,
Supabase Auth, real provider or native-browser test. A later SQL/native fixture
must document its own boundaries separately; these tests do not establish it.
