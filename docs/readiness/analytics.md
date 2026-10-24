# Analytics activation and event contract

Vercel Web Analytics is wired into the React layout and separately into the static organizer/room pages. The static pages bypass React's layout. Minimal success hooks were explicitly authorized by the user.

| Signal | Trigger | Counting boundary |
|---|---|---|
| Visit | Vercel pageview on landing/login/organizer/room | Pageviews are not unique registered users |
| `sign_up` | New password signup returns a user with identities and a current creation time | Password registration only; magic-link requests are not misreported as signups |
| `meetup_created` | Organizer POST `/api/me/meetups` returns 201 | Successful browser action only |
| `guest_joined` | Guest POST join returns successfully | Successful browser action, not organizer signup |

No event includes names, email addresses, transcript text, preferences, user IDs, guest secrets or room tokens. URL filters remove query strings and fragments and replace dynamic room paths with `/m/room`. Only generic organizer paths are retained. Analytics hooks are client-side to allow URL redaction before transmission; the Vercel server SDK can obtain the original token-bearing URL from request context.

Dashboard activation is still required: create/link the intended Vercel project, enable Web Analytics, confirm the account supports custom events, deploy this branch, then perform one real browser journey and verify the named events. No dashboard receipt has been observed. Local static pages deliberately skip analytics. Ad blockers can suppress browser events.

For the demo funnel use password signup so the `sign_up` hook covers it. Magic-link signup counting requires an authoritative auth-user-created event/webhook; do not count every successful email request or repeat login as a signup. For the 20-user target, verify distinct accounts in Supabase and record consented volunteer aliases in the recruitment tracker; analytics alone is not proof of twenty users.

References: https://vercel.com/docs/analytics/quickstart, https://vercel.com/docs/analytics/custom-events, https://vercel.com/docs/analytics/redacting-sensitive-data.
