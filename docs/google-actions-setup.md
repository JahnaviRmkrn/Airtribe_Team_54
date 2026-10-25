# Gmail sending and Google Calendar creation

## Status and authorization boundary

This is an **opt-in, disabled-by-default implementation**, not a connected or live service. No Google project, credentials, grant, API enablement, migration application, email send, invitation, event creation or deployment was performed as part of implementation. Tests use synthetic tokens and in-memory PostgreSQL only.

The organizer exposes `/organizer/#/gmail` and `/organizer/#/calendar`. Without separately approved operator configuration, each shows a friendly setup message and does not offer a live connection. Setup is separate from Supabase Google login, Contacts and Sheets. User confirmation of a draft does not authorize changing OAuth scopes or configuring accounts.

## Deliberate scope choices

- Gmail: `https://www.googleapis.com/auth/gmail.send` only. No inbox, message read, modify, labels, contacts, profile or send-as-settings permission. Only plain-text messages with explicitly entered To addresses are supported. No CC/BCC, attachments, HTML, send-as aliases, automatic signatures, private-note insertion, scheduled sending or background sending.
- Calendar: `https://www.googleapis.com/auth/calendar.events.owned` only. This Google scope can view/create/change/delete events on calendars the account owns; the UI discloses that capability. Application code only inserts the specifically previewed event in `primary`, or reads that exact event ID after an unknown result. No CalendarList, broad calendar management, Drive or mail-read scope is requested.
- `calendar.app.created` was considered but not selected: it would require creating a separate app calendar instead of using the existing primary calendar. Adding that feature requires a separate scope/destination design and approval.

The linked Google account is the account selected in the separate consent flow, **not necessarily the app's sign-in email**. Send-only scope cannot read a verified Gmail profile address. The user must therefore enter the selected account's primary Gmail mailbox address; the UI labels it user-entered, not independently verified. The immutable preview shows that exact normalized From address. A separate acknowledgment confirms it is the primary mailbox selected at Google, not an alias. The same address is both the MIME From header and the encoded `users/{address}/messages/send` authorization target. There is no fallback to `me`, no sender substitution and no assertion that this app verified primary identity. Google must authorize the requested mailbox; an explicit rejection is terminal for that action. Reconnecting requires a fresh preview. Calendar still describes its destination as the selected account's primary calendar.

## Operator setup, only after separate approval

1. Review and apply the connector migration `20261025110000_google_contact_import.sql`, then `20261025113000_google_confirmed_actions.sql` and `20261025114000_google_session_replacement.sql`, to the intended database. The shared readiness probe keeps these features disabled until the replacement guard is installed. Never apply against an unknown project. The normal anonymous/authenticated roles cannot read connector tokens or action records, nor invoke privileged claim functions.
2. Register dedicated OAuth client configuration for each purpose. Review Google's current consent-screen, Gmail API / Calendar API enablement and verification requirements. Configure exact redirect URIs:
   - `https://YOUR-APP/api/me/integrations/google/gmail/callback`
   - `https://YOUR-APP/api/me/integrations/google/calendar/callback`
3. Configure server-only `GOOGLE_CONNECTOR_ORIGIN` (the trusted exact HTTPS origin), `GOOGLE_CONNECTOR_ENCRYPTION_KEY` (32 random bytes, base64 encoded), `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET`, `GOOGLE_CALENDAR_CLIENT_ID`, and `GOOGLE_CALENDAR_CLIENT_SECRET`. Never use `NEXT_PUBLIC_` variables for these. The key is shared with the existing connector foundation; key rotation must preserve decryption of the current seven-day previews or intentionally retire them while preserving tombstones.
4. Only after the approved setup and release checks, set `GOOGLE_GMAIL_ENABLED=true` and/or `GOOGLE_CALENDAR_ENABLED=true`. Missing flags remain disabled, even if credentials happen to exist. Enable independently.
5. Schedule the existing `cleanup_google_connector_sessions()` and the new `cleanup_google_confirmed_actions()` using an approved server-side scheduler. This implementation does not install a scheduler or invoke cleanup against a live database. Run cleanup at least every 15 minutes. It only removes expired tokens/content, never sends mail or creates events.
6. Remove OAuth callback query strings from access logs and tracing at the hosting layer. Authorization codes necessarily arrive at the registered callback; the app consumes them server-side and redirects to a clean URL. Never capture request Authorization headers, cookies, OAuth codes, token responses, message bodies, event descriptions or encrypted payloads in logs/analytics.

Tokens are encrypted with AES-256-GCM on the server and bound by authenticated additional data to the owner, purpose and session. State and S256 PKCE bind the callback to the connection. A verified authorization is consumed before exchanging the code. Access tokens expire at most 15 minutes after issuance; no refresh token is retained. Tokens never enter browser JavaScript, browser storage, API JSON, application logs or application-generated URLs. The connection cookie is HttpOnly, SameSite=Lax and Secure on HTTPS, scoped to one purpose. Removing the app's temporary connection does not revoke the account's upstream Google grant; users manage that in their Google account.

