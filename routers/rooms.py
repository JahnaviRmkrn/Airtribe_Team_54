"""Guest meetup room at /m/<token>.

Guests join with a name (no account), set preferences (budget, area,
food/activity, availability), see who else is in, and vote on a shortlist.
The organizer (holder of the organizer key) can confirm a venue or close
the room. Rooms live in data/store.json under "rooms", keyed by token.

Auth is deliberately lightweight for the demo:
- each guest gets a per-room secret on join (kept in their localStorage)
- the organizer link carries ?key=<organizer_key>
"""

import secrets
import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from routers.api import load, log, now, save

router = APIRouter()
_lock = threading.Lock()  # serialise read-modify-write on the JSON store

BUDGETS = [1, 2, 3, 4]  # ₹ .. ₹₹₹₹
AREAS = ["Indiranagar", "Koramangala", "HSR Layout", "MG Road", "Jayanagar", "Whitefield"]
KINDS = ["Coffee", "Brunch", "Dinner", "Drinks", "Board games", "Bowling", "Outdoors", "Movies"]
SLOTS = ["Fri evening", "Sat morning", "Sat afternoon", "Sat evening",
         "Sun morning", "Sun afternoon", "Sun evening"]
SHORTLIST_SIZE = 5

# Demo venue catalog. Swap for a Places API later; the shape is all that matters.
CATALOG = [
    {"name": "Third Wave Corner", "area": "Indiranagar", "price": 2, "kinds": ["Coffee", "Brunch"], "blurb": "Quiet tables, great pour-overs"},
    {"name": "The Dice Den", "area": "Indiranagar", "price": 2, "kinds": ["Board games", "Coffee"], "blurb": "300+ games, staff teach you"},
    {"name": "Toit-style Taproom", "area": "Indiranagar", "price": 3, "kinds": ["Drinks", "Dinner"], "blurb": "Loud, lively, big tables"},
    {"name": "Koramangala Social Club", "area": "Koramangala", "price": 3, "kinds": ["Drinks", "Dinner"], "blurb": "Rooftop seating, group platters"},
    {"name": "Brew & Brunch", "area": "Koramangala", "price": 2, "kinds": ["Brunch", "Coffee"], "blurb": "All-day eggs and waffles"},
    {"name": "Strike Lanes", "area": "Koramangala", "price": 3, "kinds": ["Bowling", "Drinks"], "blurb": "8 lanes plus an arcade"},
    {"name": "Agara Lake Loop", "area": "HSR Layout", "price": 1, "kinds": ["Outdoors"], "blurb": "Easy 3 km walk, chai stalls nearby"},
    {"name": "HSR Filter Coffee Co.", "area": "HSR Layout", "price": 1, "kinds": ["Coffee"], "blurb": "Classic tumbler coffee, quick bites"},
    {"name": "Meeple Mansion", "area": "HSR Layout", "price": 2, "kinds": ["Board games", "Dinner"], "blurb": "Private rooms for groups"},
    {"name": "Cubbon Park Picnic", "area": "MG Road", "price": 1, "kinds": ["Outdoors", "Brunch"], "blurb": "Bring a mat, grab food en route"},
    {"name": "The Grand Bistro", "area": "MG Road", "price": 4, "kinds": ["Dinner", "Drinks"], "blurb": "Fine dining, book ahead"},
    {"name": "Silver Screen IMAX", "area": "MG Road", "price": 2, "kinds": ["Movies"], "blurb": "Recliners and late shows"},
    {"name": "Jayanagar Darshini Trail", "area": "Jayanagar", "price": 1, "kinds": ["Brunch", "Coffee"], "blurb": "Dosa crawl across 4th Block"},
    {"name": "Old Town Rooftop", "area": "Jayanagar", "price": 3, "kinds": ["Dinner", "Drinks"], "blurb": "Sunset views, live music Sat"},
    {"name": "Whitefield Arena", "area": "Whitefield", "price": 3, "kinds": ["Bowling", "Movies"], "blurb": "Bowling + cinema under one roof"},
    {"name": "Phoenix Food Hall", "area": "Whitefield", "price": 2, "kinds": ["Dinner", "Coffee"], "blurb": "Everyone picks their own cuisine"},
    {"name": "Lakeside Brewery", "area": "Whitefield", "price": 3, "kinds": ["Drinks", "Dinner"], "blurb": "Outdoor deck by the water"},
]


# --- helpers -------------------------------------------------------------------

def create_room(state: dict, title: str, when: str = "", meetup_id: str | None = None) -> dict:
    """Create a room inside an already-loaded state (caller saves)."""
    rooms = state.setdefault("rooms", {})
    token = secrets.token_urlsafe(6)
    while token in rooms:
        token = secrets.token_urlsafe(6)
    room = {
        "token": token,
        "organizer_key": secrets.token_urlsafe(12),
        "meetup_id": meetup_id,
        "title": title,
        "when": when,
        "status": "open",  # open | confirmed | closed
        "created_at": now(),
        "participants": [],
        "venues": [],
        "votes": {},  # venue_id -> [participant_id]
        "confirmed_venue_id": None,
    }
    rooms[token] = room
    return room


