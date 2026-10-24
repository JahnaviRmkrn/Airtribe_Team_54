import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Service-role client: bypasses RLS. Only for the public room API, which does
// its own token + guest-secret checks. Never import this into client code.
let admin: SupabaseClient | null = null;
export function adminClient() {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