## Preview and one-time action contract

POST `/api/me/integrations/google/{gmail|calendar}` accepts one strict operation:

- `start`: user-initiated temporary OAuth connection.
- `preview`: validates the draft and stores an encrypted, immutable owner/purpose/session-bound version and SHA-256 digest. No provider write occurs.
- `confirm`: accepts only `id`, `previewHash`, `confirmed: true`, plus mandatory Gmail `senderAcknowledged: true`. It never accepts replacement recipients or event details. The server atomically claims this exact preview before making a single provider request.
- `cancel`: cancels an unclaimed preview. Cancellation cannot undo a claimed/in-flight/completed action.
- `reconcile`: Calendar only, a read-only GET of the one deterministic event ID. No second insert.
- `disconnect`: removes only this temporary connector session; durable action records remain.

GET returns connection state and the owner's latest 10 saved actions. `?id=UUID` retrieves that owner's exact saved action status even after the OAuth session expires. Preview validity is at most 10 minutes and never exceeds the original session expiry. Changes create a new preview and cancel older unclaimed previews. Another Google connection cannot submit an older preview.

The PostgreSQL one-time claim has **no reclaim timeout**. Once claimed, it cannot return to preview and cannot be claimed again, even after process crashes, lost HTTP responses, session cleanup or reconnect. A duplicate preview request returns its existing preview/action. Identical unknown content remains blocked after reconnect. A new, deliberately different draft still requires its own review and confirmation.

## Provider outcomes and uncertainty

- Gmail calls `users.messages.send` with the exact previewed primary mailbox address as `userId` and base64url-encoded UTF-8 MIME. Required From and Date headers are included; Date is the immutable action creation timestamp shown in preview, not later browser input. Unicode subject words and message bodies are MIME-encoded, recipient/header injection is rejected, addresses are normalized and shown exactly in preview. IDN domains become ASCII; SMTPUTF8 local parts and display-name address syntax are rejected explicitly.
- Calendar uses a UUID-derived lowercase legal base32hex event ID. The event stores private action/digest markers; GET reconciliation requires an exact match. Start and end are absolute RFC3339 instants with the previewed IANA time zone. DST gaps are rejected; overlapping times require an explicit earlier/later choice. Duration is elapsed minutes, so a DST transition may produce an unusual local end time that is shown in preview. End is always later than start. Plain-text descriptions are escaped for Calendar’s HTML-capable description field so markup cannot change the previewed meaning.
- Guest notifications are explicitly previewed as `all` or `none`. Google warns some emails may still be sent with `none`, and external calendar sync may be impaired. Attendees can see the event details and attendee list. No default reminders, recurrence, Meet links or attachments are added.
- There are **zero automatic provider-write retries**. Transport errors, timeouts, malformed successes, 5xx responses and conflicts are marked uncertain. A failed outcome-storage write leaves the durable claim intact. The UI offers status checking, not resend/recreate.
- Gmail cannot reconcile an unknown send with send-only scope. The user must inspect the selected account's Sent mailbox themselves. A Message-ID would not guarantee send idempotency; none is used as a retry excuse.
- Calendar reconciliation is GET-only. A missing event, account mismatch, unmatched marker, cancellation or another failed read stays uncertain and never authorizes another insert. The provider's distributed ID collision behavior is not a guarantee of exactly-once delivery; the local one-time claim is the primary replay protection.
- Gmail success means Google accepted the message, not confirmed delivery. Calendar success means creation was acknowledged, not that guests accepted or received email.

Encrypted message/event previews are removed after seven days by the approved cleanup job. Compact owner/action/digest/outcome tombstones are retained until account deletion to prevent replay; they contain no token or plaintext message/event content. Temporary session cleanup never cascades into this durable history.

## Verification and remaining release checks

Mock/unit tests cover MIME and Unicode, bad addresses/header injection, exact content hashes, DST gaps/overlaps (including half-hour shifts), provider status/timeout handling, no automatic retries, account/session swapping, explicit confirmation, callback-state replay and read-only reconciliation. PGlite tests exercise role privileges, immutability, concurrent claims, edit/cancel races, lost-session replay protection and cleanup.

Before live rollout, an explicitly authorized operator must verify the intended Google project, consent/verification status, migration grants, clean callback logs, token cleanup, Gmail raw-message acceptance/exact sender and wrong-mailbox rejection, Calendar primary ownership, notifications, and one controlled end-to-end action in dedicated test accounts with approved recipients. Neither mock tests nor local UI QA prove live OAuth, mail delivery or Calendar notifications work.

## Official references

- [Gmail send method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Gmail profile method and its scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Gmail send-as identity requirements](https://developers.google.com/workspace/gmail/api/guides/alias_and_signature_settings)
- [Gmail MIME sending guide](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Calendar event insert, event IDs and notifications](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Calendar event get and accepted scopes](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)
