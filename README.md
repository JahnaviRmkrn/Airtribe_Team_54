# Moup (Airtribe Team 54): Personal Relationship Manager

Next.js 15 (App Router) + Supabase (Postgres, Auth, RLS) unified platform, alongside the FastAPI prototype backend and static runner.

## Run locally

### 1. Unified App (Next.js 15)
```bash
pnpm install
supabase start                 # needs Docker; applies migrations + seed.sql
cp .env.example .env.local     # fill keys from: supabase status
pnpm dev                       # http://localhost:3000
pnpm test                      # shortlist unit tests
node scripts/smoke.mjs         # end-to-end API check (needs dev server running)
```

Deploying (Vercel + hosted Supabase): see [DEPLOY.md](DEPLOY.md).
`pnpm check-env` validates the env (`--prod` for production values).

### 2. FastAPI Prototype Runner
```bash
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```
Open http://127.0.0.1:8000 - API docs at http://127.0.0.1:8000/docs


## Auth

- `/login` has a minimal page (magic link, or email+password sign-in/sign-up).
- Social sign-in: `/login` also has **Google, Facebook, LinkedIn and
  Instagram** buttons via Supabase Auth OAuth. Each one needs a developer app
  on the provider's side and its client ID/secret entered in the Supabase
  project - per-provider steps and callback URLs are in
  [docs/social-auth-setup.md](docs/social-auth-setup.md). Instagram is wired as
  a custom OAuth2 provider (`custom:instagram`) because Supabase has no
  built-in Instagram provider.
- In the browser the session lives in cookies, so `fetch('/api/me/...')` just works.
- From scripts/curl: `Authorization: Bearer <supabase access_token>`.

## Google Contacts import

Contacts → **Import Google Contacts** offers a separate, read-only Google consent
flow, an unchecked preview, category selection, duplicate detection, and explicit
saves in batches of up to five. It never imports automatically or changes Google
Contacts. Onboarding retains its separate five-person limit.

The connector stays disabled until an authorized operator configures its own
OAuth client, server-side encryption key, and reviewed database migration. See
[Google Contacts setup and security notes](docs/google-contacts-setup.md) for exact
scopes, redirects, retention/cleanup, revocation limitations and mock-test coverage.
Adding the code does not connect a real Google account.

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
| POST | `/api/extract` | `{ transcript }` (max 20,000 chars) | onboarding pre-fill; see below. Stateless, never writes to the DB |
| GET | `/api/voice/signed-url` | | `{ signed_url }` for the ElevenLabs onboarding agent; 503 if not configured |

### Voice onboarding and extraction

Ported from Arindom Chetia's PR #3 (FastAPI `routers/voice.py`, `static/voice.*`).

- `POST /api/extract` returns
  `{ contacts: [<=5 { name, category, interests[], preferred_frequency_days? }], goals: { personal, professional, community }, source: "deepseek"|"gemini"|"openai"|"rules", saved: false }`.
  Goals are integers that always total 100. It calls DeepSeek if `DEEPSEEK_API_KEY`
  is set, else Gemini if `GEMINI_API_KEY` is set, else OpenAI if
  `OPENAI_API_KEY` is set (or any OpenAI-compatible API via `OPENAI_BASE_URL`
  + `EXTRACT_MODEL`), and otherwise (or if every configured call fails or
  returns invalid JSON) uses a rule-based parser
  (`lib/extract.ts`). Every result is validated with zod and clamped before it
  is returned. It requires sign-in so it can't be used as a free LLM proxy.
- `GET /api/voice/signed-url` mints a short-lived ElevenLabs conversation URL
  from `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`. Both are server-only;
  the browser only gets the signed URL. Create the agent once with
  `python3 scripts/setup_elevenlabs_agent.py`.
- In the organizer onboarding (`/organizer/#/onboarding`), "Talk instead"
  starts the voice agent (ElevenLabs browser SDK, loaded only on tap from a
  pinned jsDelivr URL with SRI). "Type instead" posts typed text to
  `/api/extract`, and it still works when voice isn't configured. Either one
  pre-fills the editable confirm screen. Nothing is saved until Confirm.

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

### Guest room page (`/m/:token`)

A static page in `public/room/` (`index.html`, `room.js`, `room.css`). A Next.js
rewrite in `next.config.ts` serves it at `/m/:token`. The UI is ported from
Arindom Chetia's PR #3 (`static/room.*`) and runs on the room API above.

- Guests join with a name. The guest cookie is httpOnly, so the page never
  stores the guest secret. Each guest then sets their name, budget min/max,
  area, food, activities and availability (`PATCH /me`).
- The page polls `GET /api/rooms/:token` every 4 s and pauses while the tab is
  hidden. It shows the participant list, a best-time tally built from
  availability, and the shortlist with its "Sample suggestion" labels and
  `shortlist_note`.
- Each guest has one vote. Voting for another venue moves the vote, and
  tapping your current vote withdraws it (`DELETE /vote`).
- When `is_organizer` is true, the signed-in organiser can confirm a venue or
  close the room. Rooms can't be reopened.
- The page shows the confirmed venue and the closed state. API errors
  (401/404/409/410/429) show the API's `{ error }` message. All
  guest-provided text is escaped.

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
not joined), 403, 404 (unknown or expired room), 409, 410 (room closed),
429 (rate limited, or room full), 502 (payment provider error), 503 (payments
not configured).

### Rate limits

Every room route is limited per client IP (first `x-forwarded-for` entry) and
room token, in fixed windows counted in Postgres (`rate_limits` table,
`hit_rate_limit()` RPC, service role only), so limits hold across Vercel
instances. Over the limit returns 429 `Too many requests, slow down`.

| Route | Limit |
|---|---|
| GET `/api/rooms/:token`, GET `/me` | 120/min each (enough for a 3 s poll) |
| POST `/join` | 10/min per room, and 60/hour across all rooms |
| POST / DELETE `/vote`, PATCH `/me` | 30/min (shared) |
| POST `/confirm`, `/close` | 30/min (shared) |
| GET / POST `/pay` | 10/min |
| POST `/api/extract` | 10/min per signed-in user |
| GET `/api/voice/signed-url` | 5 per 10 min per signed-in user |

Presets live in `lib/ratelimit.ts`; a new room route adds one line, e.g.
`await limitRoom(req, 'pay', token)`. If the limiter RPC fails the request is
allowed (fail open) and the error is logged.

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
  "Talk instead" (voice) and "Type instead" (text) call `/api/extract` and
  pre-fill this screen (see Voice onboarding above). Other code can still
  pre-fill it by setting `window.ORGANIZER_PREFILL` or sessionStorage
  `org_prefill` to `{ contacts: [...], goals: {...} }` before the page loads.
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
  invite text. The room page `/m/<token>` is Person C's (see Guest room page);
  the app only links to it. Meetups can be closed via PATCH `{ status: "closed" }`.
- Errors render the API's `{ "error": "message" }`; every list has loading,
  empty and error states; everything survives a refresh and works at phone and
  desktop widths.

