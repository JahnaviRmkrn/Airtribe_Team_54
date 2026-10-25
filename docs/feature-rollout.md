# Feature rollout: code is not live configuration

This checklist is for an authorized operator. It is not a migration runner and
does not authorize infrastructure, account, credential or provider changes.
Local tests use synthetic fixtures; a green deployment does not prove the
production database schema, OAuth grants, mail delivery or payment behavior.

## Establish the target and trust boundary

1. Confirm the canonical application HTTPS origin, hosting project, Supabase
   project and Google Cloud project. Do not infer that similarly named projects
   are the same deployment.
2. Resolve previously exposed service-role, database and provider credentials
   through the owner's approved revocation/rotation process. Do not reuse them,
   paste them into chat, or assume moving them into Vault removes the exposure.
3. Review the target's applied migration versions and current deployment version
   without exporting secret values. Review pending SQL individually, including
   grants, RLS, triggers and data-retention consequences. Back up using the
   operator's approved recovery process before schema changes.
4. Agree on the exact migration and configuration changes before applying them.
   The repository contains optional features; blindly running every historical
   migration or seed is not a safe substitute for a rollout plan.

## Feature-specific release conditions

| Feature | Required operator checks | Behavior before readiness |
| --- | --- | --- |
| Existing login/manual contacts/rooms | Existing Supabase Auth, URL configuration and base schema. Preserve existing users and records. | Must not depend on optional Google setup. |
| Google Contacts / Sheets | Reviewed connector/import and session-replacement migrations, purpose readiness, exact redirect origin, approved scopes, server-only credentials/encryption key and cleanup. See [Contacts](google-contacts-setup.md) and [Sheets](google-sheets-setup.md). | Setup-disabled; no account connection or provider access just because code is deployed. |
| Gmail / Calendar | All shared connector requirements plus immutable-action receipts, purpose readiness and the separately enabled feature flag. See [action setup](google-actions-setup.md). | Disabled by default; previews and explicit confirmation are still required after setup. |
| Protected payment creation | Payment-attempt receipts and enabled database guards, followed by verified readiness. Follow the [payment safety checklist](payment-safety-rollout.md). Stop/drain old instances; old in-flight provider requests cannot be made safe retroactively. | Checkout unavailable until setup is verified. Existing known payment status is read-only; no unsafe fallback to repeated order creation. |
| Manual-contact retry receipts | Follow the [contact retry rollout](contact-create-retries.md): apply the reviewed compact receipt schema, drain key-ignoring APIs, then explicitly enable `CONTACT_CREATE_RETRY_ENABLED=true`. | Off by default; existing contact entry stays usable without the migration. Unkeyed saves do not acquire a false retry-safety guarantee. Never fall back from an uncertain keyed request to a fresh unkeyed insert. |

Follow each feature's current setup document for exact migration names and
settings. Preserve durable uncertainty/claim tombstones across code rollback;
rolling back code is not permission to delete receipts or resend actions.

## Verify after approved rollout

- Verify readiness with the intended least-privilege roles. A denied or failed
  probe is not evidence of readiness, and should not expose schema internals to
  ordinary users.
- Test first with approved synthetic accounts, recipients and destinations.
  Sending an email, inviting attendees, creating a live spreadsheet or making a
  payment is a real side effect even when described as a test.
- Confirm logs do not capture credentials, OAuth callback queries, cookies,
  private contact notes, message/event content or encrypted payloads.
- Check cleanup scheduling and retention. Expiry rejection is not proof that
  encrypted expired content has been physically removed.
- Record the tested commit, applied migration versions, operator verification
  and remaining limits. Do not call a feature live-ready solely from unit tests,
  PGlite, a mocked browser, or a successful automated deployment.
