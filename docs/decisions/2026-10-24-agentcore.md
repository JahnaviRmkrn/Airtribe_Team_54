# Decision: omit AgentCore from today's demonstrated architecture

Status: NO for today's pitch; revisit after a verified end-to-end run.

The existing extraction endpoint is the sensible future integration point. However, the AgentCore owner reported `InvalidClientTokenId` on the configured AWS credentials on 24 October 2026 and is waiting for working credentials. There is no verified runtime invocation receipt. The demo does not depend on this unfinished integration.

Today's demonstrated path: browser → authenticated `/api/extract` → configured model provider → schema validation/normalization → editable confirmation screen. A rule-based parser remains a labelled fallback. ElevenLabs supplies conversational voice; this is separate from extraction hosting.

Pitch wording: “Voice onboarding produces editable contact and goal suggestions. You review them before saving.” Do not claim AgentCore is running, deployed, evaluating, or securing this flow. Keep AgentCore out of architecture slides and sponsor-credit claims for the live implementation.

Reversal gate owned by the AgentCore session: valid AWS identity; deployed runtime; invocation from `/api/extract`; the same ten extraction fixtures passing with an explicit AgentCore source; timeout/error fallback test; logs with secrets/transcripts excluded; production credentials configured. Record the runtime ARN, region and commit as evidence without publishing credentials.
