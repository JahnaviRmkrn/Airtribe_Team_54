import { NextResponse } from 'next/server';
import { userClient } from '@/lib/supabase/server';
import { safeNext } from '@/lib/urls';

// Public origin of this request. Behind a reverse proxy (cloudflared, Tailscale
// Funnel) req.url carries the internal address (localhost:3000), so prefer the
// forwarded/Host headers or the post-login redirect lands on localhost.
function publicOrigin(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) return new URL(req.url).origin;
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || (local ? 'http' : 'https');
  return `${proto}://${host}`;
}

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
