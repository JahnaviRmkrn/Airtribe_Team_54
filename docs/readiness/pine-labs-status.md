# Pine Labs status

The existing merged payment integration uses `@plural_pinelabs/agent-toolkit` directly on the server: createOrder, getOrder and cancellation support. It is not an LLM-directed agent. The owner confirmed only mocked tests/tool-schema validation, no real UAT order receipt, and no configured PINE_CLIENT_ID/PINE_CLIENT_SECRET. The two room implementations also have no payment CTA yet.

Do not describe checkout as live or successful. The official toolkit requires a Pine Labs Online merchant account and dashboard-issued client ID/secret: https://www.pinelabs.com/docs/online-payments/ai/agent-enablement-toolkit.

The separate hackathon AgenticOrg platform at https://agenticorg.hackathon.pinelabs.com supports configurable agents and workflows. Prior registration there is not evidence of available payment credentials or a running Team 54 agent. The user's “pine labs agents” clarification is pending to choose between completing toolkit-backed checkout and using the agent platform. No real payment was initiated.
