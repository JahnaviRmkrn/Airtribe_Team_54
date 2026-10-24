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

Known operational limits: there is no webhook or background reconciliation worker; guests refresh status via GET. A crash between upstream order creation and saving its ID requires merchant-dashboard reconciliation. Do not advertise unattended production payment reliability until these recovery paths are implemented and exercised. A completed payment is not a venue booking or reservation.
