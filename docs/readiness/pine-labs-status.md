# Pine Labs toolkit checkout

The user selected completion of toolkit-backed checkout. The app calls `@plural_pinelabs/agent-toolkit` server-side; an LLM does not decide payment actions.

Both guest-room implementations now expose Your payment after joining and venue confirmation. Guests explicitly click Pay to POST `/api/rooms/:token/pay`; the server determines their INR amount from the confirmed venue, creates or resumes the toolkit order, and supplies its HTTPS checkout URL. Check payment status performs GET and shows pending/paid/failed/cancelled. Page load checks status, including on return from checkout, but never initiates an order or trusts `?payment=done` as proof of payment. Closed rooms allow status checks but disable new checkout. Duplicate clicks are suppressed.

The existing server order remains authoritative. Paid orders are reused, provider status is persisted before reporting it, and a price change cannot overwrite an existing pending order. Such a conflict must be reconciled by the organizer. Provider error details are not logged because SDK errors can include credentials. Checkout URLs must be HTTPS without userinfo; amount conversion rejects unsafe integers.

## Current verification boundary

Unit tests exercise UI status transitions, explicit-only redirects, duplicate requests, closed rooms, missing configuration, unsafe URLs, toolkit arguments and status mapping. These use mocks; they are not Pine Labs UAT receipts. No real order or payment has been made.

Neither checkout contains `PINE_CLIENT_ID` or `PINE_CLIENT_SECRET`. The hackathon AgenticOrg login is separate and cannot authenticate the payment toolkit. An administrator must supply merchant UAT credentials, as required by the [official toolkit documentation](https://www.pinelabs.com/docs/online-payments/ai/agent-enablement-toolkit).

## UAT completion checklist

1. Put merchant UAT credentials in ignored `.env.local` and later server-only Vercel env vars; set `PINE_ENV=uat`. Set `NEXT_PUBLIC_SITE_URL` to the verified HTTPS deployment. Apply hosted migrations including `meetup_payments` and `hit_rate_limit`.
2. Create a dedicated test meetup, join with a fictional guest, and confirm a priced venue. Click Pay; inspect the merchant dashboard order and ensure amount/currency match. Use only provider-documented test payment details.
3. Return to the room and check status. Verify pending does not become paid from URL parameters, successful captured payment becomes paid from getOrder, and repeat Pay does not create a second order. Rehearse failed/cancelled outcomes and retry.
4. Verify another guest cannot see or resume the first guest's payment. Close the room; new checkout must fail while status checks remain available.
5. Save sanitized order/status receipts and a recording of this UAT flow. Do not publish checkout tokens, guest cookies, or merchant secrets.

Known operational limits: there is no webhook or background reconciliation worker; guests refresh status via GET. Known order receipts now support database-only recovery; an upstream outcome without a recoverable ID still requires merchant reconciliation using the persisted reference (see below). Do not advertise unattended production payment reliability until these recovery paths are implemented and exercised. A completed payment is not a venue booking or reservation.

## Creation uncertainty and receipt recovery (2026-10-25)

Apply `20261025120000_payment_attempt_receipts.sql` with this application version before enabling checkout. This change has only been exercised locally with synthetic providers and in-memory PostgreSQL, not against hosted databases, merchant accounts, UAT, real charges, or deployments.

- Each guest attempt reserves a unique merchant reference on `meetup_payments` and a `meetup_payment_attempts` row before calling the provider. The provider receives that exact persisted reference and server-computed amount. References and provider order IDs are excluded from guest API responses.
- A timeout, malformed success response, connection failure, or process crash is an unknown outcome, not proof of failure. The claim never expires. The two-minute threshold changes only the guest-facing message to `reconciliation_required`; it never starts another order.
- A successful provider response is saved as a separate immutable order receipt before attaching it to the current payment. Lost database acknowledgements are read back before a bounded, idempotent database-only retry. A later authenticated GET/POST can attach the same saved receipt, even for a closed room through GET. No error path blindly cancels an order or retries provider creation.
- If every post-provider persistence write fails, the order ID may still be unavailable, but the pre-call merchant reference remains durable and blocks another order. This is fail-closed recovery, not an exactly-once payment guarantee. If the process stops before provider invocation, it may also require manual reconciliation rather than risk a duplicate.
- Provider-confirmed failed/cancelled orders with known IDs can still be retried, using a fresh reference and retaining prior receipts. Paid orders and pending orders whose venue price changed keep the existing safeguards. Legacy failed/cancelled rows without a provider order ID become pending/unknown during migration because old code could have incorrectly treated a lost response as failure.
- The migration also rejects updates that reclaim or mark failed an unknown pending/no-ID attempt, protecting these rows from the previous application's timeout-retry path. Stop/drain old app instances for rollout: they cannot provide this version's receipt recovery or messaging. This is not a live deployment instruction executed by the test suite.

### Reconciliation boundary

The [official toolkit documentation](https://www.pinelabs.com/docs/online-payments/ai/agent-enablement-toolkit) documents `getOrder` by provider order ID. This implementation does not assume the merchant reference is a provider idempotency key or that the toolkit can look up/replay orders by that reference. The pinned 0.1.5 create implementation was also inspected locally: it performs a single checkout request through `requestWithToken`, with no transport retry. No new provider API capability is invented here.

Guests see “do not pay again” guidance and can check status. Organizers can read only their own attempt receipts under RLS; anonymous guests and other organizers cannot read those receipts, and organizers cannot edit them. There is intentionally no guest-facing “clear pending” or “force retry” endpoint.

For an unknown outcome, a separately authorized merchant operator must reconcile the persisted reference, guest/payment identity, amount, currency and actual provider status using verified merchant records/support. Only after a matching provider order and safe checkout URL have been established may that same attempt's receipt be populated by an authorized service-side operation; the next guest status check can recover it and query provider status. Do not delete/reset the pending claim, mark it failed from a timeout, re-create the order, or cancel an order merely because a database acknowledgement was lost. A confirmed “no order exists” outcome currently has no automated release workflow. Legacy attempts without a persisted reference may need additional manual investigation. A total loss of both local records and provider evidence cannot be repaired automatically.

No webhook, background reconciler, merchant reconciliation UI, or live checkout verification has been added. Do not advertise unattended production payment reliability. Deleting the parent meetup/guest still cascades existing payment records; preserve unresolved payment evidence operationally before destructive account/room maintenance.

### Offline verification

`tests/pay-route.test.mjs` injects slow provider responses, provider-committed/lost responses, receipt/payment write failures before and after commit, missing write acknowledgements, unavailable recovery reads, and legacy unknown rows. `tests/payment-attempts-sql.test.mjs` runs the real routes and guest authentication with in-memory PostgreSQL, proving durable-before-provider references, concurrent claim uniqueness, recovery after closure, immutable receipts, old-code fencing and organizer/guest RLS boundaries. `lib/checkout-ui.test.ts` and `tests/payment-panel.test.mjs` cover both checkout UIs, explicit-only redirects, duplicate clicks, unknown-outcome locks and status-based recovery. These are synthetic receipts only.
