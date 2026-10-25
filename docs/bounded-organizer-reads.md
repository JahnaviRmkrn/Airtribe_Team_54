# Complete, bounded organizer reads

`GET /api/me/contacts`, `GET /api/me/followups`, `GET /api/me/dashboard`,
`GET /api/me/meetups`, and the interaction-history collection in
`GET /api/me/contacts/:id` preserve their successful JSON shapes. They
now return all matching rows within a per-request safety envelope, or an
explicit HTTP 503 error. A partial dataset is never presented as a complete
contact list, an exact dashboard count, or an empty follow-up list.

## Confirmed failure and verification boundary

At source revision `211433ba7eeb59572ba20685682fba7d5d06599b`, a credential-free
eight-test audit used the actual route functions and Supabase JavaScript query
builder with a capped in-memory HTTP transport. It established that 1,001 owned
contacts produced a successful response with only 1,000 contacts and no warning.
A cap of two also hid an upcoming follow-up, a community contact, an overdue
check-in and a meetup; three recorded interactions were reported as two, changing
`sufficient_data` from true to false. A separate PGlite test used actual owner RLS
and reproduced the contact omission without leaking another owner's rows.

The regression tests now require complete results. These tests are not a live
Supabase, provider, production load or browser test. The PGlite adapter checks
cancellation at query entry/exit but does not interrupt a running SQL statement.
The HTTP transport test separately checks that Supabase receives the abort signal.

A subsequent five-test audit at `609f14e` confirmed successful truncation of
the full Meetups list and contact interaction history, at both two-row and
1,000-row backend caps. Real PGlite owner RLS reproduced both omissions without
returning Bob's private rows. These two collection reads now use the same
complete-or-error helper. The contact ownership lookup still precedes history:
a foreign or missing contact returns 404 before any history query. Meetup room
URL construction and all mutation paths remain unchanged.

The Meetup/history continuation passed 98 focused tests, including 13 new
real-SDK/PGlite cases for caps of two and 1,000, newest-first microsecond/offset
ordering, late-page errors with no partial response, incoming cancellation,
foreign-owner early 404, room URLs and the unchanged recent-activity cap.
Related contact/history/privacy and meetup mutation regressions, scoped
TypeScript, scoped ESLint and diff checks passed. No server, browser, full build
or live service was used for this continuation.

Initial bounded-list validation: 100 tests passed across the bounded-read, contact
history/dashboard, contact-create, room-privacy and organizer-adapter suites;
the actual-handler organizer HTTP smoke also passed and stopped its listener.
Scoped TypeScript checking, scoped ESLint and diff whitespace checks passed.
Tests ran with a cleared environment and no repository environment-file loading.
No full suite/build, live backend, browser run, deployment or migration was
performed for this change.

## Safety envelope

`lib/complete-read.ts` applies these limits to the collection reads in a request,
shared across the dashboard's contacts, goals, interaction and meetup collections.
Authentication and the contact detail's existing single-row ownership lookup
precede this scan budget; the final detail payload's byte budget includes the
contact itself as well as its complete interaction history:

- At most 100 requested rows per database page.
- At most 10,000 rows collected across all collections.
- At most 128 database requests, including empty terminating pages and exact
  HEAD emptiness probes.
- At most 4 MiB of collected serialized UTF-8 page data, and separately at most
  4 MiB for the final serialized response. The second check accounts for contacts
  repeated in dashboard collections. Full contact notes are included in the size
  checks, not silently omitted or truncated.
- A ten-second total data-read deadline, with the same abort signal passed to
  Supabase queries. Incoming request cancellation also aborts the read. A promise
  race bounds waiting even if a transport ignores cancellation.

These are conservative application response budgets, not changes to a project's
PostgREST global maximum. A large account, very low server page cap, or unusually
large notes can reach a budget and receive 503 instead of a partial result. A
retry cannot by itself resolve an account permanently over the size/row budget;
supporting those accounts requires a separately designed paginated API/UI, not
silently raising a global cap. The existing UI can display the returned error.

The byte guard runs after each page is decoded. It bounds accumulated accepted
data and successful responses, not bytes already received for one oversized page.
No database constraints or streaming transport limits are changed here.

## Ordering, isolation and concurrency

Pages use the authenticated `requireUser` Supabase client and existing filters;
no service-role client or new SQL function is introduced. Contacts, interactions
and meetups advance on their immutable UUID `id`. Goals advance on their unique
category within the owner, using the actual PostgreSQL enum order: personal,
professional, community.

Any nonempty page advances the cursor, even if its size is smaller than the
requested page size. An empty page triggers one exact-count HEAD request with
the same RLS client, filters and cursor. Only a known count of zero terminates
the scan. A zero-row server cap, even one changed mid-scan, cannot silently turn
remaining data into an apparently empty result. Missing, positive or failed
counts produce 503. Counts are not requested on every nonempty page.
Duplicate, backward,
missing or invalid keys, oversized pages and errors after partial progress fail
the complete request. The HEAD query shares the request/deadline budget; a
database count timeout also fails explicitly rather than guessing completeness.

After scanning, contacts are alphabetized using the server JavaScript locale,
follow-ups are sorted by due date, and interactions are newest first. Dashboard
meetups use start date with nulls last; the full Meetups list retains newest
`created_at` first. Equal names/dates are stabilized by UUID. Timestamp
comparison retains PostgreSQL's microsecond precision while normalizing time-zone
offsets; it does not round ties to JavaScript milliseconds. Name collation follows
JavaScript rather than an arbitrary deployment-specific PostgreSQL collation.

Keyset pagination avoids offset drift when earlier rows are deleted. It is not
a transaction-wide snapshot: concurrent inserts behind a cursor or edits during
a scan can require a refresh, and the dashboard collections can reflect slightly
different instants. No cross-query snapshot or transactional aggregate guarantee
is claimed. Stronger consistency would require a separate database/API design.

Contact creation, Google imports and all contact/meetup mutation handlers and
their payloads are unchanged. Recent activity intentionally remains limited to
at most 100 rows and is not converted to a full-history endpoint. A contact
imported or created before a scan begins is not omitted
merely because an earlier backend page was capped.

## Official reference sources, checked 2026-10-25

- [Supabase select and exact-count options](https://supabase.com/docs/reference/javascript/select).
- [Supabase project row limits](https://supabase.com/docs/reference/python/select):
  projects default to a maximum of 1,000 rows, configurable in API settings.
- [Supabase range ordering and inclusive bounds](https://supabase.com/docs/reference/javascript/range).
- [Supabase abortSignal](https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal):
  the supplied signal is attached to the underlying fetch request.
- [PostgREST pagination](https://docs.postgrest.org/en/stable/references/api/pagination_count.html):
  a server may return fewer rows than requested; range/count information is
  separate from the JSON array.
- [PostgREST db-max-rows](https://docs.postgrest.org/en/stable/references/configuration.html#db-max-rows):
  the maximum is a hard row cap, intended to bound accidental or malicious payloads.
