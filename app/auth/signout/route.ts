import { NextResponse } from 'next/server';
import { userClient } from '@/lib/supabase/server';
import { publicOrigin } from '@/lib/urls';

// POST /auth/signout -> clears the Supabase session cookies, back to /login.
// POST only, so a prefetch or a pasted link can't sign anyone out.
export async function POST(req: Request) {
  // CSRF: a cross-site form POST carries a foreign Origin; refuse it.
  const origin = req.headers.get('origin');
  if (origin && origin !== publicOrigin(req)) return new NextResponse('Forbidden', { status: 403 });
  await (await userClient()).auth.signOut();
  return NextResponse.redirect(new URL('/login', publicOrigin(req)), { status: 303 });
}
