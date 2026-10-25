'use client';

// "Import Facebook friends" lands here from the organizer. It re-runs Facebook
// OAuth asking for user_friends; normal Facebook sign-in only asks for email.
// /auth/callback?import=facebook then fetches the friends once and stages them.
import { useEffect, useState } from 'react';
import { browserClient } from '@/lib/supabase/browser';

export default function ConnectFacebook() {
  const [error, setError] = useState('');
  useEffect(() => {
    const next = '/organizer/#/contacts';
    browserClient()
      .auth.signInWithOAuth({
        provider: 'facebook',
        options: {
          redirectTo: `${location.origin}/auth/callback?import=facebook&next=${encodeURIComponent(next)}`,
          scopes: 'email public_profile user_friends',
        },
      })
      .then(({ error: e }) => e && setError(e.message));
  }, []);
  return (
    <main style={{ maxWidth: 420, margin: '20vh auto', padding: '0 16px', textAlign: 'center' }}>
      {error ? (
        <>
          <p>Facebook friends import is not available: {error}</p>
          <a href="/organizer/#/contacts">Back to contacts</a>
        </>
      ) : (
        <p>Taking you to Facebook...</p>
      )}
    </main>
  );
}
