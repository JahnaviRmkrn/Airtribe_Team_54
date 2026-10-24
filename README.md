# Moup - Team 54 (AI Builders Day)

Person B deliverable: the Moup app frontend, plus a FastAPI backend that
mocks Person A's API until the real one is ready.

## Run

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open http://127.0.0.1:8000 - API docs at http://127.0.0.1:8000/docs
Requires Python 3.10+.

## What it does

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

## Swapping in A's real API

The frontend only talks to `/api/*`. `routers/api.py` is the mock; replace it
with a proxy to A's real base URL when it is ready - no frontend changes
needed.

## Layout

- `main.py` - app entrypoint; serves the frontend and mounts `/api`
- `routers/api.py` - mock of Person A's API (auth, goals, contacts, follow-ups, meetups, activity)
- `static/` - frontend (`index.html`, `app.js`, `styles.css`)
