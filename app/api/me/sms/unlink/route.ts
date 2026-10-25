import { dbError, handle, ok, requireUser } from '@/lib/http';
import { adminClient } from '@/lib/supabase/admin';

// POST /api/me/sms/unlink -> deletes the stored gateway credentials.
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  const { error } = await adminClient().from('channel_links').delete().eq('user_id', user.id).eq('kind', 'sms');
  dbError(error);
  return ok({ unlinked: true });
});
