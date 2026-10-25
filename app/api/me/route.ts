import { handle, ok, requireUser } from '@/lib/http';
import { contactCreateRetryReady } from '@/lib/contact-create-retry';

// GET /api/me -> the signed-in account's own details, shown on the Profile page.
export const GET = handle(async (req: Request) => {
  const { user, supabase } = await requireUser(req);
  const response = ok({
    user: { id: user.id, email: user.email ?? null, created_at: user.created_at ?? null },
    capabilities: { contact_create_retry: await contactCreateRetryReady(supabase) },
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
});
