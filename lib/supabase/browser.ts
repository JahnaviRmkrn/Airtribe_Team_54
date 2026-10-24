import { createBrowserClient } from '@supabase/ssr';
import { supabaseAnonKey, supabaseUrl } from '../env';

// For client components (login form, realtime subscriptions).
export function browserClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
