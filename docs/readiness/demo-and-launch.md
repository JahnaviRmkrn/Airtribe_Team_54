# Team 54: demo and launch runbook

## Three-minute demo script

0:00–0:20 — “Keeping in touch is easy to postpone. We turn a quick conversation into a plan you can edit, then help a group choose a meetup.” Show the landing page and sign in with a dedicated demo account.

0:20–1:10 — Open Organizer → onboarding → Talk instead. Say: “My sister Priya Sharma, personal, every week. My colleague Arjun Rao, professional, monthly. My neighbour Fatima Khan, community, every two weeks. Personal 60, professional 30, community 30 percent.” Show the three editable contacts, cadences 7/30/14, and normalized goals 50/25/25. Explain that extraction is a draft and nothing is saved until Confirm. Correct one field on screen, then Confirm.

1:10–1:40 — Show the dashboard and create a meetup. Copy its guest link into a second browser profile or phone. Do not confuse a guest joining with a new organizer signup.

1:40–2:20 — Join as a guest using a fictional name. Set preferences and availability. Vote for one venue, then move that vote to another. Explain that each guest has one active vote. Refresh the organizer view and show the tally.

2:20–2:45 — Confirm the venue as organizer. Close the room and show the read-only guest state. Say that closing is final. Do not demonstrate a reopen button or claim automatic bookings.

2:45–3:00 — “We are inviting 20 people to try this and tell us where it gets in their way.” Quote actual signup/feedback counts only. End with the verified deployment URL or QR code.

## Rehearsal and backup recording

- Record a complete 3-minute take after the deployed build passes the same extraction and room smoke checks. Use fictional contacts, a test account, and two browser profiles. Hide notifications, password managers, credentials and unrelated tabs.
- Record at 1080p with microphone and system audio. Verify the exported MP4 plays offline with audible speech. Save a second copy on the presenter's phone. Include the build commit and recording timestamp in a sidecar note.
- Capture three short recovery clips too: voice → extraction, editable confirm → dashboard, guest vote → organizer confirm/close. Keep screenshots of the editable draft and closed room.
- If microphone or ElevenLabs fails, say “I'll use the text input” and paste the exact spoken script. If extraction provider fails, identify the rule-based fallback honestly and review fields. If the backend or network fails, switch to the clearly labelled prerecorded demo; do not present it as live.
- Before stage time: fresh demo account/room, charged phone, hotspot, permissions tested, volume checked, backup video open, and no production customer data visible.
- Never claim speech quality from text fixtures. A real phone conversation and manual transcript review are still required.

## Twenty-user recruitment

The user authorized outreach through the wacli2 account to the PES group. An initial invitation was sent to “Sec A MTech DSAI Jul 2024_PES” on 24 October 2026; WhatsApp message ID `3EB08F204BE335DA3C6507`. This is an invitation, not twenty recruited users.

Use `user-recruitment.csv`: allocate five volunteers to each of A/B/C/D. Replace anonymous slots only when a person volunteers; keep contact details outside Git. Track invited → opted in → link sent → signed up → tried onboarding → joined meetup → feedback. Do not fabricate names or mark invitations as signups.

Once the deployment is verified, send volunteers: “Thanks for helping! Try [VERIFIED LINK]. Please sign up, add 2–3 fictional contacts by voice or text, check the extracted fields, create a meetup, and join a shared room. What was confusing? Did anything look wrong? It should take about 5 minutes.”

Collect three answers: (1) Did the people/categories/frequencies match what you said? (2) Could you join and vote without help? (3) Would you use this again, and why? Log failures with device/browser and consented repro steps, not recordings of private conversations.

Release gate: working HTTPS link, organizer signup tested, guest join tested on a second device, extraction source visible in evidence, and no unsupported AgentCore claim. No signup link was sent in the first invitation because deployment had not been verified.
