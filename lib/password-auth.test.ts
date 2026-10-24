import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { passwordAuth } from './password-auth';

const client = () => ({ signInWithPassword: vi.fn(), signUp: vi.fn() });
const asAuth = (auth: ReturnType<typeof client>) => auth as unknown as SupabaseClient['auth'];

describe('explicit password authentication', () => {
  it('never attempts signup after an incorrect sign-in password', async () => {
    const auth = client();
    auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: new Error('Invalid credentials') });
    await expect(passwordAuth(asAuth(auth), 'sign_in', 'user@example.test', 'wrong', 'https://example.test/auth/callback')).rejects.toThrow('Invalid credentials');
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('does not redirect confirmation-required signups as signed in', async () => {
    const auth = client();
    auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    const callback = 'https://example.test/auth/callback?next=%2Forganizer';
    expect(await passwordAuth(asAuth(auth), 'sign_up', 'user@example.test', 'password', callback)).toEqual({ signedIn: false });
    expect(auth.signUp).toHaveBeenCalledWith({ email: 'user@example.test', password: 'password', options: { emailRedirectTo: callback } });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it.each(['sign_in', 'sign_up'] as const)('redirects only with a real %s session', async (mode) => {
    const auth = client();
    auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: 'test-session' } }, error: null });
    auth.signUp.mockResolvedValue({ data: { session: { access_token: 'test-session' } }, error: null });
    expect(await passwordAuth(asAuth(auth), mode, 'user@example.test', 'password', 'https://example.test/auth/callback')).toEqual({ signedIn: true });
  });
});
