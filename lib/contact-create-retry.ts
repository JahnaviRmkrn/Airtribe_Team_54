import type { SupabaseClient } from '@supabase/supabase-js';

// Deliberately server-only and opt-in. Shipping the code is not approval to
// apply the migration or enable this feature in any deployed environment.
export const contactCreateRetryConfigured = () => process.env.CONTACT_CREATE_RETRY_ENABLED === 'true';

export async function contactCreateRetryReady(supabase: SupabaseClient): Promise<boolean> {
  if (!contactCreateRetryConfigured()) return false;
  try {
    // Read-only, authenticated probe installed by the reviewed migration. Never
    // test readiness by calling the mutating create RPC or making a contact.
    const { data, error } = await supabase.rpc('contact_create_retry_ready')
      .abortSignal(AbortSignal.timeout(1500));
    return !error && data === true;
  } catch {
    // A missing migration or unavailable DB must not break profile/legacy Add.
    return false;
  }
}