def _get(state: dict, token: str) -> dict:
    room = state.get("rooms", {}).get(token)
    if not room:
        raise HTTPException(404, "This room link is not valid.")
    return room


def _guest(room: dict, pid: str, secret: str) -> dict:
    for p in room["participants"]:
        if p["id"] == pid and secrets.compare_digest(p["secret"], secret):
            return p
    raise HTTPException(403, "Join the room first.")


def _organizer(room: dict, key: str) -> None:
    if not key or not secrets.compare_digest(room["organizer_key"], key):
        raise HTTPException(403, "Only the organizer can do that.")


def _open(room: dict) -> None:
    if room["status"] != "open":
        raise HTTPException(409, f"This room is {room['status']}.")


def _fit(venue: dict, prefs: dict) -> tuple[int, bool]:
    """Score one venue against one guest's prefs; also return a hard 'fits' flag."""
    if not prefs:
        return 0, True
    score, fits = 0, True
    budget = prefs.get("budget")
    if budget:
        if venue["price"] <= budget:
            score += 1
        else:
            score -= 2
            fits = False
    area = prefs.get("area") or "Anywhere"
    if area == "Anywhere":
        score += 1
    elif area == venue["area"]:
        score += 3
    else:
        fits = False
    kinds = prefs.get("kinds") or []
    if set(kinds) & set(venue["kinds"]):
        score += 2
    elif kinds:
        fits = False
    return score, fits


def _refresh_shortlist(room: dict) -> None:
    """Keep guest picks and anything with votes; top up with best catalog fits."""
    keep = [v for v in room["venues"] if v["source"] == "guest" or room["votes"].get(v["id"])]
    taken = {v["name"] for v in keep}
    prefs = [p["prefs"] for p in room["participants"] if p.get("prefs")]
    ranked = sorted(
        (c for c in CATALOG if c["name"] not in taken),
        key=lambda c: sum(_fit(c, p)[0] for p in prefs),
        reverse=True,
    )
    old = {v["name"]: v["id"] for v in room["venues"]}
    for c in ranked[: max(0, SHORTLIST_SIZE - len(keep))]:
        keep.append({**c, "id": old.get(c["name"], secrets.token_hex(4)), "source": "catalog", "added_by": None})
    live = {v["id"] for v in keep}
    room["venues"] = keep
    room["votes"] = {vid: voters for vid, voters in room["votes"].items() if vid in live}


def _public(room: dict, pid: str | None, key: str | None) -> dict:
    """Room as a guest sees it: no secrets, plus derived tallies."""
    is_org = bool(key) and secrets.compare_digest(room["organizer_key"], key)
    names = {p["id"]: p["name"] for p in room["participants"]}
    prefs = [p["prefs"] for p in room["participants"] if p.get("prefs")]

    venues = []
    for v in room["venues"]:
        voters = room["votes"].get(v["id"], [])
        fits = sum(1 for p in prefs if _fit(v, p)[1])
        venues.append({
            **{k: v[k] for k in ("id", "name", "area", "price", "kinds", "blurb", "source")},
            "added_by": names.get(v.get("added_by")),
            "votes": len(voters),
            "voters": [names[x] for x in voters if x in names],
            "mine": bool(pid and pid in voters),
            "fits": fits,
            "fit_of": len(prefs),
        })
    venues.sort(key=lambda v: (-v["votes"], -v["fits"], v["name"]))

    slot_counts = {s: 0 for s in SLOTS}
    for p in prefs:
        for s in p.get("availability", []):
            if s in slot_counts:
                slot_counts[s] += 1
    top = max(slot_counts.values(), default=0)

    return {
        "token": room["token"],
        "title": room["title"],
        "when": room["when"],
        "status": room["status"],
        "is_organizer": is_org,
        "organizer_key": room["organizer_key"] if is_org else None,
        "me": next(({"id": p["id"], "name": p["name"], "prefs": p.get("prefs")}
                    for p in room["participants"] if p["id"] == pid), None),
        "participants": [
            {"id": p["id"], "name": p["name"], "joined_at": p["joined_at"], "prefs": p.get("prefs")}
            for p in room["participants"]
        ],
        "venues": venues,
        "slots": [{"slot": s, "count": c, "best": bool(top) and c == top} for s, c in slot_counts.items()],
        "confirmed_venue": next((v for v in venues if v["id"] == room["confirmed_venue_id"]), None),
        "options": {"budgets": BUDGETS, "areas": AREAS, "kinds": KINDS, "slots": SLOTS},
    }


def _mutate(token: str, fn):
    """Locked load -> fn(state, room) -> save. Returns fn's result."""
    with _lock:
        state = load()
        room = _get(state, token)
        result = fn(state, room)
        save(state)
        return result


# --- endpoints ---------------------------------------------------------------------

