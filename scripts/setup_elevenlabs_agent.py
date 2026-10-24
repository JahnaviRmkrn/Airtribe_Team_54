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
    "Hi there! Welcome to Moup. I'm here to help calibrate your network in about thirty seconds. "
    "Who are a few people—friends, family, or colleagues—you'd love to stay closer to?"
)

PROMPT = """You are a friendly, warm, and highly responsive conversational voice assistant for Moup, a personal relationship management app.

Core Behavioral Rules:
- Whenever the user speaks, gives a command, greets you, or says anything (e.g. "Hello", "Hey", "Can you hear me?"), you MUST IMMEDIATELY respond out loud with a warm, natural answer. Never stay silent.
- Your mission is to help them quickly set up their inner circle:
  1. Ask for up to FIVE people they want to stay close to (name + whether they are Family, Friends, Work, or Mentors).
  2. Ask for their rough attention target split across Family, Friends, Work, and Mentors (summing to 100%).
- Keep each reply short and punchy (1 to 2 sentences maximum).
- Acknowledge each person by repeating their name and category clearly.
- When they are done or say they've shared everyone, say: "Awesome! I've prepared everything for your review on screen. Nothing will be saved until you confirm." and conclude.
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
