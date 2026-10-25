import { NextResponse } from 'next/server';
import { userClient } from '@/lib/supabase/server';
import { publicOrigin, safeNext } from '@/lib/urls';

// Magic-link / OAuth redirect target: exchanges ?code= for a session cookie.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = publicOrigin(req);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'), origin);
  if (code) {
    const { error } = await (await userClient()).auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }
  return NextResponse.redirect(new URL('/login?error=auth', origin));
}
