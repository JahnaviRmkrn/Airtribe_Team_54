# TLA+ models

Two models of the concurrent parts of the app. TLC checks every interleaving
within small bounds. They check the design, not the TypeScript itself.
`scripts/smoke.mjs` checks that the running code behaves the way the room model
assumes. Nothing checks the running checkout against the payment model:
`smoke.mjs` never calls the pay route, and `lib/pay-route.test.ts` covers single
requests, not the concurrent interleavings the model explores.

```bash
# needs Java 11+ and tla2tools.jar (github.com/tlaplus/tlaplus/releases)
pnpm tla                # meetup room, current code
pnpm tla:payments       # guest checkout, current code
java -cp tla2tools.jar tlc2.TLC -deadlock -config MeetupRoom_large.cfg MeetupRoom
java -cp tla2tools.jar tlc2.TLC -deadlock -continue -config MeetupRoom_PR1.cfg MeetupRoom
java -cp tla2tools.jar tlc2.TLC -deadlock -config MeetupPayment_large.cfg MeetupPayment
```

`-deadlock` is needed because both models have intended terminal states (every
request finished, references used up). Large runs write their state queue to
the working directory, or pass `-metadir`.

## Meetup room (`MeetupRoom.tla`)

Each guest request is two steps, like the real handlers: the API checks a room
snapshot, then the DB write commits. Organiser close/confirm, room expiry and
follow-up recording can interleave between those steps.

Invariants: no guest write commits to a closed/expired room, the 50-guest cap
(scaled down) holds, no vote or vote withdrawal after a venue is confirmed, only
members vote, `last_interaction_at` equals the newest recorded interaction.
Temporal properties: a confirmed venue never changes, a closed room never reopens.

| Config | Models | Result |
|---|---|---|
| `MeetupRoom.cfg` | current code (3 guests, cap 2) | no errors, 73,824 states |
| `MeetupRoom_large.cfg` | current code (4 guests, cap 3, 3 interactions) | no errors, 3,158,016 states |
| `MeetupRoom_PR1.cfg` | PR #1 logic (API checks only) | violates NoWriteToClosedRoom, CapacityRespected, NoVoteAfterConfirm, NoUnvoteAfterConfirm, LastIsLatest |
| `UnvoteGuarded = FALSE` | PR #2 logic | violates NoWriteToClosedRoom (vote withdrawal after close), fixed by `20261024110000_unvote_guard.sql` |
| `ConfirmFreezesVotes = FALSE` | before `20261024130000_room_state_guards.sql` | violates NoUnvoteAfterConfirm: the withdrawal passes the API check, the organiser confirms, then the DELETE commits |

## Guest checkout (`MeetupPayment.tla`)

One guest's payment row, attempt receipts and provider orders
(`app/api/rooms/[token]/pay/route.ts` and the payment migrations). Several POSTs
for the same guest run at once, statement by statement, and any of them can stop
between two statements. `createOrder` can succeed, fail, or create the order and
lose the response. GET (receipt recovery and status refresh) and the provider
(guest pays, order fails or is cancelled, refund) can act at any time.

Invariants:

- `AtMostOneCharged`: no double charge.
- `NoUntrackedOrder`: every provider order has a local attempt row.
- `RowOrderIsOwn`, `ReceiptIsOwn`: the row and a receipt only ever hold the order created for their own merchant reference.
- `PaidIsTracked`: money is never taken on an order the row no longer tracks.
- `PaidMeansPaid`, `ExposedTracked`: a paid row really is paid, and the guest is only shown checkouts that are tracked.

Temporal property: a paid row stays paid.

| Config | Models | Result |
|---|---|---|
| `MeetupPayment.cfg` | current code (2 concurrent requests, 3 references) | no errors, 79,213 states |
| `MeetupPayment_large.cfg` | current code (3 concurrent requests, 4 references) | no errors, 19,547,001 states |
| `NoClaimCAS = TRUE` | retry claim without the `updated_at`/`status` filter | violates AtMostOneCharged, PaidSticky |
| `CreateFirst = TRUE` | call the provider before inserting the attempt row | violates NoUntrackedOrder |
| `SaveIgnoresRef = TRUE` | saveOrder without the `merchant_order_reference` filter | violates RowOrderIsOwn |
| `FailedIsTerminal = FALSE` | a Pine Labs order in `FAILED` can still be paid | violates AtMostOneCharged and PaidIsTracked |

Vacuity checks: `NeverPaid`, `NeverRetried` and `NeverRecoverable` are each
violated when used as the only invariant, so payment, retry with a fresh
reference, and receipt recovery are all reachable.

**Assumption to confirm with Pine Labs.** The retry path (a new order after the
row is `failed`) is only safe if an order whose status is `FAILED` can never be
paid later. Otherwise the guest can pay the old checkout link and the new one
(shortest trace: order 1 fails, the row syncs to failed, the retry creates order
2, the guest pays order 1 and then order 2). Pine Labs documents that a failed
payment on a pending order moves the order to `ATTEMPTED`, which can be retried
and which `mapOrderStatus` maps to pending. Its order lifecycle page does not say
whether `FAILED` is terminal.

Not modelled: the venue price changing between attempts (409 path), organiser
reconciliation of uncertain attempts, `cancelOrder`, the legacy read-only mode,
and the rate limiter.
