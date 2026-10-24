# Linux reconciliation, 2026-10-24

The merge joins the tested `a20916fe601256a23f150b4d4660a6fd68e8cedd`
checkpoint and the pinned teammate `6489c35c1ad9818c11ba40c53c0d977703b4037b`
checkpoint. Both histories are retained; this is not a force push or history rewrite.

## Preserved behavior and merge decisions

- Preserve the newer landing/login design, dashboard graph and calendar, analytics privacy filters, extraction evaluation, voice assistant, and guest checkout controls.
- Keep explicit password signup, retryable failures, confirmation-required signup handling, recovery-session checks, and same-origin redirect filtering. Signup analytics count only a fresh explicit signup and contain no user data.
- Keep compare-and-swap payment creation fencing and guest-specific reads. Retain the stricter newer rule: an existing pending checkout with a changed venue price returns 409 and is not replaced. Cancellation remains for an unclaimed stale checkout only.
- Use one navigation generation for direct refreshes, routing, guide/onboarding screens, and asynchronous writes. A stale result cannot overwrite a newer page. Keep escaped meetup content, independent follow-up forms, and goals-first onboarding retries.
- Fix the calendar's event-state assignment, previously unreachable after `return`, and tolerate non-string names in the people-card sort.
- Keep builds independent of Google Fonts downloads. Next-rendered pages use DM Sans/Newsreader when available locally, otherwise Arial/Georgia system fallbacks. The typography can differ from the designer's web fonts; no branded assets, layouts, or metadata were removed.

## Safety and verification scope

The local environment file is absent from the resulting tree and worktree.
No environment-file contents were inspected or used. The prebuild tracked-environment
check is retained. Removing a file from the tip does not remove earlier copies:
exposed service credentials still require owner-led rotation and a separate history
remediation decision. Do not export this merged Git history as a recovery bundle.

Validation uses only synthetic/mocked providers and in-memory PostgreSQL. Production
HTTP checks use loopback plus non-secret placeholder Supabase public configuration.
No live-service smoke script, real payment, deployed database, or real authentication
flow was exercised. Publishing and deployed CI are separate from these local checks.

Local validation passed: 192 tests across 20 files, ESLint with no warnings,
TypeScript typecheck, production Turbopack build, tracked-environment guard,
staged whitespace/conflict checks, and 16 production HTTP checks. These checks
are not evidence of a deployed end-to-end signup, live provider integration,
or remote CI pass.
