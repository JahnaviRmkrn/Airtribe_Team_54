# TLA+ model of the meetup room

`MeetupRoom.tla` models the concurrent parts of the app and TLC checks every
interleaving. Each guest request is two steps, like the real handlers: the API
checks a room snapshot, then the DB write commits. Organiser close/confirm,
room expiry and follow-up recording can interleave between those steps.

Invariants: no guest write commits to a closed/expired room, the 50-guest cap
(scaled down) holds, no vote after a venue is confirmed, only members vote,
`last_interaction_at` equals the newest recorded interaction. Temporal
properties: a confirmed venue never changes, a closed room never reopens.

```bash
# needs Java 11+ and tla2tools.jar (github.com/tlaplus/tlaplus/releases)
pnpm tla                                                     # current code
java -cp tla2tools.jar tlc2.TLC -deadlock -config MeetupRoom_large.cfg MeetupRoom
java -cp tla2tools.jar tlc2.TLC -deadlock -continue -config MeetupRoom_PR1.cfg MeetupRoom
```

| Config | Models | Result |
|---|---|---|
| `MeetupRoom.cfg` | current code (3 guests, cap 2) | no errors, 73,824 states |
| `MeetupRoom_large.cfg` | current code (4 guests, cap 3, 3 interactions) | no errors, 3,158,016 states |
| `MeetupRoom_PR1.cfg` | PR #1 logic (API checks only) | violates NoWriteToClosedRoom, CapacityRespected, NoVoteAfterConfirm, LastIsLatest |
| `UnvoteGuarded = FALSE` | PR #2 logic | violates NoWriteToClosedRoom (vote withdrawal after close), fixed by `20261024110000_unvote_guard.sql` |

This checks the design, not the TypeScript itself; `scripts/smoke.mjs` checks
that the running code behaves the way the model assumes.
