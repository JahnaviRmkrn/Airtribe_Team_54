import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAnonKey, supabaseUrl } from './lib/env';

const SITE = (() => {
  try { return new URL(process.env.NEXT_PUBLIC_SITE_URL || ''); } catch { return null; }
})();

// Behind Cloudflare/a tunnel the app sees plain http; X-Forwarded-Proto says
// what the visitor used. Send http visitors of the public site to https (HSTS
// then keeps them there). Only for the configured site host, so a forged Host
// header can't turn this into an open redirect, and local dev is untouched.
function httpsRedirect(request: NextRequest) {
  if (SITE?.protocol !== 'https:' || request.headers.get('x-forwarded-proto') !== 'http') return null;
  if (request.headers.get('host') !== SITE.host) return null;
  return NextResponse.redirect(new URL(request.nextUrl.pathname + request.nextUrl.search, SITE.origin), 308);
}

// Pine Labs returns the guest to callback_url (/m/:token?payment=done) with a
// form POST, which a page answers with 405. Turn it into a GET of the same
// path. The POST body is ignored: the room checks status via getOrder. A
// relative Location keeps the visitor on whatever host they are using.
function paymentReturn(request: NextRequest) {
  if (request.method !== 'POST' || !/^\/m\/[A-Za-z0-9_-]+$/.test(request.nextUrl.pathname)) return null;
  if (request.nextUrl.searchParams.get('payment') !== 'done') return null;
  return new NextResponse(null, { status: 303, headers: { Location: `${request.nextUrl.pathname}?payment=done` } });
}

// Keeps the Supabase auth session cookie fresh on every request.
export async function middleware(request: NextRequest) {
  const redirect = httpsRedirect(request) ?? paymentReturn(request);
  if (redirect) return redirect;
  // This owner-bound mutation authenticates its own request snapshot without
  // refreshing/persisting cookies. A late middleware cookie would defeat that
  // guarantee by overwriting an account signed in while the update was pending.
  if (request.method === 'POST' && request.nextUrl.pathname === '/api/me/password') {
    return NextResponse.next({ request });
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/rooms).*)'],
};
