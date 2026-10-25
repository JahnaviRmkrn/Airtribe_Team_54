--------------------------- MODULE MeetupPayment ---------------------------
(***************************************************************************)
(* Model of one guest's checkout (app/api/rooms/[token]/pay/route.ts and   *)
(* the payment migrations), checked with TLC.                              *)
(*                                                                         *)
(* Several POST workers for the SAME guest (double click, two tabs, an old *)
(* request still running) interleave statement by statement. Each DB       *)
(* statement is one atomic step; the guarded UPDATEs are compare-and-swap  *)
(* on the columns the code filters on. A worker may die between any two    *)
(* steps. createOrder can succeed, fail, or create the order but lose the  *)
(* response. GET (recover + status refresh) and the provider (guest pays,  *)
(* order fails/cancels, refund) run at any time.                           *)
(*                                                                         *)
(* A provider order is identified by the merchant reference it was created *)
(* for, so `pine` (pine_order_id) holds a reference number, 0 = none.      *)
(*                                                                         *)
(* FailedIsTerminal: environment assumption that a Pine Labs order mapped  *)
(*   to 'failed' can never be paid later.                                  *)
(* Mutation flags (all FALSE = current code), each should be caught:       *)
(*   NoClaimCAS      - retry claim ignores updated_at/status (blind write) *)
(*   CreateFirst     - call the provider before inserting the attempt row  *)
(*   SaveIgnoresRef  - saveOrder does not filter on merchant_order_reference *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, MaxRefs, FailedIsTerminal, NoClaimCAS, CreateFirst, SaveIgnoresRef

Refs == 1..MaxRefs
NoRow == [exists |-> FALSE, status |-> "pending", pine |-> 0, ref |-> 0, ver |-> 0]

VARIABLES
  row,       \* meetup_payments row for this guest (unique (meetup_id, attendee_id))
  att,       \* meetup_payment_attempts.state per reference: "none" | creating | uncertain | received
  attPine,   \* meetup_payment_attempts.pine_order_id per reference (0 = null)
  prov,      \* provider order per reference: "none" | pending | paid | failed | cancelled | refunded
  exposed,   \* order ids whose checkout URL the guest has been shown
  nextRef,   \* fresh randomUUID() supply
  pc, snap, myRef, order   \* per-worker program counter and locals

vars == <<row, att, attPine, prov, exposed, nextRef, pc, snap, myRef, order>>

Init ==
  /\ row = NoRow
  /\ att = [r \in Refs |-> "none"] /\ attPine = [r \in Refs |-> 0]
  /\ prov = [r \in Refs |-> "none"]
  /\ exposed = {} /\ nextRef = 1
  /\ pc = [w \in Workers |-> "idle"]
  /\ snap = [w \in Workers |-> NoRow]
  /\ myRef = [w \in Workers |-> 0] /\ order = [w \in Workers |-> 0]

Goto(w, l) == pc' = [pc EXCEPT ![w] = l]
\* view(): the guest sees redirect_url only while the row is pending.
Show(r) == IF r.exists /\ r.status = "pending" /\ r.pine # 0
             THEN exposed \cup {r.pine} ELSE exposed

\* ---- POST: read the (already refreshed) row and decide ------------------------
Start(w) ==
  /\ pc[w] = "idle"
  /\ snap' = [snap EXCEPT ![w] = row]
  /\ IF ~row.exists \/ (row.status \in {"failed", "cancelled"} /\ row.pine # 0)
       THEN Goto(w, "claim") /\ UNCHANGED exposed
       ELSE /\ Goto(w, "done")        \* paid: return it; no order id: 409; pending: return it
            /\ exposed' = Show(row)
  /\ UNCHANGED <<row, att, attPine, prov, nextRef, myRef, order>>

\* ---- POST: claim a fresh merchant reference ------------------------------------
\* Retry: UPDATE ... .eq('updated_at', snap).eq('status', snap). First payment: INSERT,
\* which the unique key rejects (23505 -> 409) if another worker inserted first.
\* Trigger guard_unknown_payment_attempt: leaving failed/cancelled-with-order needs an
\* unused reference (always true here: nextRef is fresh).
Claim(w) ==
  LET s == snap[w] IN
  /\ pc[w] = "claim" /\ nextRef <= MaxRefs
  /\ IF s.exists
       THEN IF NoClaimCAS \/ (row.ver = s.ver /\ row.status = s.status)
              THEN /\ row' = [exists |-> TRUE, status |-> "pending", pine |-> 0,
                              ref |-> nextRef, ver |-> row.ver + 1]
                   /\ myRef' = [myRef EXCEPT ![w] = nextRef] /\ nextRef' = nextRef + 1
                   /\ Goto(w, IF CreateFirst THEN "create" ELSE "attempt")
              ELSE Goto(w, "done") /\ UNCHANGED <<row, myRef, nextRef>>   \* 409
       ELSE IF ~row.exists
              THEN /\ row' = [exists |-> TRUE, status |-> "pending", pine |-> 0,
                              ref |-> nextRef, ver |-> 1]
                   /\ myRef' = [myRef EXCEPT ![w] = nextRef] /\ nextRef' = nextRef + 1
                   /\ Goto(w, IF CreateFirst THEN "create" ELSE "attempt")
              ELSE Goto(w, "done") /\ UNCHANGED <<row, myRef, nextRef>>   \* 23505
  /\ UNCHANGED <<att, attPine, prov, exposed, snap, order>>

