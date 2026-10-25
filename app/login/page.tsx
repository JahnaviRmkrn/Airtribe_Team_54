'use client';

// Sign-in / sign-up page for the Organizer app.
// Social providers (Google, Facebook, LinkedIn, Instagram) run through Supabase
// Auth's signInWithOAuth; the email magic link and password calls are unchanged.
// Provider setup (developer apps, client IDs, callback URLs) is documented in
// docs/social-auth-setup.md. Only providers the Supabase project reports as
// enabled (GET /auth/v1/settings) get a button, so unconfigured ones never show.
import { useEffect, useState } from 'react';
import type { Provider } from '@supabase/supabase-js';
import { browserClient } from '@/lib/supabase/browser';
import { supabaseAnonKey, supabaseUrl } from '@/lib/env';
import { safeNext } from '@/lib/urls';
import { track } from '@vercel/analytics';
import './login.css';

type SocialProvider = {
  // Supabase provider id. Instagram is a custom OAuth2 provider (`custom:instagram`);
  // see docs/social-auth-setup.md for why and how to configure it.
  id: string;
  label: string;
  icon: React.ReactNode;
};

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07z"/>
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0A66C2" d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z"/>
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="ig-gradient" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#FEDA75"/>
          <stop offset="50%" stopColor="#D62976"/>
          <stop offset="100%" stopColor="#4F5BD5"/>
        </linearGradient>
      </defs>
      <path fill="url(#ig-gradient)" d="M12 2.16c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85C2.38 3.92 3.9 2.38 7.15 2.23 8.42 2.17 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.01 7.05.07 2.7.27.27 2.69.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.2 4.36 2.62 6.78 6.98 6.98C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c4.35-.2 6.78-2.62 6.98-6.98.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95C23.73 2.7 21.31.27 16.95.07 15.67.01 15.26 0 12 0zm0 5.84A6.16 6.16 0 1 0 12 18.16 6.16 6.16 0 0 0 12 5.84zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.41-11.85a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88z"/>
    </svg>
  );
}

// Brand mark: the muop wordmark symbol (three tilted bars), styled in globals.css.
function LogoMark() {
  return (
    <span className="brand-symbol login-logo-icon" aria-hidden="true"><span /><span /><span /></span>
  );
}

function MailIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5"/>
      <path d="m3.5 7 8.5 6 8.5-6"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9.5" rx="2.5"/>
      <path d="M8 11V8a4 4 0 0 1 8 0v3"/>
    </svg>
  );
}

function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
      <circle cx="12" cy="12" r="3"/>
      {off && <line x1="3.5" y1="20.5" x2="20.5" y2="3.5"/>}
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4z"/>
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h15"/>
      <path d="m13 6 6 6-6 6"/>
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  );
}

