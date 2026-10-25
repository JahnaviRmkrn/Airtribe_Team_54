# Payment safety upgrade: operator checklist

Repository code and local tests do **not** establish the production database's
migration state. No production database, Vault, provider account, credentials,
migration, configuration or deployment was accessed or changed for this work.
Do not run this checklist without explicit authorization for the intended system.

## What the application does before setup is ready

- Each authenticated guest GET/POST calls the service-role-only, read-only
  `payment_checkout_ready()` capability probe. No environment flag substitutes
  for its positive result. Missing objects or an explicit false result mean
  setup-required; timeouts, lost read acknowledgements, null and unrecognized
  errors mean temporarily unavailable, not a claim that setup is missing.
- POST fails before creating a claim or contacting the provider when readiness
  is not established. Missing receipt persistence still blocks provider creation
  if the schema changes after the probe. There is no unsafe creation fallback.
- GET may read only the original payment columns when setup is missing. For an
  existing pending payment with a known provider order ID it may read provider
  status, but does not save that result to the database. Already-paid rows are
  displayed without provider access. No receipt recovery, claim changes, or
  checkout links are returned in this mode. Unknown/no-ID rows remain blocked.
- Both React and static clients require an explicit ready response before Pay
  is enabled. Setup-required and failed initial/subsequent status checks disable
  checkout. Check status remains manual; no checkout or status retry is scheduled.
  A legacy server response lacking the readiness field is not treated as ready.
- Guest responses contain no database object names, raw errors, merchant
  references, provider order IDs, receipt contents or credentials.

## Authorized rollout sequence

1. Identify the exact target application and database, currently deployed commit,
   applied migration versions and rollback/backup owner. Do not infer the schema
   from the repository or from configured payment credentials.
2. Put payment creation into maintenance at ingress for **every** old and new
   instance, including alternate deployments and background consumers. Stop and
   drain older workers before migrating. Account for requests already in flight
   to Pine Labs: finish them or retain their unresolved claims for reconciliation.
   Do not expire, clear, delete, reset, cancel or replay an uncertain attempt just
   because time elapsed. A new database trigger cannot unsend an in-flight call.
3. Review/apply the payment base migrations in order. Apply
   `20261025120000_payment_attempt_receipts.sql` if not already applied, then
   `20261025122000_payment_checkout_readiness.sql` as a new additive migration.
   The latter reinstalls the final terminal-retry reference guard even when an
   earlier revision of the receipts migration was already recorded. Do not edit
   migration history or assume an edited old file has run again. An incomplete
   first migration must be investigated, not blindly retried against live data.
4. In the approved database tooling, verify the capability in a read-only
   transaction under the application's service role:

   ```sql
   begin read only;
   set local role service_role;
   select public.payment_checkout_ready(); -- must return exactly true
   rollback;
   ```

   Verify `anon` and `authenticated` cannot execute this function. Inspect the
   applied migration ledger, RLS and enabled triggers, including
   `payments_unknown_attempt`, `payments_new_attempt`, `payments_attendee` and
   `payment_attempts_receipt`. Review `guard_unknown_payment_attempt()` against
   the additive migration: it must reject no-ID unknown outcome reclamation and
   require an unused nonblank reference when retrying a known terminal order.
   Wait for/reload the approved PostgREST schema cache if the RPC is still missing;
   do not bypass readiness or grant it to public roles to hide the failure.
5. Replace **all** payment-serving instances with the guarded release while
   ingress is still closed to new checkout. Confirm no old instance can serve
   payment traffic. After migration, the insert trigger rejects an old binary's
   new claim without a reference; the update guard rejects its unsafe timeout
   reclamation and terminal retry. These are defense in depth, not permission
   for a mixed-version rolling rollout or a substitute for step 2.
6. Check readiness/status behavior using approved synthetic/staging accounts
   before reopening ingress. Verify pending/paid/no-payment/setup-required/error
   states and disabled Pay controls in both clients. A live provider checkout,
   payment, refund, cancellation, migration or configuration change needs its
   own explicit authorization. Local mocks/PGlite cannot prove live behavior.
7. Only reopen creation after the schema, grants, instance inventory and
   readiness result agree. If rollback is needed, keep creation closed and the
   durable ledger/guards intact. Never roll back to unfenced payment code while
   accepting traffic, remove receipts, or weaken guards to make retries work.

The boolean probe verifies required columns, RLS and enabled named guards. It is
not a full database integrity attestation and does not detect an administrator
rewriting a trigger function's body after rollout. Privileged DDL must remain
controlled and reviewed. Its response does not prove provider availability.
