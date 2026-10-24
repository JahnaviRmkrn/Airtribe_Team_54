import { redirect } from 'next/navigation';
import { userClient } from '@/lib/supabase/server';

// Reads the session cookie, so this must render per request (not prerendered).
export const dynamic = 'force-dynamic';

// The home page is a router: signed-in users go to the organizer app,
// everyone else to login (which returns them to the organizer app).
export default async function Home() {
  const { data } = await (await userClient()).auth.getUser();
  redirect(data.user ? '/organizer' : '/login?next=%2Forganizer');
}
