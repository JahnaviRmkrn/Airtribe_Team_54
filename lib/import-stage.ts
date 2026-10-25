import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { fetchGraphFriends } from './import-facebook';
import { fetchGoogleContacts } from './import-google';

// Right after the OAuth code exchange, pulls the user's friends (Facebook) or
// contacts (Google, only when they pressed "Import from Google Contacts") with the
// provider token and parks the rows in contact_import_stage for review. The
// provider token is used once, in memory, and never stored. Never throws: a
// failure here must not break sign-in. Empty results stage nothing.
//   flow: the `import` query flag set by the page that started the OAuth round trip.
export async function stageFromSession(supabase: SupabaseClient, session: Session | null, flow: string | null): Promise<void> {
  const token = session?.provider_token;
  if (!session || !token) return;
  try {
    // The ?import flag is only a request: it can be forged on a link. Use the token only when
    // that provider's identity signed in within the last 2 minutes, i.e. this very exchange
    // produced the token, so a Google token is never sent to Facebook or the reverse.
    const source = flow === 'facebook' || flow === 'google' ? flow : null;
    const fresh = source && session.user.identities?.some((i) => i.provider === source && Date.now() - Date.parse(i.last_sign_in_at ?? '') < 120_000);
    if (!source || !fresh) return;
    const { rows } = source === 'facebook' ? await fetchGraphFriends(token) : await fetchGoogleContacts(token);
    if (!rows.length) return;
    await supabase.from('contact_import_stage').upsert({ user_id: session.user.id, source, rows, created_at: new Date().toISOString() });
  } catch {
    // swallow: no names or tokens in logs
  }
}
