'use client';

// Minimal login so the API is usable today. Person B can restyle or replace it;
// keep the two calls (signInWithOtp / signInWithPassword) and the callback URL.
import { useState } from 'react';
import { browserClient } from '@/lib/supabase/browser';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const supabase = browserClient();
  const next = typeof window === 'undefined' ? '/' : new URLSearchParams(location.search).get('next') ?? '/';

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    setMsg(error ? error.message : 'Check your email for a sign-in link.');
  }

  async function withPassword() {
    const { error } = password
      ? await supabase.auth.signInWithPassword({ email, password })
      : { error: { message: 'Enter a password' } };
    if (error) {
      // First time: create the account (email confirmation is off for the prototype).
      const { error: e2 } = await supabase.auth.signUp({ email, password });
      if (e2) return setMsg(e2.message);
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