\* ---- POST: durable attempt row BEFORE calling the provider ---------------------
Attempt(w) ==
  /\ pc[w] = "attempt"
  /\ att' = [att EXCEPT ![myRef[w]] = "creating"]
  /\ Goto(w, IF CreateFirst THEN "receipt" ELSE "create")
  /\ UNCHANGED <<row, attPine, prov, exposed, nextRef, snap, myRef, order>>

\* ---- POST: createOrder ---------------------------------------------------------
\* outcome "ok": created and answered; "lost": created, response lost (exception);
\* "fail": not created (exception). An exception marks the attempt uncertain.
Create(w, outcome) ==
  LET r == myRef[w] IN
  /\ pc[w] = "create"
  /\ prov' = IF outcome \in {"ok", "lost"} THEN [prov EXCEPT ![r] = "pending"] ELSE prov
  /\ IF outcome = "ok"
       THEN /\ order' = [order EXCEPT ![w] = r]
            /\ Goto(w, IF CreateFirst THEN "attempt" ELSE "receipt")
            /\ UNCHANGED att
       ELSE /\ att' = IF att[r] # "none" /\ attPine[r] = 0
                        THEN [att EXCEPT ![r] = "uncertain"] ELSE att
            /\ Goto(w, "done") /\ UNCHANGED order                         \* 502
  /\ UNCHANGED <<row, attPine, exposed, nextRef, snap, myRef>>

\* ---- POST: saveReceipt (attempt row, .is('pine_order_id', null)) ----------------
Receipt(w) ==
  LET r == myRef[w] IN
  /\ pc[w] = "receipt"
  /\ IF att[r] # "none" /\ attPine[r] = 0
       THEN /\ att' = [att EXCEPT ![r] = "received"]
            /\ attPine' = [attPine EXCEPT ![r] = order[w]]
       ELSE UNCHANGED <<att, attPine>>
  /\ Goto(w, "save")
  /\ UNCHANGED <<row, prov, exposed, nextRef, snap, myRef, order>>

\* A transient error leaves saveReceipt undefined (not false): continue to saveOrder.
ReceiptLost(w) ==
  /\ pc[w] = "receipt" /\ Goto(w, "save")
  /\ UNCHANGED <<row, att, attPine, prov, exposed, nextRef, snap, myRef, order>>

\* ---- POST: saveOrder (.eq(ref).eq('status','pending').is('pine_order_id', null)) --
SaveOrder(w) ==
  /\ pc[w] = "save"
  /\ IF row.exists /\ (SaveIgnoresRef \/ row.ref = myRef[w])
        /\ row.status = "pending" /\ row.pine = 0
       THEN /\ row' = [row EXCEPT !.pine = order[w], !.ver = row.ver + 1]
            /\ exposed' = exposed \cup {order[w]}                          \* 201 + URL
       ELSE UNCHANGED <<row, exposed>>                                    \* 503
  /\ Goto(w, "done")
  /\ UNCHANGED <<att, attPine, prov, nextRef, snap, myRef, order>>

\* A worker (or its process) can stop between any two statements.
Crash(w) ==
  /\ pc[w] \notin {"idle", "done"} /\ Goto(w, "done")
  /\ UNCHANGED <<row, att, attPine, prov, exposed, nextRef, snap, myRef, order>>

\* The same browser sends another POST later (a new request, fresh locals).
Again(w) ==
  /\ pc[w] = "done" /\ nextRef <= MaxRefs
  /\ pc' = [pc EXCEPT ![w] = "idle"]
  /\ snap' = [snap EXCEPT ![w] = NoRow]
  /\ myRef' = [myRef EXCEPT ![w] = 0] /\ order' = [order EXCEPT ![w] = 0]
  /\ UNCHANGED <<row, att, attPine, prov, exposed, nextRef>>

\* ---- GET / refresh(): recover() then provider status ---------------------------
\* recover: pending, no order id, own attempt has a receipt -> attach that order (CAS).
Recover ==
  /\ row.exists /\ row.status = "pending" /\ row.pine = 0
  /\ att[row.ref] = "received" /\ attPine[row.ref] # 0
  /\ row' = [row EXCEPT !.pine = attPine[row.ref], !.ver = row.ver + 1]
  /\ exposed' = exposed \cup {attPine[row.ref]}
  /\ UNCHANGED <<att, attPine, prov, nextRef, pc, snap, myRef, order>>

