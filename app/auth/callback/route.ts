import { NextResponse } from 'next/server';
import { stageFromSession } from '@/lib/import-stage';
import { userClient } from '@/lib/supabase/server';
import { publicOrigin, safeNext } from '@/lib/urls';

// Magic-link / OAuth redirect target: exchanges ?code= for a session cookie.
// ?import=facebook|google (set by the login page / "Import from Google Contacts")
// also uses the one-time provider_token to stage friends/contacts for review.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = publicOrigin(req);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'), origin);
  if (code) {
    const supabase = await userClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      await stageFromSession(supabase, data.session, url.searchParams.get('import'));
      return NextResponse.redirect(new URL(next, origin));
    }
  }
  return NextResponse.redirect(new URL('/login?error=auth', origin));
}
