"""Voice onboarding: ElevenLabs agent session + transcript extraction.

- GET  /api/voice/config      -> is the ElevenLabs agent configured?
- GET  /api/voice/signed-url  -> short-lived signed URL (API key stays server-side)
- POST /api/extract           -> transcript -> {contacts[<=5], goals}

/api/extract is stateless: it NEVER writes to the store. The confirm screen
shows the result for editing, and only the user's explicit confirm saves it.

Extraction uses an LLM when GEMINI_API_KEY or OPENAI_API_KEY is set, and
falls back to a rule-based parser otherwise so the demo never dead-ends.
"""

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

CATEGORIES = ["Family", "Friends", "Work", "Mentors"]
MAX_CONTACTS = 5
ELEVEN_BASE = "https://api.elevenlabs.io/v1"


# --- ElevenLabs session ---------------------------------------------------

@router.get("/voice/config")
def voice_config() -> dict:
    agent_id = os.getenv("ELEVENLABS_AGENT_ID", "")
    has_key = bool(os.getenv("ELEVENLABS_API_KEY"))
    return {
        "enabled": bool(agent_id),
        # Private agents need a signed URL; public agents can use the id directly.
        "mode": "signed" if (agent_id and has_key) else ("public" if agent_id else "off"),
        "agent_id": agent_id if (agent_id and not has_key) else None,
    }


@router.get("/voice/signed-url")
def voice_signed_url() -> dict:
    agent_id = os.getenv("ELEVENLABS_AGENT_ID")
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not (agent_id and api_key):
        raise HTTPException(503, "ElevenLabs is not configured (set ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY).")
    url = f"{ELEVEN_BASE}/convai/conversation/get-signed-url?agent_id={urllib.parse.quote(agent_id)}"
    req = urllib.request.Request(url, headers={"xi-api-key": api_key})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"ElevenLabs refused the request ({e.code}).") from e
    except urllib.error.URLError as e:
        raise HTTPException(502, "Could not reach ElevenLabs.") from e
    return {"signed_url": data["signed_url"]}


# --- extraction -------------------------------------------------------------

class ExtractIn(BaseModel):
    transcript: str


EXTRACT_PROMPT = """You extract structured onboarding form data from a conversation transcript
between a user and a voice assistant for Moup, a relationship management app.

Return ONLY JSON of this exact shape:
{"name": str | null,
 "contacts": [{"name": str, "category": "Family"|"Friends"|"Work"|"Mentors", "notes": str}],
 "goals": {"Family": int, "Friends": int, "Work": int, "Mentors": int},
 "action": "confirm" | null}

Rules:
- name: the user's name if they said "my name is ...", "I'm ...", "call me ...", otherwise null.
- contacts: at most 5 real people the USER mentioned (not the assistant). Use first
  names as said. notes = one short phrase of context (relationship, role, or notes).
- goals: how the user wants to split attention across Family, Friends, Work, Mentors, integers
  summing to 100. If they gave numbers, use them. Otherwise infer from emphasis.
- action: set to "confirm" ONLY if the user explicitly commanded to save, confirm, submit, or finish.
- Never invent people. If none were mentioned, return an empty list.

Transcript:
"""


@router.post("/extract")
def extract(body: ExtractIn) -> dict:
    text = body.transcript.strip()
    if not text:
        raise HTTPException(400, "Transcript is empty.")
    raw, source = None, "rules"
    try:
        if os.getenv("GEMINI_API_KEY"):
            raw, source = _gemini(text), "gemini"
        elif os.getenv("OPENAI_API_KEY"):
            raw, source = _openai(text), "openai"
    except Exception:  # LLM down / bad key -> rules, the demo must not break
        raw = None
    if raw is None:
        raw, source = _rules(text), "rules"
    return {**_clean(raw, text), "source": source, "saved": False}


