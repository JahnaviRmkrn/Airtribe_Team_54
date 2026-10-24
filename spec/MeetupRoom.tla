---------------------------- MODULE MeetupRoom ----------------------------
(***************************************************************************)
(* Model of the meetup room + follow-up logic, checked with TLC.          *)
(*                                                                         *)
(* Every guest request is two steps, like the real handlers: the API reads *)
(* a snapshot of the room (getRoom/requireOpen), then later the database   *)
(* write commits. Other requests and the organiser can interleave between  *)
(* the two steps.                                                          *)
(*                                                                         *)
(* Fixed = TRUE  models the code after PR #2: DB triggers lock the meetup  *)
(*               row and re-check open/expiry/cap/confirmation at commit;  *)
(*               record_interaction runs in one locked transaction.        *)
(* Fixed = FALSE models PR #1: only the API snapshot check, then an        *)
(*               unconditional write; read-modify-write for interactions.  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Guests, Venues, MaxGuests, Times, Fixed, UnvoteGuarded

None == "none"
NoOp == [op |-> "none"]   \* empty pending request
Idle == 99                \* no interaction in flight

VARIABLES
  status,     \* "open" | "closed"
  expired,    \* room past expires_at
  final,      \* confirmed venue, or None
  joined,     \* guests with an attendee row
  votes,      \* guest -> venue | None   (unique (meetup_id, attendee_id))
  pending,    \* guest -> in-flight request that passed the API check
  bad,        \* ghost: set of violated rules, for readable counterexamples
  \* follow-up logic for one contact
  last,       \* contacts.last_interaction_at (0 = never)
  inflight,   \* interaction time -> snapshot of `last` read by the request (old code)
  recorded    \* interaction times committed so far

vars == <<status, expired, final, joined, votes, pending, bad, last, inflight, recorded>>

Ops == [op : {"join", "edit", "unvote"}] \cup [op : {"vote"}, v : Venues]
Max(S) == IF S = {} THEN 0 ELSE CHOOSE x \in S : \A y \in S : x >= y

Init ==
  /\ status = "open" /\ expired = FALSE /\ final = None
  /\ joined = {} /\ votes = [g \in Guests |-> None]
  /\ pending = [g \in Guests |-> NoOp]
  /\ bad = {}
  /\ last = 0 /\ inflight = [t \in Times |-> Idle] /\ recorded = {}

RoomOpen == status = "open" /\ ~expired

\* ---- step 1: API handler checks its snapshot ------------------------------
StartJoin(g) ==
  /\ pending[g] = NoOp /\ g \notin joined /\ RoomOpen
  /\ Cardinality(joined) < MaxGuests          \* PR #1 count check (snapshot)
  /\ pending' = [pending EXCEPT ![g] = [op |-> "join"]]
  /\ UNCHANGED <<status, expired, final, joined, votes, bad, last, inflight, recorded>>

StartEdit(g) ==
  /\ pending[g] = NoOp /\ g \in joined /\ RoomOpen
  /\ pending' = [pending EXCEPT ![g] = [op |-> "edit"]]
  /\ UNCHANGED <<status, expired, final, joined, votes, bad, last, inflight, recorded>>

StartVote(g, v) ==
  /\ pending[g] = NoOp /\ g \in joined /\ RoomOpen /\ final = None
  /\ pending' = [pending EXCEPT ![g] = [op |-> "vote", v |-> v]]
  /\ UNCHANGED <<status, expired, final, joined, votes, bad, last, inflight, recorded>>

StartUnvote(g) ==
  /\ pending[g] = NoOp /\ g \in joined /\ RoomOpen
  /\ pending' = [pending EXCEPT ![g] = [op |-> "unvote"]]
  /\ UNCHANGED <<status, expired, final, joined, votes, bad, last, inflight, recorded>>

\* ---- step 2: the DB write commits -----------------------------------------
\* With Fixed, a trigger re-checks the room atomically (meetup row locked).
Guard(p) ==
  CASE p.op = "join"   -> RoomOpen /\ Cardinality(joined) < MaxGuests
    [] p.op = "edit"   -> RoomOpen
    [] p.op = "vote"   -> RoomOpen /\ final = None
    [] p.op = "unvote" -> UnvoteGuarded => RoomOpen   \* DELETE has no trigger unless UnvoteGuarded

Violations(p) ==
  (IF RoomOpen THEN {} ELSE {"write-to-closed-room"})
  \cup (IF p.op = "join" /\ Cardinality(joined) >= MaxGuests THEN {"over-capacity"} ELSE {})
  \cup (IF p.op = "vote" /\ final # None THEN {"vote-after-confirm"} ELSE {})

Commit(g) ==
  LET p == pending[g] IN
  /\ p # NoOp
  /\ pending' = [pending EXCEPT ![g] = NoOp]
  /\ IF Fixed /\ ~Guard(p)
       THEN UNCHANGED <<joined, votes, bad>>              \* trigger raises; API maps to 410/429/409
       ELSE /\ bad' = bad \cup Violations(p)
            /\ joined' = IF p.op = "join" THEN joined \cup {g} ELSE joined
            /\ votes' = CASE p.op = "vote"   -> [votes EXCEPT ![g] = p.v]
                          [] p.op = "unvote" -> [votes EXCEPT ![g] = None]
                          [] OTHER           -> votes
  /\ UNCHANGED <<status, expired, final, last, inflight, recorded>>

\* ---- organiser and time -----------------------------------------------------
Close ==
  /\ status = "open" /\ status' = "closed"
  /\ UNCHANGED <<expired, final, joined, votes, pending, bad, last, inflight, recorded>>

\* confirm/route.ts: requireOpen, then UPDATE meetups (takes the row lock).
Confirm(v) ==
  /\ RoomOpen /\ final = None /\ final' = v
  /\ UNCHANGED <<status, expired, joined, votes, pending, bad, last, inflight, recorded>>

Expire ==
  /\ ~expired /\ expired' = TRUE
  /\ UNCHANGED <<status, final, joined, votes, pending, bad, last, inflight, recorded>>

\* ---- follow-ups: POST /api/me/interactions --------------------------------
\* Fixed: record_interaction locks the contact and moves `last` forward only.
\* Old: read the contact, insert, then write a value derived from the stale read.
StartInteraction(t) ==
  /\ t \notin recorded /\ inflight[t] = Idle
  /\ IF Fixed
       THEN /\ last' = IF t > last THEN t ELSE last
            /\ recorded' = recorded \cup {t}
            /\ UNCHANGED inflight
       ELSE /\ inflight' = [inflight EXCEPT ![t] = last]
            /\ UNCHANGED <<last, recorded>>
  /\ UNCHANGED <<status, expired, final, joined, votes, pending, bad>>

FinishInteraction(t) ==
  /\ ~Fixed /\ inflight[t] # Idle
  /\ last' = IF t > inflight[t] THEN t ELSE last     \* decision made on the stale snapshot
  /\ recorded' = recorded \cup {t}
  /\ inflight' = [inflight EXCEPT ![t] = Idle]
  /\ UNCHANGED <<status, expired, final, joined, votes, pending, bad>>

Next ==
  \/ \E g \in Guests : StartJoin(g) \/ StartEdit(g) \/ StartUnvote(g) \/ Commit(g)
  \/ \E g \in Guests, v \in Venues : StartVote(g, v)
  \/ Close \/ Expire
  \/ \E v \in Venues : Confirm(v)
  \/ \E t \in Times : StartInteraction(t) \/ FinishInteraction(t)

Spec == Init /\ [][Next]_vars

\* ---- properties --------------------------------------------------------------
TypeOK ==
  /\ status \in {"open", "closed"} /\ expired \in BOOLEAN
  /\ final \in Venues \cup {None}
  /\ joined \subseteq Guests
  /\ votes \in [Guests -> Venues \cup {None}]
  /\ pending \in [Guests -> Ops \cup {NoOp}]

NoWriteToClosedRoom == "write-to-closed-room" \notin bad
CapacityRespected   == Cardinality(joined) <= MaxGuests /\ "over-capacity" \notin bad
NoVoteAfterConfirm  == "vote-after-confirm" \notin bad
OnlyMembersVote     == \A g \in Guests : votes[g] # None => g \in joined
\* One vote per guest holds by construction: votes is a function (DB unique key).
LastIsLatest        == last = Max(recorded)

FinalNeverChanges == [][final # None => final' = final]_vars
ClosedStaysClosed == [][status = "closed" => status' = "closed"]_vars
=============================================================================
