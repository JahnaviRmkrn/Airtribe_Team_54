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

FIRST_MESSAGE = (
    "Hi! I'll help you set up your organizer in about thirty seconds. "
    "Who are a few people you'd like to stay closer to?"
)

PROMPT = """You are a warm, brisk onboarding assistant for a personal relationship organizer.
Your only job is to learn two things in under 60 seconds, then wrap up:

1. Up to FIVE people the user wants to keep in touch with. For each, get their
   first name and how the user knows them (family, friend, work, or mentor).
   A short detail is a bonus ("my sister Priya, she just moved to Pune").
2. How the user wants to split their attention across Family, Friends, Work and
   Mentors. Ask for rough percentages; if they're unsure, offer a split based on
   what they said and ask them to confirm.

Style:
- One short question at a time. Never more than two sentences per turn.
- Repeat names back so the transcript is unambiguous ("Got it - Priya, your sister.").
- Do not give advice, do not schedule anything, do not promise to send messages.
- Once you have the people and the split, say: "Perfect - I'll put that on screen
  for you to check. Nothing is saved until you confirm." and end the conversation.
"""


def main() -> None:
    key = os.getenv("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("Set ELEVENLABS_API_KEY first.")
    body = {
        "name": "Organizer onboarding (Team 54)",
        "conversation_config": {
            "agent": {
                "first_message": FIRST_MESSAGE,
                "language": "en",
                "prompt": {"prompt": PROMPT},
            },
            "conversation": {"max_duration_seconds": 180},
        },
    }
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
