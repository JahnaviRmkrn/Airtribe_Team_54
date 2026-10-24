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
  "leading_venue_id": "...",
  "me": { "attendee_id", "voted_venue_id" } | null,
  "is_organizer": false
}
```

To test several guests from one browser, send `X-Guest-Secret: <guest_secret>`
instead of relying on the cookie.

Errors are `{ "error": "message" }` with 400 (validation), 401 (not signed in /
not joined), 403, 404 (unknown or expired room), 409, 410 (room closed).

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

---

## Organizer app prototype (Person B, FastAPI + mock API)

This is the original prototype from `main`. It still runs against its own mock;
it is being moved onto the API above (see the organizer integration spec).

Person B deliverable: the Organizer app frontend, plus a FastAPI backend that
mocks Person A's API until the real one is ready.

### Run

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open http://127.0.0.1:8000 - API docs at http://127.0.0.1:8000/docs
Requires Python 3.10+.

### What it does

- **Login** - mock sign-in with any email.
- **Onboarding** - editable confirm screen (name/email) with a text-input
  fallback, and attention goals that must total 100%.
- **Dashboard** - contact counts labeled separately from recorded activity,
  open follow-ups, upcoming meetups, and "Add person" / "Plan a meetup"
  quick actions.
- **Contacts** - add / edit / delete with a category filter.
- **Follow-ups** - mark done with a note.
- **Meetups** - create a meetup and get a copyable room link.
- Nothing is ever sent automatically - every action is an explicit tap.
- State persists (server: `data/store.json`, client: localStorage), so
  everything works after a page refresh. Responsive on phone and desktop.

### Swapping in A's real API

The frontend only talks to `/api/*`. `routers/api.py` is the mock; replace it
with a proxy to A's real base URL when it is ready - no frontend changes
needed.

### Layout

- `main.py` - app entrypoint; serves the frontend and mounts `/api`
- `routers/api.py` - mock of Person A's API (auth, goals, contacts, follow-ups, meetups, activity)
- `static/` - frontend (`index.html`, `app.js`, `styles.css`)
