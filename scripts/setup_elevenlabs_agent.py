"""Create the ElevenLabs onboarding voice agent (one-off). Originally by
Arindom Chetia (PR #3); updated for Moup and Next.js.

    export ELEVENLABS_API_KEY=sk_...     (PowerShell: $env:ELEVENLABS_API_KEY="sk_...")
    python3 scripts/setup_elevenlabs_agent.py

Prints the new agent_id - put it in .env.local as ELEVENLABS_AGENT_ID (next to
ELEVENLABS_API_KEY; both are server-only). The organizer onboarding screen
(/organizer/#/onboarding) then shows "Talk instead"; the browser gets a
short-lived signed URL from GET /api/voice/signed-url.

You can also create the agent by hand in the ElevenLabs dashboard
(Conversational AI -> Agents) by pasting PROMPT and FIRST_MESSAGE below.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


def _load_env() -> None:
    for name in (".env.local", ".env"):
        p = Path(name)
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()

FIRST_MESSAGE = (
    "Good day. Welcome to Moup. I am here to help you stay connected with the people who matter most to you. "
    "Who are the key individuals you would like to prioritize keeping in touch with?"
)

PROMPT = """You are an intelligent, thoughtful, and professional relationship management assistant for Moup.
Your objective is to conduct a natural, slightly formal, and efficient conversation to understand the user's primary relationships and attention goals.

Tone & Demeanor:
- Speak in a natural, polite, respectful, and slightly formal tone.
- Do not attempt humor or colloquial slang. Avoid informal enthusiasm such as "Awesome!", "Cool!", or "Super!".
- Never mention "forms", "filling fields", "onboarding screens", or "inputs". You are having an authentic conversation about their personal and professional relationships.
- Keep every response to exactly ONE concise, thoughtful sentence so audio generation is as fast as possible.

Conversation Flow:
1. When the user mentions individuals, acknowledge each person respectfully with their relationship (e.g., "Understood, Priya is your sister." or "Thank you, I have noted Arjun among your friends.").
2. Inquire naturally about other relationships across their life (family, friends, colleagues, or mentors).
3. Inquire how they prefer to balance their attention across these areas (e.g., "How would you ideally allocate your focus between family, friends, work, and mentorship?").
4. If they ask questions or give instructions, respond directly and professionally.
5. When the user indicates they have shared everyone, conclude courteously:
   "Thank you. Your relationship priorities have been prepared for your review."
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print configuration without contacting ElevenLabs")
    args = parser.parse_args()
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key and not args.dry_run:
        sys.exit("Set ELEVENLABS_API_KEY first.")
    body = {
        "name": "Moup Voice Agent (Team 54)",
        "conversation_config": {
            "agent": {
                "first_message": FIRST_MESSAGE,
                "language": "en",
                "prompt": {
                    "prompt": PROMPT,
                    "llm": "gemini-2.0-flash",
                    "temperature": 0.1,
                },
            },
            "turn": {
                "turn_timeout": 1.2,
                "turn_eagerness": "eager",
                "mode": "turn",
            },
            "conversation": {"max_duration_seconds": 180},
        },
        "platform_settings": {"auth": {"enable_auth": True}},
    }
    if args.dry_run:
        print(json.dumps(body, indent=2))
        return

    existing = os.getenv("ELEVENLABS_AGENT_ID")
    if existing and not all(c.isalnum() or c in "_-" for c in existing):
        sys.exit("Invalid ELEVENLABS_AGENT_ID")

    endpoint = f"https://api.elevenlabs.io/v1/convai/agents/{existing}" if existing else "https://api.elevenlabs.io/v1/convai/agents/create"
    req = urllib.request.Request(
        endpoint,
        method="PATCH" if existing else "POST",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            agent_id = json.loads(r.read())["agent_id"]
    except urllib.error.HTTPError as e:
        sys.exit(f"ElevenLabs error {e.code}; check account permissions and configuration.")
    print(f"Configured agent: {agent_id}\nAdd to .env.local and .env:\nELEVENLABS_AGENT_ID={agent_id}")


if __name__ == "__main__":
    main()
