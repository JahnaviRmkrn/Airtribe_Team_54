# Supabase backend for this app (created 2026-10-24)

Status: LIVE. Hosted Supabase + Vercel production deploy are both running.

- Supabase project: airtribe-team-54 (org: JahnaviRmkrn's Org, Supabase Free plan)
- Project URL: https://mbqnrnlebzdflmizsbca.supabase.co
- Region: East US (Ohio) - dashboard default; for lowest latency from India, choose Mumbai/Singapore on future projects.
- Live app (Vercel): https://airtribe-team-54.vercel.app (project "airtribe-team-54" under Vercel team "JahnaviRmkrn's projects", Hobby plan, auto-deploys from main)

## Database state
- supabase/migrations/* applied through 20261024121000_rate_limits.sql (5 migrations) + supabase/seed.sql verified: 8 tables + rate_limits + meetup_payments, RLS on all, 15 sample venues.
- If new migrations land on main later, apply them to this project too (SQL Editor or `supabase db push`), or the deployed API will 503 on the missing objects (this happened for hit_rate_limit before the rate_limits migration was applied).

## Auth configuration (hosted project)
- Site URL: https://airtribe-team-54.vercel.app
- Redirect URLs: https://airtribe-team-54.vercel.app/auth/callback and https://*-jahnavi-rmkrn-s-projects.vercel.app/auth/callback (preview deploys)
- Email+password signup with instant session (Confirm email OFF per DEPLOY.md) and magic link both enabled.
- Social providers (Google/Facebook/LinkedIn/Instagram) need each provider's client ID/secret entered in Supabase before those buttons work - see docs/social-auth-setup.md.

## Env vars (set on Vercel production; keep out of git)
NEXT_PUBLIC_SUPABASE_URL=https://mbqnrnlebzdflmizsbca.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<dashboard: Project Settings > API Keys>
SUPABASE_SERVICE_ROLE_KEY=<same page - server only>
NEXT_PUBLIC_SITE_URL=https://airtribe-team-54.vercel.app
DEEPSEEK_API_KEY=<server only, powers /api/extract; without it the rule-based parser runs>
NEXT_PUBLIC_* values are inlined at build time - redeploy after changing them.

## Verified end-to-end
- scripts/smoke.mjs: all checks passed against this backend.
- Full browser E2E locally (organizer signup -> create meetup -> guests join/vote -> live updates -> confirm -> close): passed.
- Live production check (2026-10-24): signup, organizer app, create meetup, public room link all verified on https://airtribe-team-54.vercel.app.

## Notes
- The Postgres database password was auto-generated at project creation and is not recorded; reset it in Project Settings > Database if direct DB access is needed.
- Test users from E2E (test-organizer-*@example.com) and their meetups are still in the project; wipe them via the dashboard before sharing widely if you want a clean slate.
