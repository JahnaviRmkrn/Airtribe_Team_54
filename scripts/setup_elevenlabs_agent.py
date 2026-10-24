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
    "Hi there! Welcome to Organizer. I'm here to help calibrate your network in about thirty seconds. "
    "Who are a few people—friends, family, or colleagues—you'd love to stay closer to?"
)

PROMPT = """You are a friendly, warm, and efficient onboarding conversational assistant for Organizer, a personal relationship management app.
Your objective is to quickly learn two things in under 60 seconds:

1. Up to FIVE key people the user wants to prioritize staying in touch with.
   - For each person, note their name and their relationship category: Family, Friends, Work, or Mentors.
   - Any added detail is welcome (e.g. "my sister Priya in Pune", "Arjun, my college friend").
2. How the user wants to allocate their attention across the 4 core buckets: Family, Friends, Work, and Mentors (summing to 100%).
   - Prompt them for rough target percentages. If they're unsure, suggest a balanced split and ask if they like it.

Conversational Guidelines:
- Ask one brief question at a time. Keep your replies concise (under 2 sentences).
- Acknowledge each person by repeating their name and connection clearly so speech-to-text captures it accurately.
- Never promise to send automated messages or take actions without their approval.
- When done, smoothly conclude: "Awesome! I've prepared everything for your review on screen. Nothing will be saved until you confirm." then end the session.
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