const SOCIAL_PROVIDERS: SocialProvider[] = [
  { id: 'google', label: 'Continue with Google', icon: <GoogleIcon /> },
  { id: 'facebook', label: 'Continue with Facebook', icon: <FacebookIcon /> },
  { id: 'linkedin_oidc', label: 'Continue with LinkedIn', icon: <LinkedInIcon /> },
  { id: 'custom:instagram', label: 'Continue with Instagram', icon: <InstagramIcon /> },
];

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [useMagic, setUseMagic] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const supabase = browserClient();
  const [initialError, setInitialError] = useState('');
  // Google is the configured default; the rest appear once the project says
  // they're enabled. If the settings call fails, Google stays the only one.
  const [enabledProviders, setEnabledProviders] = useState<string[]>(['google']);

  useEffect(() => {
    let cancelled = false;
    fetch(`${supabaseUrl()}/auth/v1/settings`, { headers: { apikey: supabaseAnonKey() } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { external?: Record<string, boolean> } | null) => {
        if (cancelled || !s?.external) return;
        setEnabledProviders(SOCIAL_PROVIDERS.map((p) => p.id).filter((id) => s.external![id] === true));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const socialProviders = SOCIAL_PROVIDERS.filter((p) => enabledProviders.includes(p.id));

  // Untrusted query values: only same-origin paths survive safeNext. Computed
  // after mount so server and client first renders match.
  const next = typeof window === 'undefined' ? '/' : safeNext(new URLSearchParams(location.search).get('next'), location.origin);

  // Surfaced by /auth/callback when the code exchange fails, or by Supabase on a
  // cancelled/failed OAuth attempt (?error=...&error_description=...).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const oauthError = params.get('error');
    const description = params.get('error_description');
    if (!oauthError) return;
    setInitialError(
      oauthError === 'auth'
        ? 'Sign-in did not complete. Please try again.'
        : `Sign-in failed: ${description ?? oauthError.replace(/_/g, ' ')}`,
    );
  }, []);

  async function oauthSignIn(provider: SocialProvider) {
    setBusy(provider.id);
    setMsg('');
    setIsError(false);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: provider.id as Provider,
      options: {
        redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}${provider.id === 'facebook' ? '&import=facebook' : ''}`,
        // Facebook only: friends who also use the app can be offered for import.
        // Set NEXT_PUBLIC_FACEBOOK_FRIENDS=0 if Meta rejects user_friends for this app.
        ...(provider.id === 'facebook' && process.env.NEXT_PUBLIC_FACEBOOK_FRIENDS !== '0'
          ? { scopes: 'email public_profile user_friends' }
          : {}),
      },
    });
    // On success the browser is already leaving for the provider; only failures come back here.
    if (error) {
      setBusy(null);
      setIsError(true);
      setMsg(`${provider.label.replace('Continue with ', '')} sign-in is not available yet: ${error.message}`);
    }
  }

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy('email');
    setMsg('');
    setIsError(false);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    setBusy(null);
    setIsError(!!error);
    setMsg(error ? error.message : 'Check your email for a sign-in link.');
  }

  async function withPassword() {
    setBusy('password');
    setMsg('');
    setIsError(false);
    if (mode === 'signup') {
      if (!password) {
        setBusy(null);
        setIsError(true);
        return setMsg('Choose a password');
      }
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setBusy(null);
        setIsError(true);
        return setMsg(error.message);
      }
      location.href = next;
      return;
    }
    const { error } = password
      ? await supabase.auth.signInWithPassword({ email, password })
      : { error: { message: 'Enter a password' } };
    if (error) {
      // First time: create the account (email confirmation is off for the prototype).
      const { data, error: e2 } = await supabase.auth.signUp({ email, password });
      if (e2) {
        setBusy(null);
        setIsError(true);
        return setMsg(e2.message);
      }
      // Supabase returns an empty identities list for an existing account.
      if (data.user?.identities?.length && Date.now() - Date.parse(data.user.created_at) < 60_000) {
        track('sign_up', { method: 'password' });
      }
      if (!data.session) {
        setBusy(null);
        return setMsg('Check your email to confirm your account.');
      }
    }
    location.href = next;
  }

  // Recovery link lands on /reset-password (via the auth callback's code
  // exchange) so the user sets a new password instead of being signed in directly.
  async function forgotPassword() {
    if (!email) {
      setIsError(true);
      return setMsg('Enter your email address first.');
    }
    setBusy('forgot');
    setMsg('');
    setIsError(false);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent('/reset-password')}`,
    });
    setBusy(null);
    setIsError(!!error);
    setMsg(error ? error.message : 'Check your email for a password reset link.');
  }

  function onSubmit(e: React.FormEvent) {
    if (useMagic) return magicLink(e);
    e.preventDefault();
    withPassword();
  }

  const submitLabel =
    busy === 'email'
      ? 'Sending...'
      : busy === 'password'
        ? mode === 'signup'
          ? 'Creating account...'
          : 'Signing in...'
        : useMagic
          ? 'Send Magic Link'
          : mode === 'signup'
            ? 'Create Account'
            : 'Sign In';

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <LogoMark />
          <h1>muop</h1>
          <p className="login-sub">
            {mode === 'signup' ? 'Create your account to get started' : 'Welcome back. Sign in to continue'}
          </p>
        </div>

        <div className="login-tabs" role="tablist" aria-label="Sign in or create account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            className={mode === 'signin' ? 'active' : ''}
            onClick={() => {
              setMode('signin');
              setMsg('');
              setIsError(false);
            }}
          >
            Sign In
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => {
              setMode('signup');
              setMsg('');
              setIsError(false);
            }}
          >
            Create Account
          </button>
        </div>

        <div className="login-labelrow">
          <span className="login-label">{useMagic ? 'MAGIC LINK' : 'EMAIL & PASSWORD'}</span>
          <button
            type="button"
            className="magic-toggle"
            onClick={() => {
              setUseMagic(!useMagic);
              setMsg('');
              setIsError(false);
            }}
          >
            <SparkleIcon /> {useMagic ? 'Use Password' : 'Use Magic Link'}
          </button>
        </div>

        <form onSubmit={onSubmit} className="login-form">
          <label className="field-label" htmlFor="login-email">
            Email address
          </label>
          <div className="field">
            <MailIcon />
            <input
              id="login-email"
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {!useMagic && (
            <>
              <div className="field-labelrow">
                <label className="field-label" htmlFor="login-password">
                  Password
                </label>
                <button type="button" className="forgot-link" disabled={busy !== null} onClick={forgotPassword}>
                  {busy === 'forgot' ? 'Sending...' : 'Forgot?'}
                </button>
              </div>
              <div className="field">
                <LockIcon />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="eye-btn"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <EyeIcon off={showPassword} />
                </button>
              </div>
            </>
          )}

          <button type="submit" className="btn-primary" disabled={busy !== null}>
            {submitLabel} <ArrowIcon />
          </button>
        </form>

        {socialProviders.length > 0 && (<>
        <div className="login-divider">or continue with</div>

        <div className="social-row">
          {socialProviders.map((p) => (
            <button
              key={p.id}
              type="button"
              className="social-btn"
              data-provider={p.id}
              aria-label={p.label}
              title={p.label}
              disabled={busy !== null}
              onClick={() => oauthSignIn(p)}
            >
              {busy === p.id ? <span className="social-spinner" aria-hidden="true" /> : p.icon}
            </button>
          ))}
        </div>
        </>)}

        <p className="login-footer">
          <ShieldIcon /> Secured with HTTPS
        </p>

        {(msg || initialError) && (
          <p className={`login-msg ${isError || initialError ? 'error' : 'info'}`}>{msg || initialError}</p>
        )}
      </div>
    </main>
  );
}