def _post_json(url: str, payload: dict, headers: dict) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", **headers}
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def _gemini(text: str) -> dict:
    model = os.getenv("EXTRACT_MODEL", "gemini-2.0-flash")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        f"?key={os.environ['GEMINI_API_KEY']}"
    )
    data = _post_json(url, {
        "contents": [{"parts": [{"text": EXTRACT_PROMPT + text}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }, {})
    return json.loads(data["candidates"][0]["content"]["parts"][0]["text"])


def _openai(text: str) -> dict:
    data = _post_json("https://api.openai.com/v1/chat/completions", {
        "model": os.getenv("EXTRACT_MODEL", "gpt-4o-mini"),
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": EXTRACT_PROMPT + text}],
    }, {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"})
    return json.loads(data["choices"][0]["message"]["content"])


# --- rule-based fallback ----------------------------------------------------

RELATIONS = {
    "Family": ["mom", "mother", "dad", "father", "sister", "brother", "wife", "husband", "partner",
               "son", "daughter", "aunt", "uncle", "cousin", "grandma", "grandmother", "grandpa",
               "grandfather", "niece", "nephew", "parents"],
    "Friends": ["friend", "best friend", "buddy", "roommate", "flatmate", "neighbour", "neighbor", "classmate"],
    "Work": ["colleague", "coworker", "co-worker", "manager", "boss", "teammate", "cofounder",
             "co-founder", "client", "report", "lead", "founder"],
    "Mentors": ["mentor", "coach", "advisor", "adviser", "teacher", "professor", "guide"],
}
CAT_WORDS = {
    "Family": ["family"], "Friends": ["friends", "friend", "social"],
    "Work": ["work", "career", "job", "professional", "colleagues"],
    "Mentors": ["mentors", "mentor", "mentorship", "learning"],
}
STOP = {"I", "The", "My", "And", "But", "So", "We", "He", "She", "They", "It", "Yes", "No",
        "Okay", "OK", "Hi", "Hey", "Hello", "Thanks", "Sure", "Also", "Well", "Maybe", "Then",
        "Agent", "User", "AI", "Assistant", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
        "Saturday", "Sunday", "Family", "Friends", "Work", "Mentors", "That", "This", "What"}
NAME = r"([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)"


def _user_lines(text: str) -> str:
    """Drop the agent's lines when the transcript is labelled."""
    lines = text.splitlines()
    labelled = [l for l in lines if re.match(r"^\s*(user|you|me|agent|ai|assistant)\s*:", l, re.I)]
    if not labelled:
        return text
    return "\n".join(re.sub(r"^\s*\w+\s*:\s*", "", l) for l in lines if re.match(r"^\s*(user|you|me)\s*:", l, re.I))


ALL_STOP = {
    w.lower() for w in STOP
} | {
    "my", "a", "an", "the", "please", "to", "also", "and", "under", "in", "for", "with", "add", "sister", "brother",
    "friend", "colleague", "mentor", "coworker", "manager", "boss", "mom", "dad", "father", "mother"
}


def _name(raw: str) -> str | None:
    """Drop leading filler ("And Arjun", "sister Priya" -> "Priya"); None if nothing real is left."""
    words = raw.split()
    while words and words[0].lower() in ALL_STOP:
        words.pop(0)
    # Strip any trailing filler
    while words and words[-1].lower() in ALL_STOP:
        words.pop()
    if not words:
        return None
    cleaned = " ".join(words)
    return cleaned.title() if len(cleaned) >= 2 else None



def _rules(text: str) -> dict:
    said = _user_lines(text)
    found: dict[str, dict] = {}  # lower name -> contact (+ _pos for ordering)
    rel_to_cat = {r: c for c, rs in RELATIONS.items() for r in rs}
    rel_alt = "|".join(sorted(map(re.escape, rel_to_cat), key=len, reverse=True))

    # Detect user's own name
    user_name = None
    m_name = re.search(r"\b(?:my name is|i'm|i am|call me|name's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", said, re.I)
    if m_name:
        candidate = m_name.group(1).strip()
        if candidate not in STOP:
            user_name = candidate

    def add(name_raw: str, cat: str, notes: str, pos: int) -> None:
        name = _name(name_raw.strip())
        if name and name.lower() not in found and (not user_name or name.lower() != user_name.lower()):
            found[name.lower()] = {"name": name, "category": cat, "notes": notes, "_pos": pos}

    # Command forms: "add Priya in family", "add Priya to friends", "add Arjun under mentors"
    for m in re.finditer(rf"\badd\s+{NAME}(?:\s+(?:to|in|under|as)\s+({rel_alt}|family|friends|work|mentors))?", said, re.I):
        c_name = m.group(1)
        raw_cat = (m.group(2) or "friends").lower()
        cat = rel_to_cat.get(raw_cat, raw_cat.title() if raw_cat.title() in CATEGORIES else "Friends")
        add(c_name, cat, "added via voice", m.start(1))

    # Strongest signal: "my sister Priya" / "my best friend Arjun".
    for m in re.finditer(rf"\b[Mm]y\s+(?:\w+\s+)?({rel_alt})(?:,)?\s+(?:named\s+|called\s+|is\s+)?{NAME}", said):
        add(m.group(2), rel_to_cat[m.group(1).lower()], m.group(1).lower(), m.start(2))
    # Then "Arjun, my best friend".
    for m in re.finditer(rf"{NAME},?\s+(?:who's|who is|is)?\s*[Mm]y\s+(?:\w+\s+)?({rel_alt})\b", said):
        add(m.group(1), rel_to_cat[m.group(2).lower()], m.group(2).lower(), m.start(1))
    # Direct "Name in Category": e.g. "Sneha in friends", "Meera in mentors"
    for m in re.finditer(rf"{NAME}\s+(?:in|for|under)\s+(family|friends|work|mentors)\b", said, re.I):
        add(m.group(1), m.group(2).title(), "mentioned", m.start(1))
    # Loose mentions ("catch up with Arjun").
    for m in re.finditer(rf"\b(?:with|call|meet|see|text|ping)\s+{NAME}", said):
        add(m.group(1), "Friends", "mentioned", m.start(1))

    # Check for confirmation command
    action = None
    if re.search(r"\b(?:confirm|submit|save details|looks good|all good|go ahead|looks great)\b", said, re.I):
        action = "confirm"

    contacts = sorted(found.values(), key=lambda c: c.pop("_pos") if "_pos" in c else 0)
    return {"name": user_name, "contacts": contacts, "goals": _rule_goals(said), "action": action}


def _rule_goals(said: str) -> dict:
    low = said.lower()
    goals: dict[str, int] = {}
    for cat, words in CAT_WORDS.items():
        alt = "|".join(words)
        m = (re.search(rf"(\d{{1,3}})\s*(?:%|percent)\s*(?:\w+\s+){{0,3}}?(?:{alt})\b", low)
             or re.search(rf"\b(?:{alt})\b\D{{0,15}}?(\d{{1,3}})\s*(?:%|percent)?", low))
        if m:
            goals[cat] = int(m.group(1))
    if goals:
        return goals
    # No numbers: weight by how much each area comes up.
    return {cat: 1 + sum(low.count(w) for w in words) for cat, words in CAT_WORDS.items()}


# --- validation / normalisation ----------------------------------------------

def _clean(raw: dict, transcript: str) -> dict:
    contacts, seen = [], set()
    for c in (raw.get("contacts") or []):
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "")).strip()[:60]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        cat = str(c.get("category", "")).strip().title()
        contacts.append({
            "name": name,
            "category": cat if cat in CATEGORIES else "Friends",
            "notes": str(c.get("notes", "")).strip()[:140],
        })
        if len(contacts) == MAX_CONTACTS:
            break
    name = raw.get("name")
    action = raw.get("action")
    return {
        "name": str(name).strip()[:60] if name else None,
        "contacts": contacts,
        "goals": normalize_goals(raw.get("goals") or {}),
        "action": "confirm" if action == "confirm" else None,
    }


def normalize_goals(goals: dict) -> dict:
    """Coerce to the 4 categories as ints summing to exactly 100."""
    vals = {}
    for cat in CATEGORIES:
        try:
            vals[cat] = max(0.0, float(goals.get(cat, goals.get(cat.lower(), 0)) or 0))
        except (TypeError, ValueError):
            vals[cat] = 0.0
    total = sum(vals.values())
    if total <= 0:
        return {c: 25 for c in CATEGORIES}
    scaled = {c: v * 100 / total for c, v in vals.items()}
    out = {c: int(v) for c, v in scaled.items()}
    # Largest remainder so the total is exactly 100.
    for c in sorted(CATEGORIES, key=lambda c: scaled[c] - out[c], reverse=True)[: 100 - sum(out.values())]:
        out[c] += 1
    return out
