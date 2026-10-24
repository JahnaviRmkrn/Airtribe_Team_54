"""Mock of Person A's API for the Organizer app.

The frontend only talks to /api/*, so swap this router for a proxy to A's
real base URL when it is ready - no frontend changes needed.
State persists to data/store.json so everything survives refresh/restart.
"""

import json
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()

STORE = Path("data/store.json")

DEFAULT_GOALS = {"Family": 25, "Friends": 25, "Work": 25, "Mentors": 25}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load() -> dict:
    if STORE.exists():
        return json.loads(STORE.read_text())
    return {
        "contacts": [],
        "followups": [],
        "meetups": [],
        "activity": [],
        "goals": DEFAULT_GOALS,
    }


def save(state: dict) -> None:
    STORE.parent.mkdir(exist_ok=True)
    STORE.write_text(json.dumps(state, indent=2))


def log(state: dict, kind: str, detail: str) -> None:
    state["activity"].append(
        {"id": secrets.token_hex(4), "kind": kind, "detail": detail, "at": now()}
    )


# --- auth (mock: any email signs in, nothing is ever sent) ---------

class LoginIn(BaseModel):
    email: str


@router.post("/login")
def login(body: LoginIn) -> dict:
    return {"token": secrets.token_hex(16), "email": body.email}


# --- attention goals (must total 100%) ------------------------------

class GoalsIn(BaseModel):
    goals: dict[str, int]


@router.get("/goals")
def get_goals() -> dict:
    return load()["goals"]


@router.put("/goals")
def put_goals(body: GoalsIn) -> dict:
    if sum(body.goals.values()) != 100:
        raise HTTPException(400, "Attention goals must total 100%.")
    state = load()
    state["goals"] = body.goals
    log(state, "goals", "Updated attention goals")
    save(state)
    return state["goals"]


# --- contacts --------------------------------------------------------

class ContactIn(BaseModel):
    name: str
    category: str = "Friends"
    notes: str = ""


@router.get("/contacts")
def list_contacts(category: str | None = None) -> list:
    contacts = load()["contacts"]
    if category:
        contacts = [c for c in contacts if c["category"] == category]
    return contacts


@router.post("/contacts")
def add_contact(body: ContactIn) -> dict:
    state = load()
    contact = {"id": secrets.token_hex(4), "created_at": now(), **body.model_dump()}
    state["contacts"].append(contact)
    log(state, "contact", f"Added {contact['name']}")
    save(state)
    return contact


@router.put("/contacts/{cid}")
def edit_contact(cid: str, body: ContactIn) -> dict:
    state = load()
    for c in state["contacts"]:
        if c["id"] == cid:
            c.update(body.model_dump())
            log(state, "contact", f"Edited {c['name']}")
            save(state)
            return c
    raise HTTPException(404, "Contact not found")


@router.delete("/contacts/{cid}")
def delete_contact(cid: str) -> dict:
    state = load()
    before = len(state["contacts"])
    state["contacts"] = [c for c in state["contacts"] if c["id"] != cid]
    state["followups"] = [f for f in state["followups"] if f["contact_id"] != cid]
    if len(state["contacts"]) == before:
        raise HTTPException(404, "Contact not found")
    log(state, "contact", "Deleted a contact")
    save(state)
    return {"deleted": cid}


# --- follow-ups ------------------------------------------------------

class FollowupIn(BaseModel):
    contact_id: str
    due: str
    note: str = ""


class DoneIn(BaseModel):
    note: str = ""


@router.get("/followups")
def list_followups() -> list:
    return load()["followups"]


@router.post("/followups")
def add_followup(body: FollowupIn) -> dict:
    state = load()
    fu = {"id": secrets.token_hex(4), "done": False, "done_note": "", **body.model_dump()}
    state["followups"].append(fu)
    save(state)
    return fu


@router.post("/followups/{fid}/done")
def done_followup(fid: str, body: DoneIn) -> dict:
    state = load()
    for f in state["followups"]:
        if f["id"] == fid:
            f["done"] = True
            f["done_note"] = body.note
            f["done_at"] = now()
            log(state, "followup", "Follow-up marked done")
            save(state)
            return f
    raise HTTPException(404, "Follow-up not found")


# --- meetups ----------------------------------------------------------

class MeetupIn(BaseModel):
    title: str
    when: str
    contact_ids: list[str] = []


@router.get("/meetups")
def list_meetups() -> list:
    return load()["meetups"]


@router.post("/meetups")
def add_meetup(body: MeetupIn, request: Request) -> dict:
    from routers.rooms import _refresh_shortlist, create_room  # lazy: rooms imports this module

    state = load()
    mid = secrets.token_hex(4)
    room = create_room(state, body.title, body.when, meetup_id=mid)
    _refresh_shortlist(room)
    base = str(request.base_url).rstrip("/")
    m = {
        "id": mid,
        "room_link": f"{base}/m/{room['token']}",
        "organizer_link": f"{base}/m/{room['token']}?key={room['organizer_key']}",
        "created_at": now(),
        **body.model_dump(),
    }
    state["meetups"].append(m)
    log(state, "meetup", f"Planned meetup: {m['title']}")
    save(state)
    return m


# --- activity + summary ------------------------------------------------

@router.get("/activity")
def list_activity() -> list:
    return load()["activity"]


@router.get("/summary")
def summary() -> dict:
    state = load()
    return {
        "contact_count": len(state["contacts"]),
        "activity_count": len(state["activity"]),
        "open_followups": [f for f in state["followups"] if not f["done"]],
        "upcoming_meetups": state["meetups"],
    }
