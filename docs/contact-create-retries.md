# Manual contact creation: retry contract

## Scope and rollout

`POST /api/me/contacts` accepts a single contact or an onboarding batch of 1–5.
Retry-safe creation is **disabled by default**. Only the exact server setting
`CONTACT_CREATE_RETRY_ENABLED=true` opts in; missing, false, or other values do
not. This is not a `NEXT_PUBLIC_` setting and cannot be enabled by the browser.

Authenticated `GET /api/me` returns `capabilities.contact_create_retry`. With the
flag off it returns false without making any retry RPC call. With the flag on it
advertises true only after the read-only `contact_create_retry_ready()` probe
returns true (with a 1.5-second probe deadline). Missing schema, denied access, timeouts, and unexpected responses
leave the capability false without breaking profile loading. The probe checks
the authenticated identity and required function/table permissions; it creates
no contacts or receipts. Capability responses are private and not cached.
The probe proves the current database capability, not the version of every API
instance serving the deployment.

The organizer sends a random UUID `Idempotency-Key` only when the capability is
true. Both modes send `X-Contact-Owner` from authenticated `GET /api/me`, including
on the goals PUT before onboarding contacts. With no capability, new Add and
onboarding submissions use the existing unkeyed insert behavior, and the UI does
not claim retry safety. A lost or otherwise uncertain unkeyed response is marked
pending: repeat submission is blocked, including after refresh or later feature
enablement. The user must check Contacts, then explicitly abandon the uncertain
save before deliberately starting a new add. No request is automatically retried.

A pending keyed save is never downgraded to an unkeyed request. If the capability
is unavailable after refresh, the browser retains the original key and blocks
its submission until safe retries are available. While the key-aware API remains
in place, a stale tab's keyed request receives 503 if the flag is off or the
RPC/schema is missing. That API never falls back to an unprotected insert, and
the client retains its key after 503. An old API that ignores the header provides
none of these protections; the flag cannot make such a binary safe.

### Operator rollout (requires separate approval)

1. Ship the reviewed code with the flag absent or false. Legacy manual contact
   creation remains available even if the new migration has not been applied.
   Shipping code does not authorize a live schema or configuration change.
2. Obtain approval for the reviewed database migration, then have an authorized
   operator apply `20261025121000_contact_create_intents.sql` through the normal
   migration process. The unpublished contact migration was renumbered from
   `20261025120000` to avoid the already-published payment migration at that version.
   Do not rename or reapply the published payment migration.
3. Verify the migration and its authenticated read-only readiness probe in the
   intended environment. The probe should return true without changing contacts
   or receipts. No test, application startup, or build applies migrations to a
   live database; only the isolated PGlite test database is migrated automatically.
4. Before enabling retry safety, finish the API rollout and drain **every old
   API instance that ignores `Idempotency-Key`**. Confirm all contact POST traffic
   reaches the reviewed keyed implementation, including traffic served during
   rolling updates, across regions, and by older deployment URLs. A new UI could
   otherwise obtain an enabled capability from a new instance but submit to an
   old POST handler that ignores the key and creates without a receipt. The
   readiness probe and flag alone cannot prevent this mixed-binary failure.
   Before retry safety has ever been enabled, keeping the flag off during the
   initial old/new mixture is the compatibility baseline, **not a retry-safety
   guarantee**. After enablement, follow the stricter rollback rule below. Older browser clients that omit
   keys also remain outside the retry-safe contract after enablement.
5. Only after explicit approval for the environment configuration change, set
   `CONTACT_CREATE_RETRY_ENABLED=true` in that server environment. Confirm the
   authenticated `/api/me` capability is true, then refresh the organizer. Verify
   approved test saves and replay checks using disposable data, not real contacts
   without permission. No secrets are needed in this document.
6. After retry safety has been enabled, **never route retained or cached keyed
   requests to an old API that ignores `Idempotency-Key`**. Turning the flag off
   is **not a safe API-binary rollback**: existing tabs may still send their
   original keys, and an old handler would insert again without consulting the
   receipt. Keep the key-aware API deployed. With its flag off, it rejects keyed
   saves with 503 rather than inserting, while newly loaded clients use the
   honestly labeled legacy flow for new actions. A UI-only rollback may be
   considered while retaining that API protection; it does not stop existing
   or cached tabs from sending keyed requests.

   If legacy API handlers must be restored, a separately approved ingress guard
   must first be installed and verified to reject **all contact POST requests
   carrying `Idempotency-Key` before they reach any legacy handler**, including
   alternate deployment routes. Never strip the header or retry rejected traffic
   unkeyed. No such guard is implemented or authorized by this change. Without
   this verified protection, do not roll the key-aware API back.

   In either case, keep the migration and compact receipts intact. Preserve
   pending keys and unknown outcomes; users must check Contacts rather than
   recreate an uncertain save. Do not delete or expire receipts during rollback,
   and resume keyed retries only through the reviewed key-aware API.

This change only authors code and a migration. Its tests use in-memory PGlite and
explicitly skip Vault. No deployed database, environment setting, provider
connection, auth grant, or notification is changed by this work.

## Server guarantees

- The owner comes from `auth.uid()` inside the transaction, not request JSON or
  a caller-supplied RPC owner. The expected-owner header used by the organizer is enforced on both the initial goals PUT and the contact POST. A tab whose account changed cannot mutate the new account, including when the goals response is delayed. Legacy callers may omit the header.