Map(s) == CASE s = "paid" -> "paid" [] s = "failed" -> "failed"
            [] s \in {"cancelled", "refunded"} -> "cancelled" [] OTHER -> "pending"

\* getOrderStatus then UPDATE ... .eq(pine).eq('status','pending'): only pending moves.
Sync ==
  /\ row.exists /\ row.status = "pending" /\ row.pine # 0
  /\ Map(prov[row.pine]) # "pending"
  /\ row' = [row EXCEPT !.status = Map(prov[row.pine]), !.ver = row.ver + 1]
  /\ UNCHANGED <<att, attPine, prov, exposed, nextRef, pc, snap, myRef, order>>

\* GET returns view(row): shows the URL of a pending row's order.
View ==
  /\ exposed' = Show(row) /\ exposed' # exposed
  /\ UNCHANGED <<row, att, attPine, prov, nextRef, pc, snap, myRef, order>>

\* ---- provider / guest -----------------------------------------------------------
Pay(o) ==
  /\ o \in exposed
  /\ prov[o] = "pending" \/ (~FailedIsTerminal /\ prov[o] = "failed")
  /\ prov' = [prov EXCEPT ![o] = "paid"]
  /\ UNCHANGED <<row, att, attPine, exposed, nextRef, pc, snap, myRef, order>>

Lapse(o, s) ==     \* order fails or is cancelled at the provider
  /\ prov[o] = "pending" /\ prov' = [prov EXCEPT ![o] = s]
  /\ UNCHANGED <<row, att, attPine, exposed, nextRef, pc, snap, myRef, order>>

Refund(o) ==
  /\ prov[o] = "paid" /\ prov' = [prov EXCEPT ![o] = "refunded"]
  /\ UNCHANGED <<row, att, attPine, exposed, nextRef, pc, snap, myRef, order>>

Next ==
  \/ \E w \in Workers :
       \/ Start(w) \/ Claim(w) \/ Attempt(w) \/ Receipt(w) \/ ReceiptLost(w)
       \/ SaveOrder(w) \/ Crash(w) \/ Again(w)
       \/ \E o \in {"ok", "lost", "fail"} : Create(w, o)
  \/ Recover \/ Sync \/ View
  \/ \E o \in Refs : Pay(o) \/ Refund(o) \/ \E s \in {"failed", "cancelled"} : Lapse(o, s)

Spec == Init /\ [][Next]_vars

\* ---- properties ---------------------------------------------------------------
TypeOK ==
  /\ row.status \in {"pending", "paid", "failed", "cancelled"}
  /\ row.pine \in 0..MaxRefs /\ row.ref \in 0..MaxRefs
  /\ att \in [Refs -> {"none", "creating", "uncertain", "received"}]
  /\ attPine \in [Refs -> 0..MaxRefs]
  /\ prov \in [Refs -> {"none", "pending", "paid", "failed", "cancelled", "refunded"}]
  /\ exposed \subseteq Refs /\ nextRef \in 1..MaxRefs + 1
  /\ pc \in [Workers -> {"idle", "claim", "attempt", "create", "receipt", "save", "done"}]

\* No double charge: at most one of the guest's provider orders is paid (and unrefunded).
AtMostOneCharged == Cardinality({o \in Refs : prov[o] = "paid"}) <= 1
\* Every provider order has a durable local attempt row (recoverable, never orphaned).
NoUntrackedOrder == \A o \in Refs : prov[o] # "none" => att[o] # "none"
\* The row only ever points at the order created for its own reference.
RowOrderIsOwn == row.pine # 0 => row.pine = row.ref
\* A receipt names the order created for that same reference.
ReceiptIsOwn == \A r \in Refs : attPine[r] # 0 => attPine[r] = r
\* Money is never taken on an order the row has moved away from (it would go unseen).
PaidIsTracked == \A o \in Refs : prov[o] = "paid" => row.pine = o
\* A row says paid only if the provider really took the money.
PaidMeansPaid == row.status = "paid" => prov[row.pine] \in {"paid", "refunded"}
\* The guest is only ever offered checkouts that the row tracks or tracked.
ExposedTracked == \A o \in exposed : att[o] # "none" /\ prov[o] # "none"

PaidSticky == [][row.status = "paid" => row'.status = "paid"]_vars

\* Vacuity checks (expected to be VIOLATED: they show these states are reachable).
NeverPaid == row.status # "paid"
NeverRetried == nextRef <= 2
NeverRecoverable == ~ENABLED Recover
=============================================================================
