# Airtribe Team 54: Personal Relationship Manager (backend)

Next.js 15 (App Router) + Supabase (Postgres, Auth, RLS). This branch holds the
data and access layer: schema, auth, the private API, the public room API and
the venue shortlist.

## Run locally

```bash
pnpm install
supabase start                 # needs Docker; applies migrations + seed.sql
cp .env.example .env.local     # fill keys from: supabase status
pnpm dev                       # http://localhost:3000
pnpm test                      # shortlist unit tests
node scripts/smoke.mjs         # end-to-end API check (needs dev server running)
```

Hosted Supabase: create a project, run `supabase link` then `supabase db push`,
run `supabase/seed.sql` in the SQL editor, and turn off "Confirm email" in
Auth settings for the demo. Put the project URL/keys in the deployment env.

## Auth

- `/login` has a minimal page (magic link, or email+password sign-in/sign-up).
- In the browser the session lives in cookies, so `fetch('/api/me/...')` just works.
- From scripts/curl: `Authorization: Bearer <supabase access_token>`.

## Private API (signed-in user, scoped by RLS)

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/api/me/dashboard` | | goals, contact_counts, recorded_activity (separate measures), contacts_by_category, followups, upcoming_meetups, recent_activity, is_empty |
| GET | `/api/me/contacts` | `?category=personal\|professional\|community` | |
| POST | `/api/me/contacts` | one contact, or `{ contacts: [...] }` (max 5, onboarding confirm) | |
| GET | `/api/me/contacts/:id` | | contact + interaction history |
| PATCH / DELETE | `/api/me/contacts/:id` | partial contact | |
| GET / PUT | `/api/me/goals` | `{ personal, professional, community }` | must total 100 |
| GET | `/api/me/followups` | `?days=14` | `{ overdue, upcoming }` |
| GET | `/api/me/interactions` | `?limit=20` | recent activity |
| POST | `/api/me/interactions` | `{ contact_id, type?, notes?, occurred_at?, next_followup_at? }` | completes a follow-up; updates last_interaction_at and next_followup_at |
| GET / POST | `/api/me/meetups` | `{ title, activity?, area?, starts_at?, budget? }` | POST returns `meetup.room_url` + `invite_text`. Nothing is sent automatically. |
| GET / PATCH / DELETE | `/api/me/meetups/:id` | partial + `status`, `final_venue_id` | edit / close |

Contact fields: `name, category, interests[], notes, preferred_frequency_days,
last_interaction_at, next_followup_at` (ISO timestamps with offset).

## Public room API (no account; scoped to the room token)

| Method | Path | Body | Who |
|---|---|---|---|
| GET | `/api/rooms/:token` | | anyone with the link; poll every 3-5 s for "live" updates |
| POST | `/api/rooms/:token/join` | `{ guest_name, preferences?, availability? }` | guest; sets httpOnly cookie, returns `guest_secret` once |
| GET / PATCH | `/api/rooms/:token/me` | partial join body | that guest only |
| POST / DELETE | `/api/rooms/:token/vote` | `{ venue_id }` | guest; one vote each, re-vote moves it; must be shortlisted |
| POST | `/api/rooms/:token/confirm` | `{ venue_id }` | organiser (signed in) |
| POST | `/api/rooms/:token/close` | | organiser (signed in) |
| POST | `/api/rooms/:token/pay` | | guest; needs a confirmed venue with a price (409/400). Starts a Pine Labs order for the venue's `price_per_person` (computed server-side). Idempotent: returns the existing pending/paid payment. Returns `{ payment: { status, amount_paise, redirect_url } }`; send the guest to `redirect_url`, they come back to `/m/:token?payment=done` |
| GET | `/api/rooms/:token/pay` | | guest; own payment (or `null`), status refreshed from Pine Labs while pending |

Room page route for the frontend: `/m/:token`.

`preferences`: `{ budget_min?, budget_max?, area?, food?: string[], activities?: string[] }`
`availability`: `string[]`, e.g. `["Sat evening", "Sun lunch"]`

Room view shape:

```json
{
  "meetup": { "title", "activity", "area", "starts_at", "budget", "status", "expires_at", "final_venue" },
  "attendees": [{ "id", "guest_name", "preferences", "availability", "joined_at" }],
  "shortlist": [{ "venue": { "id", "name", "area", "tags", "price_per_person", "details" }, "score", "reasons": [], "label": "Sample suggestion" }],
  "shortlist_note": "...",
  "votes": { "<venue_id>": 2 },
  "payments": { "<attendee_id>": "pending" | "paid" | "failed" | "cancelled" },
  "amount_due_paise": 45000 | null,
  "leading_venue_id": "...",
  "me": { "attendee_id", "voted_venue_id" } | null,
  "is_organizer": false
}
```

To test several guests from one browser, send `X-Guest-Secret: <guest_secret>`
instead of relying on the cookie.

Errors are `{ "error": "message" }` with 400 (validation), 401 (not signed in /
not joined), 403, 404 (unknown or expired room), 409, 410 (room closed), 502
(payment provider error), 503 (payments not configured).

## Payments (Pine Labs Online)

Uses the Pine Labs Agent Toolkit (`@plural_pinelabs/agent-toolkit`) tools
`createOrder` / `getOrder` called directly on the server (no LLM), in
`lib/pinelabs.ts`. Set `PINE_CLIENT_ID`, `PINE_CLIENT_SECRET` and `PINE_ENV`
(`uat` default, or `production`); without them the pay routes return 503.
`amount_due_paise` is the confirmed venue's `price_per_person` x 100 (`null`
when there is no confirmed venue or no price). Payment status is only ever
taken from `getOrder`, never from the return URL. The room view shows each
guest's status only (no order ids or checkout links); it refreshes when the
guest calls `GET /pay`.

## Privacy and access rules

- Contacts, interactions, goals and meetups have RLS: `user_id = auth.uid()`.
- Guest tables have no anon policies; the room API reads and writes them with the
  service role after checking the room token and guest secret.
- The room view never includes the organiser's identity, contacts or notes.
- Room tokens are 32 random bytes; rooms 404 after `expires_at` (14 days, or two
  days after the meetup). Closed rooms are read-only.
- Guest secrets are stored only as SHA-256 hashes.
- Venues are seeded **sample** data and always labelled "Sample suggestion".
  The shortlist returns `[]` instead of inventing results when nothing matches.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only (`lib/supabase/admin.ts` imports `server-only`).
- `meetup_payments` has no anon policies; organisers can read their own meetups'
  payments. `PINE_CLIENT_SECRET` is server-only (`lib/pinelabs.ts` imports `server-only`).

---

## Organizer app (Person B)

The Organizer frontend lives in `public/organizer/` (`index.html`, `app.js`,
`styles.css`) and is served by Next.js at `/organizer/`. It talks only to the
real API above - same-origin `fetch('/api/me/...')` with
`credentials: 'include'`; the Supabase cookie session does the auth. The old
FastAPI prototype and its mock (`main.py`, `routers/`) are gone.

### Run

Run the Next.js app as above (`pnpm dev`), sign in at `/login`, then open
http://localhost:3000/organizer/ . Any 401 from `/api/me/*` redirects to
`/login?next=/organizer/`.

### What it does

- **Login** - Person A's `/login` (magic link or email + password). No token
  handling in the frontend.
- **Onboarding** - two-step editable confirm screen: up to 5 people (name,
  category, interests, check-in frequency) plus "Add another", then goals for
  Personal / Professional / Community with a live total that must equal 100.
  Nothing is saved before Confirm, which calls `POST /api/me/contacts` with
  `{ contacts: [...] }` and `PUT /api/me/goals`. Skip is allowed at any point.
  Person C's voice extraction can pre-fill the screen by setting
  `window.ORGANIZER_PREFILL` or sessionStorage `org_prefill` to
  `{ contacts: [...], goals: {...} }` before the page loads.
- **Dashboard** - one `GET /api/me/dashboard`. Contact counts and recorded
  activity are shown as separately labelled numbers (the activity caption is
  `recorded_activity.label`); a goals-vs-activity comparison appears only when
  `recorded_activity.sufficient_data` is true. `is_empty` shows an empty state
  with "Add person" and "Plan a meetup".
- **Contacts** - list/filter (`?category=`), add (interests as comma-separated,
  check-in frequency, next follow-up date), profile + interaction history,
  edit via PATCH with only changed fields, delete.
- **Follow-ups** - a follow-up is a contact's `next_followup_at`. Mark done
  posts `/api/me/interactions` with a note; leaving the next date blank lets
  the server roll it forward by the contact's check-in frequency.
- **Meetups** - create (title, activity, area, optional date/time and budget
  in INR - no contact picker; guests join via the link), then Copy link / Copy
  invite text. The room page `/m/<token>` is Person C's; the app only links to
  it. Meetups can be closed via PATCH `{ status: "closed" }`.
- Errors render the API's `{ "error": "message" }`; every list has loading,
  empty and error states; everything survives a refresh and works at phone and
  desktop widths.
