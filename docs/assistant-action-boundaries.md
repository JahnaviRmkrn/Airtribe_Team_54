# Assistant action boundaries and recovery

The organizer's assistant operates the same authenticated local APIs as the
manual UI. Explicit local creation/editing tools remain intentional features:
asking to add a person, log a check-in, create a meetup or update goals can still
perform that action. This change does not add Google tools or automatic sending.

## Human review remains human

- Deletion/sign-out still require both `confirmed: true` and a real browser
  confirmation dialog. Onboarding Confirm cannot be clicked by the assistant.
- Generic DOM clicks use a reviewed allowlist of local navigation/edit controls,
  read-only operations and compose/preview/cancel controls. Communication
  handoff links remain manual; recipient-resolved email tools remain available. Unknown
  controls require manual activation. Ambiguous labels/names fail instead of
  selecting the first match; permission/confirmation inputs cannot be filled.
- Google Contacts connect/import and Gmail/Calendar connect/confirm handlers
  additionally require a browser-generated trusted click. Native button keyboard
  activation remains supported; `element.click()`/synthetic clicks do not count.
  Saved preview IDs/digests and sender acknowledgment rules remain unchanged.
- A mail-app draft does not send mail or silently save a supplied recipient
  address. Contact and meetup targets come only from the signed-in API results;
  ambiguous partial names/titles require clarification.
- Sheets import/export is a separate authenticated React document at
  `/integrations/google-sheets`, reached with a normal non-hash anchor. The
  organizer assistant scripts are not included by that page or the app layout.
  Its consent/import/export controls are not in the assistant's DOM. This is a
  source-verified document boundary, not a live Sheets/Google test.

Trusted clicks are a UI guard against these model tools, not authentication or a
replacement for server authorization. A client able to execute arbitrary JS or
call APIs directly is outside this guard's scope.

## Interrupted and repeated operations

- Each asynchronous assistant operation captures its page/hash context and
  cancellation signal. Navigation, cancellation and a superseding text request
  prevent later steps and stale renders. A request already sent cannot be undone.
- Text turns retain the first result for repeated identical non-read-only tools.
  A network/receipt/5xx failure on a mutation returns an explicit unknown outcome
  and stops that turn's tool progression, rather than asking the model to retry.
- Gemini Live serializes tool work and caches tool-call IDs within the connection.
  Conflicting replays with a changed name or arguments are rejected, not
  relabelled with an earlier result. Tool cancellation/stop aborts the tool
  context and drops queued/late work. An
  uncertain result blocks further tool execution for that connection.
- Voice planning makes one create attempt per spoken plan. Duplicate calls share
  that result; an unknown result stays blocked in the mounted planner and asks
  the organizer to check Meetups. Leaving the page drops late UI updates. Voice
  startup cancellation/failure releases acquired microphone/audio resources.

These are bounded browser/session protections, **not durable mutation
idempotency**. Reloading or starting another user request is not reconciliation.
Check current data before a deliberate retry of an unknown outcome. Voice plan
creation still follows its documented spoken read-back/yes workflow; it is not a
new provider-send permission or a substitute for Google manual confirmation.

## Provider and data boundaries

Malformed/empty assistant replies, invalid/truncated tool arguments and repeated
provider tool IDs return an explicit model error rather than a successful empty
reply or an executable empty-argument substitute. Manual page controls remain
available. The draft-message route stays read-only: missing/foreign contact
lookups and failed history reads do not reach the provider. When draft providers
are absent or fail, the existing editable template is labelled `template`, and
its basis lists only the facts that template actually uses.

## Verification and remaining limits

Regression tests execute the shipped browser assets in synthetic DOM/WebSocket/
microphone fixtures. Server routes use pre-import auth/secret/provider mocks;
provider tests use synthetic keys and intercepted fetch. No live LLM, microphone,
Google account, Vault, database, payment or external communication was used.
These tests are not a real-browser accessibility or live-provider certification.

Assistant requests and voice-plan creates also freeze the displayed account at
turn/session startup. They send the existing `X-Contact-Owner` header on API reads,
writes and voice-token requests. `requireUser` rejects a different current session
before data/provider work; missing or changed displayed identities fail locally.
Headerless legacy clients retain their existing behavior. This guard does not
change RLS or authentication and is not general account-switch notification;
requests already authorized and sent still cannot be undone.
