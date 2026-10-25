import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseAnonKey, supabaseUrl } from '../env';

// Per-request client acting as the signed-in user (RLS applies).
// Also accepts `Authorization: Bearer <access_token>` for API clients / curl.
export type UserClientOptions = { writeCookies?: boolean; allowRefresh?: boolean };

export async function userClient(req?: Request, options: UserClientOptions = {}) {
  const bearer = req?.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const cookieStore = await cookies();
  // Password updates must stay bound to this request and must not overwrite a
  // newer browser session when their response arrives. Defaults stay unchanged.
  const requestCookies = options.writeCookies === false ? cookieStore.getAll() : null;
  const noRefreshFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      // A rotated session cannot safely be persisted by a late password response.
      // Require a new sign-in instead; never rotate and discard its cookies.
      return Promise.resolve(new Response(JSON.stringify({ code: 'session_expired', msg: 'Session expired. Sign in again.' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      }));
    }
    return fetch(input, init);
  };
  return createServerClient(
    supabaseUrl(),
    supabaseAnonKey(),
    {
      cookies: {
        getAll: () => requestCookies ?? cookieStore.getAll(),
        setAll: (list) => {
          if (options.writeCookies === false) return;
          try {
            list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // called from a context where cookies are read-only
          }
        },
      },
      global: bearer || options.allowRefresh === false ? {
        ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
        ...(options.allowRefresh === false ? { fetch: noRefreshFetch } : {}),
      } : undefined,
    },
  );
}
