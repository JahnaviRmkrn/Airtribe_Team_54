# AgenticOrg extraction integration

## Created instance

- Platform: https://agenticorg.hackathon.pinelabs.com
- Tenant: AirTribe; signed-in role: Developer / Backoffice.
- Agent: Team 54 Onboarding Extractor
- ID: `45b5b4c7-dfbc-451a-a86a-ff2b9911e5ea`
- Type: `team54_onboarding_extractor`; domain: backoffice.
- Status: shadow; selected model: openai / gpt-5.6-luna; routing disabled.
- No authorized tools, no schedule. Confidence floor 88%; human review condition `confidence < 0.88`.

The prompt extracts up to five user-mentioned people, Indian names/Hinglish, category, explicit cadence, corrections and raw goal weights. It rejects transcript instructions, returns a draft only, and asks for an honest confidence estimate. The application normalizes weights and still requires explicit user confirmation before saving.

## Evidence and limitation (24 October 2026)

Two synthetic UI runs were submitted. The first returned `hitl_triggered` with 0.73 confidence and created a pending human-review item. The second, after adding truthful per-result confidence to the prompt, displayed `completed`, confidence 100%, and **No output returned**. Neither result proves usable extraction. The dashboard's 86.5% shadow accuracy is not our fixture evaluation score. The agent has not been promoted and the pending item has not been approved.

The repository adapter is implemented and mock-contract tested. A live authenticated API response is still required: the Developer UI does not expose deployment API-key creation. An administrator must provision a key for this agent. Do not reuse or export the browser session token.

## Enable only after verification

Set these server-only variables together in ignored `.env.local` and Vercel:

```
AGENTICORG_API_KEY=<administrator-provided deployment key>
AGENTICORG_AGENT_ID=45b5b4c7-dfbc-451a-a86a-ff2b9911e5ea
AGENTICORG_BASE_URL=https://agenticorg.hackathon.pinelabs.com
```

Both key and ID are currently unset locally, preserving the verified DeepSeek path. With both set, `/api/extract` calls AgenticOrg first. A completed response must contain structured contacts/goals and confidence at least 0.88. Timeout, invalid output, and review-pending statuses fail explicitly; they never silently switch providers. The existing endpoint remains authenticated and returns an unsaved draft.

After the key arrives, run the ten fixtures with `EXPECT_SOURCE=agenticorg`, inspect per-case output and record the real result. Investigate the dashboard's empty-output behavior before promotion or a platform-backed demo claim. Also verify the agent's deployed response contract against the documented SDK; hosted versions may differ.

References: [official API/SDK documentation](https://agenticorg.ai/docs/api-sdk-mcp), [official TypeScript SDK](https://github.com/mishrasanjeev/agentic-org/blob/main/sdk-ts/src/index.ts). Adapter uses `POST /api/v1/agents/{id}/run`, Bearer authentication, and `{action, inputs: {transcript}, context}`.

AgenticOrg, Amazon AgentCore, and Pine Labs payment APIs are separate integrations. AgentCore remains excluded from today's pitch; payment execution remains unverified. AgenticOrg may be described as a configured shadow experiment until the live contract and extraction tests pass.
