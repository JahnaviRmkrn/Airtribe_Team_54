'use client';

// Set-a-new-password page for the Forgot? flow. The recovery email's link
// points at /auth/callback?next=/reset-password; the callback exchanges the
// code for a session and lands here, so updateUser can set the new password.
// Styling reuses the muop login design (app/login/login.css).
import { useEffect, useRef, useState } from 'react';
import { browserClient } from '@/lib/supabase/browser';
import { safeNext } from '@/lib/urls';
import '../login/login.css';

// Brand mark: the muop wordmark symbol (three tilted bars), same as /login.
function LogoMark() {
  return (
    <span className="brand-symbol login-logo-icon" aria-hidden="true"><span /><span /><span /></span>
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

type LinkState = 'checking' | 'ready' | 'expired' | 'error';

export default function ResetPasswordPage() {
  const [linkState, setLinkState] = useState<LinkState>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [msg, setMsg] = useState('');
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const mounted = useRef(false);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Untrusted query values: only same-origin paths survive safeNext. Computed
  // after mount so server and client first renders match.
  const next = typeof window === 'undefined' ? '/' : safeNext(new URLSearchParams(location.search).get('next'), location.origin);

  // A session here means the recovery code was exchanged successfully.
  // PASSWORD_RECOVERY covers clients that detect the token from the URL hash.
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = browserClient();
      const { data: sub } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY' && !cancelled) setLinkState('ready');
      });
      unsubscribe = () => sub.subscription.unsubscribe();
      supabase.auth.getUser().then(({ data, error }) => {
        if (cancelled) return;
        setLinkState((s) => (s === 'checking' ? (!error && data.user ? 'ready' : 'expired') : s));
      }).catch(() => {
        if (!cancelled) setLinkState((s) => s === 'checking' ? 'error' : s);
      });
    } catch {
      setLinkState('error');
    }
    return () => {
      cancelled = true;
      mounted.current = false;
      unsubscribe?.();
      if (redirectTimer.current !== null) clearTimeout(redirectTimer.current);
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    setIsError(false);
    if (password.length < 6) {
      setIsError(true);
      return setMsg('Password must be at least 6 characters.');
    }
    if (password !== confirm) {
      setIsError(true);
      return setMsg('Passwords do not match.');
    }
    setBusy(true);
    try {
      const { error } = await browserClient().auth.updateUser({ password });
      if (!mounted.current) return;
      if (error) throw error;
      setDone(true);
      redirectTimer.current = setTimeout(() => {
        if (mounted.current) location.href = next;
      }, 1600);
    } catch (error) {
      if (mounted.current) {
        setIsError(true);
        setMsg(error instanceof Error ? error.message : 'Could not update your password. Please try again.');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const subtitle =
    linkState === 'ready'
      ? done
        ? 'All set!'
        : 'Choose a new password for your account'
      : linkState === 'expired' || linkState === 'error'
        ? 'We could not verify your reset link'
        : 'Hold on a moment';

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <LogoMark />
          <h1>muop</h1>
          <p className="login-sub">{subtitle}</p>
        </div>

        {linkState === 'checking' && <p className="login-msg info">Checking your reset link...</p>}

        {(linkState === 'expired' || linkState === 'error') && (
          <>
            <p className="login-msg error">
              {linkState === 'error'
                ? 'We could not check your reset link. Please refresh the page to try again.'
                : 'This reset link is invalid or has expired. Request a new one from the sign-in page.'}
            </p>
            <button type="button" className="btn-primary" onClick={() => (location.href = '/login')}>
              Back to Sign In <ArrowIcon />
            </button>
          </>
        )}

        {linkState === 'ready' && !done && (
          <form onSubmit={onSubmit} className="login-form">
            <div className="login-labelrow">
              <span className="login-label">RESET PASSWORD</span>
            </div>

            <label className="field-label" htmlFor="reset-password">
              New password
            </label>
            <div className="field">
              <LockIcon />
              <input
                id="reset-password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                placeholder="At least 6 characters"
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

            <label className="field-label" htmlFor="reset-confirm">
              Confirm new password
            </label>
            <div className="field">
              <LockIcon />
              <input
                id="reset-confirm"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                placeholder="Repeat the new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Updating...' : 'Set New Password'} <ArrowIcon />
            </button>
          </form>
        )}

        {done && <p className="login-msg info">Password updated - taking you back into the app...</p>}

        <p className="login-footer">
          <ShieldIcon /> Secured with HTTPS
        </p>

        {msg && <p className={`login-msg ${isError ? 'error' : 'info'}`}>{msg}</p>}
      </div>
    </main>
  );
}
