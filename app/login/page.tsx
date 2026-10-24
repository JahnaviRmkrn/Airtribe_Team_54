'use client';

// Minimal login so the API is usable today. Person B can restyle or replace it;
// keep the two calls (signInWithOtp / signInWithPassword) and the callback URL.
import { useState } from 'react';
import { browserClient } from '@/lib/supabase/browser';
import { safeNext } from '@/lib/urls';
import { track } from '@vercel/analytics';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  // Untrusted query value: only same-origin paths survive.
  const next = typeof window === 'undefined' ? '/' : safeNext(new URLSearchParams(location.search).get('next'), location.origin);

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await browserClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    setMsg(error ? error.message : 'Check your email for a sign-in link.');
  }

  async function withPassword() {
    const { error } = password
      ? await browserClient().auth.signInWithPassword({ email, password })
      : { error: { message: 'Enter a password' } };
    if (error) {
      // First time: create the account (email confirmation is off for the prototype).
      const { data, error: e2 } = await browserClient().auth.signUp({ email, password });
      if (e2) return setMsg(e2.message);
      // Supabase returns an empty identities list for an existing account.
      if (data.user?.identities?.length && Date.now() - Date.parse(data.user.created_at) < 60_000) {
        track('sign_up', { method: 'password' });
      }
      if (!data.session) return setMsg('Check your email to confirm your account.');
    }
    location.href = next;
  }

  return (
    <main style={{ maxWidth: 360, margin: '15vh auto', fontFamily: 'system-ui', display: 'grid', gap: 12 }}>
      <h1>Sign in</h1>
      <form onSubmit={magicLink} style={{ display: 'grid', gap: 8 }}>
        <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit">Email me a sign-in link</button>
      </form>
      <input type="password" placeholder="or password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="button" onClick={withPassword}>Sign in / sign up with password</button>
      {msg && <p>{msg}</p>}
    </main>
  );
}
