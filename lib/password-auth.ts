import type { SupabaseClient } from '@supabase/supabase-js';

type PasswordAuth = Pick<SupabaseClient['auth'], 'signInWithPassword' | 'signUp'>;
export type PasswordMode = 'sign_in' | 'sign_up';

// A failed sign-in is not permission to create a different account. Signup is
// explicit, and confirmation-required accounts have no session to redirect with.
export async function passwordAuth(
  auth: PasswordAuth,
  mode: PasswordMode,
  email: string,
  password: string,
  redirectTo: string,
) {
  const result = mode === 'sign_up'
    ? await auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } })
    : await auth.signInWithPassword({ email, password });
  if (result.error) throw result.error;
  const user = result.data.user;
  const age = user?.created_at ? Date.now() - Date.parse(user.created_at) : NaN;
  // Existing-account responses can contain an empty identity list. Never count
  // those, failed sign-ins, or old accounts as a fresh explicit signup.
  const newAccount = mode === 'sign_up' && Boolean(user?.identities?.length)
    && Number.isFinite(age) && age >= 0 && age < 60_000;
  return { signedIn: Boolean(result.data.session), newAccount };
}
