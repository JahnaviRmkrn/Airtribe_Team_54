// Env is read lazily so a missing value fails the request with a clear message
// instead of crashing `next build`. NEXT_PUBLIC_* must be referenced by literal
// name: Next.js inlines them into bundles at build time (redeploy after changing).
export function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing env var ${name}. Set it in .env.local or the Vercel project (see DEPLOY.md), then run pnpm check-env.`);
  return value;
}

export const supabaseUrl = () => requireEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL);
export const supabaseAnonKey = () => requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
