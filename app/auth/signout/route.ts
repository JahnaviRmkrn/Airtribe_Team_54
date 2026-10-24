import { NextResponse } from 'next/server';
import { userClient } from '@/lib/supabase/server';
import { publicOrigin } from '@/lib/urls';

// POST /auth/signout -> clears the Supabase session cookies, back to /login.
// POST only, so a prefetch or a pasted link can't sign anyone out.
export async function POST(req: Request) {
  await (await userClient()).auth.signOut();
  return NextResponse.redirect(new URL('/login', publicOrigin(req)), { status: 303 });
}
