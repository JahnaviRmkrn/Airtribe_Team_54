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
  return { signedIn: Boolean(result.data.session) };
}
