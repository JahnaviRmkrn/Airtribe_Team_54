# Extraction evaluation, 24 October 2026

Ten hand-authored synthetic transcripts were sent through the real authenticated HTTP `/api/extract` endpoint on local port 3054. Temporary Supabase evaluation accounts were deleted after each run. The endpoint was not mocked. These are regression fixtures, not a representative accuracy benchmark or a speech-recognition evaluation.

| Run | Fully correct cases | Actual source | Evidence |
|---|---:|---|---|
| Initial port | 1/10 | rules (provider 429) | `reports/extraction-baseline.json` |
| Improved parser | 10/10 | rules | `reports/extraction-fallback-improved.json` |
| Configured DeepSeek model | 10/10 | openai (OpenAI-compatible adapter) | `reports/extraction-deepseek.json` |

Checks require expected names, exact category and frequency, no invented assistant/example people, expected contact count/cap, normalized integer goals, and `saved:false`. Model evaluation also requires `EXPECT_SOURCE=openai`, so an unnoticed fallback fails the run. `source:openai` is the adapter label; the configured provider was DeepSeek at `https://api.deepseek.com`, model `deepseek-chat`.

Cases cover fillers, Indian names, seven contacts, corrections, Hinglish, assistant decoys, no contacts, unknown cadence, duplicate mentions, instruction injection and multiline user utterances. The parser changes were developed against these cases, so report them as regression coverage rather than held-out generalization.

Reproduce with the app running and an authorized test user's access token:

```sh
BASE_URL=http://localhost:3054 EXPECT_SOURCE=openai EXTRACT_ACCESS_TOKEN=... node scripts/evaluate-extraction.mjs
```

Alternatively set `EXTRACT_TEST_EMAIL`, `EXTRACT_TEST_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY`; the runner signs in to an existing test account. It never accepts the service-role key as an access token. Do not paste credentials into tracked scripts or reports. The default report path is `reports/extraction-latest.json`; use `EXTRACT_REPORT` to preserve separate runs.

Remaining limitations: rules recognize a bounded set of phrases and capitalized names; they do not provide general multilingual understanding or shared-interest extraction. Review the editable draft. Model latency and quality can vary, and the runtime returns rules after timeout. Test real phone audio, interrupted speech and a fresh set of transcripts before claiming the voice experience is validated.
