# ElevenLabs configuration handoff

Agent ID: `agent_3701m5ptkyx6evcs7eggbaghm3n3`.

Created and read back through ElevenLabs on 24 October 2026. Verified `platform_settings.auth.enable_auth = true` and successful short-lived signed-URL issuance. The prompt asks for people → category → check-in frequency, handles name corrections and more than five people, then asks for goal weights. Unknown frequency is allowed; nothing is promised saved.

The existing account key and this ID are saved in the original repo's ignored `.env.local` and the isolated readiness worktree's ignored `.env.local`, with owner-only file permissions. The secret is intentionally absent from Git, reports, recruitment messages and this document.

Vercel setup: copy `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` from that local file into the intended project's server-side environment settings for the deployment environment, then redeploy. Do not use `NEXT_PUBLIC_` names. No Vercel project/login was available in this session, so cloud env installation is not claimed.

To update this same agent: load both environment variables and run `python3 scripts/setup_elevenlabs_agent.py`. With an ID set it uses PATCH; without an ID it creates a new agent. `--dry-run` prints configuration without using credentials. Do not repeatedly create duplicates.

Verify the deployed `/api/voice/signed-url` returns 401 without sign-in and a signed URL when signed in. Keep the signed URL out of screenshots/logs. Complete a real phone conversation; creating an agent and minting a URL are not an end-to-end audio test.

For extraction, the current team configuration uses `OPENAI_BASE_URL=https://api.deepseek.com`, `EXTRACT_MODEL=deepseek-chat`, and a provider key in `OPENAI_API_KEY`. An inherited shell OPENAI_API_KEY overrides `.env.local`: start with `env -u OPENAI_API_KEY pnpm dev` when loading the team file. Keep these extraction settings server-side too.
