# Review of port PR #8

Reviewed merged port commit `75e38a7` and original Python PR #3. PR: https://github.com/JahnaviRmkrn/Airtribe_Team_54/pull/8. This is a technical review, not C's personal product sign-off.

## Preserved and intentional changes

- Extraction remains stateless until the editable confirmation screen saves. Names, category and cadence map to Person A's schemas. Goals sum to 100 and contacts cap at five.
- Room mutations use A's `/api/rooms/:token/*`. Voting upserts on `(meetup_id, attendee_id)`, so voting again moves the single vote; DELETE withdraws it.
- Closure has no reopen UI/API. Organizer authority comes from the signed-in Supabase session, not a query-string key.
- Original guest-suggested venues, approval-style multiple votes, custom categories and reopen behavior were deliberately dropped in #8. C must explicitly accept those omissions; it would be wrong to say nothing was lost.

## Findings and ownership

1. **P1 — late voice startup after leaving.** `public/organizer/voice.js` awaits the signed URL, SDK and session but the leave handler only ends an already-existing session. A pending start can activate the microphone after navigation. Confirmed by code inspection; matches the existing Greptile finding. The port owner acknowledged ownership of the fix.
2. **P1 — late extraction can change unseen contacts.** Pending extraction calls `applyExtraction` after the people screen has been removed; it mutates rows then attempts to render absent controls. The port owner owns cancellation/disposal fixes. Rehearsal must cover Next/Skip during an in-flight extraction.
3. **P2 — zero budget lost in static room form.** `Number(p.budget_min/max) || ''` drops zero and a subsequent preference save removes the free-only restriction. Port owner owns the fix.
4. **P1 deployment gate — rate-limit RPC absent.** During this session's HTTP evaluation, Supabase returned PGRST202 for `public.hit_rate_limit`. The helper fails open, so the current environment does not enforce the declared paid-provider limits. Apply and verify all migrations before public rollout; this is an observed environment issue, not proof the migration source is absent.
5. **Extraction quality fixed in readiness branch.** Baseline fallback passed 1/10 realistic HTTP cases. Fixes to filler words, corrections, frequencies, Hinglish relation phrases and multiline speaker parsing brought the same suite to 10/10. Separate model-provider results are recorded in reports; a text suite does not validate microphone/speech recognition.

There is both a React room at `app/m/[token]` and a static room rewrite. Verify which implementation the deployment serves and exercise its join/vote/close flow; do not infer visible behavior solely from the static files. Analytics hooks cover both implementations.

## C's acceptance checklist

- Approve the explicit dropped behaviors above.
- Speak the demo transcript on a phone and verify Indian names, categories and cadence.
- Verify edited fields survive Confirm, and leaving during voice/extraction does not mutate the draft.
- Join as two distinct guests, move/withdraw a vote, confirm, close, and verify no reopening.
- Confirm zero budgets survive an edit and no private notes or organizer secret appear to guests.

C's acceptance and the port owner's UI-fix regression evidence remain required; neither is fabricated by this report.
