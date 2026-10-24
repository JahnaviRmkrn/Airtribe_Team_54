import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Per-request client acting as the signed-in user (RLS applies).
// Also accepts `Authorization: Bearer <access_token>` for API clients / curl.
export async function userClient(req?: Request) {
  const bearer = req?.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // called from a context where cookies are read-only
          }
        },
      },
      global: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined,
    },
  );
}
