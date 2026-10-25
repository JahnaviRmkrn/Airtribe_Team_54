'use client';

// "Import from Google Contacts" lands here from the organizer. It re-runs Google
// OAuth with the read-only contacts scope; normal sign-in never asks for it.
// /auth/callback?import=google then fetches the contacts once and stages them.
import { useEffect, useState } from 'react';
import { browserClient } from '@/lib/supabase/browser';

export default function ConnectGoogle() {
  const [error, setError] = useState('');
  useEffect(() => {
    const next = '/organizer/#/contacts';
    browserClient()
      .auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${location.origin}/auth/callback?import=google&next=${encodeURIComponent(next)}`,
          scopes: 'https://www.googleapis.com/auth/contacts.readonly',
          queryParams: { access_type: 'online', prompt: 'consent' },
        },
      })
      .then(({ error: e }) => e && setError(e.message));
  }, []);
  return (
    <main style={{ maxWidth: 420, margin: '20vh auto', padding: '0 16px', textAlign: 'center' }}>
      {error ? (
        <>
          <p>Google contacts import is not available: {error}</p>
          <a href="/organizer/#/contacts">Back to contacts</a>
        </>
      ) : (
        <p>Taking you to Google...</p>
      )}
    </main>
  );
}
