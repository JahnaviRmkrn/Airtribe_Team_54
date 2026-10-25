# Room capacity and stale-write boundary checks

`tests/room-capacity-routes.test.mjs` exercises the real join, preference, vote,
confirmation and close handlers through an in-memory PGlite database. It uses
the existing test adapter, real SQL triggers and RLS, synthetic identities and
cookies, mocked rate limits, and a fetch stub that rejects outbound requests.
The Vault migration is skipped without reading it. No server or live database,
provider, account, payment, migration rollout or deployment is involved.

## Covered boundaries

- Guests 49 and 50 can join; guest 51 receives `429 Room is full`, with no new
  attendee or cookie. A full room does not consume another room's capacity.
- If another handler takes the last slot after a join's lookup, the stale join
  is rejected. A multi-row SQL insert that would exceed capacity rolls back
  the entire statement, not just the final guest.
- An existing guest cannot accidentally join twice at capacity. Their identity
  is retained, and they can still edit preferences. Confirmation still allows
  later joining within capacity while freezing voting; this policy is unchanged.
- Closed/expired changes committed between handler reads and writes reject
  joins, guest edits, vote insertion/replacement/withdrawal, and first venue
  confirmation. Rejected guest writes preserve existing rows and cookies.
  Changes to confirmed state also freeze in-flight vote changes.
- A closed room encountered at write time produces 410. An expired room first
  discovered by the next lookup produces the documented 404. Repeating a close
  remains supported, as does repeating the same confirmation while open.

## Reproduced response defects and minimal correction

Before the correction, six new assertions failed:

1. Repeating the same venue confirmation across a committed close returned 200
   and the old open-room snapshot.
2. The equivalent expiry interleaving also returned 200 with stale room data.
3. Confirmation returned an outdated title after a committed title change.
4. Closing a deleted room reported success despite updating zero rows.
5. Closing a newly expired room returned the stale, readable room snapshot.
6. Closing after another request confirmed a venue returned a null final venue
   even though the database correctly retained the confirmation.

Confirmation and close now select the current room fields from the UPDATE
result and render that row, rather than reconstructing it from the earlier
lookup. Confirmation rechecks its returned open/expiry state. Close requires a
returned row and does not expose expired room data. No SQL trigger, migration,
capacity limit or joining/confirmation policy changed.

This is a response/state-truthfulness correction. An already-confirmed
same-value database update remains permitted by the existing SQL trigger and
may touch its update timestamp before the handler reports a stale closed or
expired state. A restrictive close may likewise commit after expiry, but its
response is 404 rather than an exposed expired room. No new rollback guarantee
is claimed for those organizer metadata updates.

## Validation and limits

Focused, single-worker tests pass:

- `tests/room-capacity-routes.test.mjs`: 29 tests, including generic close-error
  responses that do not expose internal database details.
- `tests/room-state.test.mjs`: 7 tests.
- `tests/room-preferences.test.mjs`: 18 tests.
- `tests/room-privacy.test.mjs`: 10 tests.

Run these with a clean environment and the repository's installed Node/Vitest:

```sh
env -i PATH="/path/to/node/bin:/usr/bin:/bin" NODE_ENV=test \
  node node_modules/vitest/vitest.mjs run \
  tests/room-capacity-routes.test.mjs tests/room-state.test.mjs \
  tests/room-preferences.test.mjs tests/room-privacy.test.mjs \
  --maxWorkers=1 --no-file-parallelism
```

The adapter intentionally implements only the query operations needed by these
tests. PGlite serializes statements; the one-shot write-boundary hooks prove
deterministic committed interleavings, not simultaneous independent PostgreSQL
connections, lock-wait behavior, PostgREST transport, production clock behavior
or load safety. Browser tests, live-provider checks, a full suite, a full type
check and builds are outside this bounded validation.

## Browser request ordering

The room page coalesces polls while a read is pending, so healthy responses
slower than the polling interval are not continually discarded. It ignores an
older poll after a mutation starts; a fresh post-mutation read may begin without
waiting for that obsolete transport. Refresh GETs have a 15-second timeout and
abort signal; waiting is bounded even if transport ignores abort, and the next
poll can recover. This timeout never retries a mutation. It does not start refreshes while a manual mutation or direct voice-tool
send is pending. This includes visibility-triggered refreshes, not just the poll
timer. Direct voice sends invalidate snapshots on both start and completion;
the existing voice caller requests a fresh view afterward.

A current 404 makes the room terminal until page reload: polling stops, pending
reads cannot restore the old page, and stale payment responses are invalidated.
Stale 404/network errors cannot replace a newer successful view. Recoverable
401/409/410/429 mutation errors perform a fresh GET only after releasing the
mutation lock; no mutation is automatically retried. Responses after navigation
to another path are ignored.

`tests/room-refresh-order.test.mjs` executes the shipped request functions with
controlled, out-of-order response promises. Rendering, DOM and transport are
synthetic. This establishes client-side ordering, not multi-connection database
serialization, live browser/account isolation, or a transaction snapshot. A
newer authoritative GET may legitimately reflect subsequent changes by others.