class RoomIn(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    when: str = ""


class JoinIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class GuestIn(BaseModel):
    pid: str
    secret: str


class PrefsIn(GuestIn):
    budget: int | None = Field(default=None, ge=1, le=4)
    area: str = "Anywhere"
    kinds: list[str] = []
    availability: list[str] = []


class VenueIn(GuestIn):
    name: str = Field(min_length=1, max_length=60)
    area: str = "Anywhere"
    price: int = Field(default=2, ge=1, le=4)
    kind: str = "Dinner"


class VoteIn(GuestIn):
    venue_id: str


class OrgIn(BaseModel):
    key: str


class ConfirmIn(OrgIn):
    venue_id: str


@router.post("/rooms")
def new_room(body: RoomIn) -> dict:
    with _lock:
        state = load()
        room = create_room(state, body.title, body.when)
        _refresh_shortlist(room)
        save(state)
    return {"token": room["token"], "organizer_key": room["organizer_key"]}


@router.get("/rooms/{token}")
def get_room(token: str, pid: str | None = None, key: str | None = None) -> dict:
    return _public(_get(load(), token), pid, key)


@router.post("/rooms/{token}/join")
def join(token: str, body: JoinIn) -> dict:
    def fn(state, room):
        _open(room)
        name = body.name.strip()
        if any(p["name"].lower() == name.lower() for p in room["participants"]):
            raise HTTPException(409, f"Someone called {name} is already here - try adding an initial.")
        p = {"id": secrets.token_hex(4), "secret": secrets.token_urlsafe(12), "name": name,
             "joined_at": now(), "prefs": None}
        room["participants"].append(p)
        if not room["venues"]:
            _refresh_shortlist(room)
        log(state, "room", f"{name} joined {room['title']}")
        return {"pid": p["id"], "secret": p["secret"]}
    return _mutate(token, fn)


@router.put("/rooms/{token}/prefs")
def set_prefs(token: str, body: PrefsIn) -> dict:
    def fn(state, room):
        _open(room)
        p = _guest(room, body.pid, body.secret)
        p["prefs"] = {
            "budget": body.budget,
            "area": body.area if body.area in AREAS else "Anywhere",
            "kinds": [k for k in body.kinds if k in KINDS],
            "availability": [s for s in body.availability if s in SLOTS],
        }
        _refresh_shortlist(room)
        return _public(room, body.pid, None)
    return _mutate(token, fn)


@router.post("/rooms/{token}/venues")
def suggest_venue(token: str, body: VenueIn) -> dict:
    def fn(state, room):
        _open(room)
        p = _guest(room, body.pid, body.secret)
        if any(v["name"].lower() == body.name.strip().lower() for v in room["venues"]):
            raise HTTPException(409, "That place is already on the shortlist.")
        vid = secrets.token_hex(4)
        room["venues"].append({
            "id": vid, "name": body.name.strip(),
            "area": body.area if body.area in AREAS else "Anywhere",
            "price": body.price, "kinds": [body.kind] if body.kind in KINDS else [],
            "blurb": f"Suggested by {p['name']}", "source": "guest", "added_by": p["id"],
        })
        room["votes"][vid] = [p["id"]]  # suggesting counts as your vote
        return _public(room, body.pid, None)
    return _mutate(token, fn)


@router.post("/rooms/{token}/votes")
def toggle_vote(token: str, body: VoteIn) -> dict:
    def fn(state, room):
        _open(room)
        p = _guest(room, body.pid, body.secret)
        if body.venue_id not in {v["id"] for v in room["venues"]}:
            raise HTTPException(404, "That venue is no longer on the shortlist.")
        voters = room["votes"].setdefault(body.venue_id, [])
        if p["id"] in voters:
            voters.remove(p["id"])
        else:
            voters.append(p["id"])
        return _public(room, body.pid, None)
    return _mutate(token, fn)


@router.post("/rooms/{token}/confirm")
def confirm_venue(token: str, body: ConfirmIn) -> dict:
    def fn(state, room):
        _organizer(room, body.key)
        venue = next((v for v in room["venues"] if v["id"] == body.venue_id), None)
        if not venue:
            raise HTTPException(404, "Venue not found.")
        room["status"] = "confirmed"
        room["confirmed_venue_id"] = venue["id"]
        for m in state.get("meetups", []):
            if m["id"] == room.get("meetup_id"):
                m["venue"] = f"{venue['name']}, {venue['area']}"
        log(state, "room", f"Confirmed {venue['name']} for {room['title']}")
        return _public(room, None, body.key)
    return _mutate(token, fn)


@router.post("/rooms/{token}/close")
def close_room(token: str, body: OrgIn) -> dict:
    def fn(state, room):
        _organizer(room, body.key)
        room["status"] = "closed"
        log(state, "room", f"Closed room for {room['title']}")
        return _public(room, None, body.key)
    return _mutate(token, fn)


@router.post("/rooms/{token}/reopen")
def reopen_room(token: str, body: OrgIn) -> dict:
    def fn(state, room):
        _organizer(room, body.key)
        room["status"] = "open"
        room["confirmed_venue_id"] = None
        return _public(room, None, body.key)
    return _mutate(token, fn)
