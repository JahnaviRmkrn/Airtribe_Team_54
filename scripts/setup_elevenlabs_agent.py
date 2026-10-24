"""Create the ElevenLabs onboarding voice agent (one-off).

    set ELEVENLABS_API_KEY=sk_...        (PowerShell: $env:ELEVENLABS_API_KEY="sk_...")
    python scripts/setup_elevenlabs_agent.py

Prints the new agent_id - put it in .env as ELEVENLABS_AGENT_ID.
You can also create the agent by hand in the ElevenLabs dashboard
(Conversational AI -> Agents) by pasting PROMPT and FIRST_MESSAGE below.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _load_env() -> None:
    p = Path(".env")
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()

FIRST_MESSAGE = (
    "Hi there! I'm your Moup voice assistant. I can fill out this entire form for you by voice. "
    "Tell me your name, people you'd like to add, or your attention split, and I'll fill it in right away!"
)

PROMPT = """You are the intelligent, highly capable voice assistant for Moup, an inner-circle relationship manager.
Your primary role is to fill out the user's form on screen and execute ANY voice command they give you.

HOW TO HANDLE COMMANDS:
1. Setting Name:
   - When user says: "My name is [Name]" or "Call me [Name]" -> Say: "Nice to meet you, [Name]! I've filled in your name on the form."
2. Adding Contacts & People (Family, Friends, Work, Mentors):
   - When user says: "Add [Name] to [Category] (notes)" or "My sister Priya in family" -> Say: "Added [Name] to your [Category] contacts."
3. Attention Goals Split:
   - When user says: "Set family to 50%, friends to 30%, work 20%" -> Say: "Updated your attention goals: 50% Family, 30% Friends, and 20% Work."
4. General Instructions & Commands:
   - Whatever the user commands, acknowledge them immediately, execute it, and confirm verbally what you updated on the form!
5. Submitting or Confirming:
   - When user commands: "Confirm", "Submit", "Looks good", "Save", "Finish" -> Say: "Awesome! Submitting and saving your details now!"

CONVERSATIONAL RULES:
- Always respond out loud immediately. Never stay silent.
- Keep each reply concise and conversational (1 to 2 sentences).
- Explicitly confirm what was updated on the form so the user knows their voice command worked!
"""


def main() -> None:
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("Set ELEVENLABS_API_KEY first.")
    agent_id = os.getenv("ELEVENLABS_AGENT_ID")
    body = {
        "name": "Moup Voice Agent (Team 54)",
        "conversation_config": {
            "agent": {
                "first_message": FIRST_MESSAGE,
                "language": "en",
                "prompt": {
                    "prompt": PROMPT,
                    "llm": "gemini-2.0-flash",
                    "temperature": 0.2,
                },
            },
            "turn": {
                "turn_timeout": 1.6,
                "turn_eagerness": "eager",
                "mode": "turn",
            },
            "conversation": {"max_duration_seconds": 180},
        },
    }

    if agent_id:
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/convai/agents/{agent_id}",
            data=json.dumps(body).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            method="PATCH",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                print(f"Updated agent {agent_id} successfully.")
        except urllib.error.HTTPError as e:
            sys.exit(f"ElevenLabs error {e.code}: {e.read().decode()[:500]}")
    else:
        req = urllib.request.Request(
            "https://api.elevenlabs.io/v1/convai/agents/create",
            data=json.dumps(body).encode(),
            headers={"xi-api-key": key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                agent_id = json.loads(r.read())["agent_id"]
        except urllib.error.HTTPError as e:
            sys.exit(f"ElevenLabs error {e.code}: {e.read().decode()[:500]}")
        print(f"Created agent: {agent_id}\nAdd to .env:\nELEVENLABS_AGENT_ID={agent_id}")


if __name__ == "__main__":
    main()
