# Deploy: Vercel + hosted Supabase

## Release safety first

A successful application build or Git push does **not** apply database migrations
or enable Google/payment integrations. Before following this guide, review the
[feature rollout checklist](docs/feature-rollout.md) against the exact intended
project. Do not bulk-apply migrations, run the production smoke script, create
credentials or enable a provider merely to check whether a deployment works.

If any service-role key, database password or provider credential has been
exposed, an authorized operator must revoke/rotate it and review access before
adding new integration credentials. Moving a value into Vault does not revoke an
old key that can still access Vault. Never put a Google connector encryption key
in a store reachable with a compromised credential.

Placeholders: `<ref>` = Supabase project ref (from its URL `https://<ref>.supabase.co`),
`<app>` = the Vercel production host (e.g. `airtribe-team-54.vercel.app`).

## 1. Supabase

Create a project at supabase.com (note the DB password), then from the repo root:

```bash
supabase login
supabase link --project-ref <ref>
supabase db push --include-seed     # migrations + supabase/seed.sql (sample venues)
```

`seed.sql` is not idempotent: run it once. If you pushed without `--include-seed`,
paste `supabase/seed.sql` into Dashboard > SQL Editor and run it instead.

Auth settings (Dashboard > Authentication):

- Sign In / Providers > Email: keep **Confirm email** enabled for production.
  The legacy demo smoke flow assumes immediate sessions and is not a reason to
  weaken production authentication. Use a separately approved disposable test
  project if that demo behavior is needed.
- URL Configuration > Site URL: `https://<app>`
- URL Configuration > Redirect URLs: add
  - `https://<app>/auth/callback`
  - `https://*-<vercel-team>.vercel.app/auth/callback` (optional, preview deploys)
  - `http://localhost:3000/auth/callback` (optional, local dev against hosted)

The magic link returns to `<current origin>/auth/callback`; an origin missing from
this list falls back to the Site URL and sign-in fails. Do not `supabase config push`:
`supabase/config.toml` holds local-only URLs.

Keys: Dashboard > Project Settings > API Keys. Use the anon / publishable key and the
service_role / secret key.

## 2. Vercel

Import the GitHub repo at vercel.com/new (framework: Next.js, defaults are fine), or:

```bash
npx vercel link
```

Set env vars (Project > Settings > Environment Variables, or `npx vercel env add <NAME> production`):

| Name | Value | Exposure |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | public (shipped to browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key | public (shipped to browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role / secret key | **server-only**: mark Sensitive, never prefix `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SITE_URL` | `https://<app>` (no trailing path) | public; Production only, so previews link to themselves |

Optional AI/payment keys are **not** env vars: they live in Supabase Vault and the
server loads them at boot (`instrumentation.ts` -> `lib/secrets.ts`; the list of names is
`VAULT_SECRETS` there). Put them in an untracked file (e.g. `secrets.env`, same
`NAME=value` format as `.env.example`) and upload with the service-role key in `.env.local`:

```bash
node scripts/push-secrets.mjs secrets.env      # prints ok/FAIL per name, never values
```

`DEEPSEEK_API_KEY` (or `GEMINI_API_KEY` / `OPENAI_API_KEY`) powers `POST /api/extract`
onboarding pre-fill, `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` power voice onboarding.
Without them the app still works: extraction uses the rule-based parser and voice is hidden.
Restart / redeploy after changing a vault value (it is read once per server process).
A value set as a real env var still wins over the vault, for local overrides.

`NEXT_PUBLIC_*` values are inlined at build time: after adding or changing any of
them, redeploy (Deployments > Redeploy, or `npx vercel --prod`). A missing var does
not fail the build; requests fail with `Missing env var <NAME>` in the function logs.

Check values before deploying (reads the process env, or a file via `ENV_FILE`):

```bash
npx vercel env pull .env.production.local --environment=production   # gitignored
ENV_FILE=.env.production.local pnpm check-env --prod
```

Deploy:

```bash
npx vercel --prod
```

## 3. Smoke test

Runs the end-to-end API checks against prod. It signs up two throwaway users and
creates meetups in the prod DB. Leave `SUPABASE_SERVICE_ROLE_KEY` unset: the
service-role checks (they insert junk rows) are then skipped.

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key> \
node scripts/smoke.mjs https://<app>
```

If sign-up is rejected for `example.com`, set `SMOKE_EMAIL_DOMAIN` to a domain you own.
Then open `https://<app>/login`, sign in, and check `/organizer/`.

## Payment safety rollout

Before enabling checkout, an authorized operator must follow the
[payment safety upgrade checklist](docs/payment-safety-rollout.md). Published
code is not proof that the required database migrations are installed.