- The same owner + UUID + parsed contact array returns 201 with stable original `created_ids`, currently existing owned `contacts`, and `missing_ids` for deleted contacts. The response reflects current edits, not historical private snapshots. Object key order is irrelevant; batch order is significant. Zod trimming/defaults happen before hashing the JSONB representation with core PostgreSQL SHA-256 (no extension-schema dependency).
  Omitted nullable fields versus explicit null remain different requests.
- The same owner/key with different contact data returns 409. Nothing is updated
  or inserted. The same UUID used by another owner is a separate, isolated intent.
- The owner/key advisory transaction lock and composite primary key serialize
  concurrent matching retries. Contacts and receipt commit together; any invalid
  batch member rolls the entire transaction back.
- Distinct keys deliberately create distinct contacts, including identical names
  or emails, and two identical people within a batch stay distinct. There is no
  name/email deduplication here and existing contacts are never overwritten.
- Retries do not resurrect deleted contacts or undo later edits. A partial or fully deleted batch returns missing IDs rather than the deleted rows. The browser explicitly reports that nothing was recreated; no deleted name, email, or note is replayed.
- Receipt tables have RLS. Authenticated owners can read only their own receipts;
  direct receipt writes are denied. The RPC is authenticated-only, validates
  bodies again, and rejects ownership/unknown fields. No service key is used.
- Durable receipts contain only owner/key, a normalized request digest, created UUIDs, and creation time. They never retain the full contact body, email, notes, or result snapshot. Compact tombstones remain after contact deletion so retries cannot insert again. Account deletion cascades. Do not expire tombstones without a separate expired-key rejection contract.

## Browser behavior and honest limits

One unresolved intent per owner per surface (`add`, `onboarding`) is stored
before sending, in available local/session storage with an in-memory fallback.
It contains a local UUID, mode (keyed or legacy), attempt count and original contact body solely while recovery is pending, not credentials. A legacy marker is a resubmission guard, not a server retry receipt. Successful acknowledgment or explicit abandonment clears the private browser payload in both available stores. An unresolved recovery draft persists until resolved/abandoned or site data is cleared; only the compact server tombstone remains indefinitely.
Pending Add fields and onboarding people are restored after refresh. New
onboarding drafts are owner-tagged; legacy untagged extraction prefills remain
supported. Goals are still an idempotent PUT before contact creation.

For keyed saves, network failures, database errors, lost JSON responses, and navigation while a request is outstanding retain the key. For legacy saves these outcomes instead retain an explicitly non-retryable pending marker, never a reusable server key. The route explicitly labels its own pre-database body-validation failure `contact_input_rejected`. On a first attempt only, the browser can release that rejected key while keeping fields editable. Attempt counts are persisted before sending. Generic 400s and even labeled validation failures after any previous uncertainty cannot release the key, because they do not disprove an earlier commit. Repeated taps are blocked synchronously.
An old form also retains its own key if another tab acknowledges that intent.
The success screen uses the returned contact ID, never a same-name lookup.

Changing people/details while an outcome is unresolved is not silently treated
as a fresh create: retry the original details and then edit the saved contact.
After checking Contacts, the explicit “Start a new add” action can abandon the
retry with a warning that the first save may already exist. It clears the form
and the next submission gets a new key. A new Add after acknowledged success
also gets a new key, even if the details are identical.

If both browser stores are blocked, keyed same-page retries remain safe, and the form
and failure message explain that refresh recovery is unavailable. Clearing site
data, changing browsers/devices, losing session-only storage, or replacing an
unresolved intent explicitly cannot recover the old key. Check Contacts before
recreating. No automatic retry or background contact creation is performed.
The app does not deduplicate separate deliberate intents started simultaneously
in unrelated tabs/devices; only requests carrying the same owner/key are the
same intent. Receipt persistence is durable on the server, but it cannot infer
that a brand-new key was meant to retry an old action.

Google Contacts/Sheets imports retain their separate existing transactional
import deduplication and do not use these manual-create receipts.

## Verification

`tests/contact-create-routes.test.ts` first reproduced the prior failure: a
synthetic first response lost after commit followed by a retry created two rows
instead of one. The regression now covers replay, conflicts, validation, owner
change, default-off legacy Add/onboarding, strict flag parsing, authenticated read-only readiness checks, missing/failed readiness, noncached capabilities, and keyed migration-absent/flag-off fail-closed handling.

`tests/contact-create-ui.test.mjs` executes the shipped browser script with a
synthetic committed-response-loss transport: repeated loss, Add/onboarding
refresh, local-only/session-only/no storage, changed body, deliberate new action,
account isolation, late navigation, a second tab acknowledging a shared key, capability negotiation, unkeyed uncertainty blocking, explicit abandonment, and no keyed-to-legacy fallback during rollout or rollback.

`tests/contact-create-sql.test.mjs` runs PostgreSQL semantics in PGlite with real
RLS, owner checks, append-only receipts, batch rollback, validation, current-row
replay after edits and privacy-preserving tombstones after deletion, and submitted concurrent retries. PGlite serializes
query execution; this is not a live multi-connection PostgreSQL contention test.
The production concurrency mechanism is the transaction lock plus primary key.
