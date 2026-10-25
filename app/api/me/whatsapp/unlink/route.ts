import { handle, ok, requireUser } from '@/lib/http';
import { adminClient } from '@/lib/supabase/admin';
import { bridge } from '@/lib/whatsapp';

// POST /api/me/whatsapp/unlink
// Logs the device out on the phone and deletes the stored session and synced
// contact list. If the bridge is unreachable the link is still removed here
// and `wiped: false` tells the client the stored session could not be deleted.
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  let wiped = true;
  try {
    await bridge(`/sessions/${user.id}`, { method: 'DELETE' });
  } catch {
    wiped = false;
  }
  await adminClient().from('channel_links').delete().eq('user_id', user.id).eq('kind', 'whatsapp');
  return ok({ unlinked: true, wiped });
});
