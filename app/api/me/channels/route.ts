import { handle, ok, requireUser } from '@/lib/http';
import { adminClient } from '@/lib/supabase/admin';

// GET /api/me/channels -> which send channels are linked. No credentials, ever.
export const GET = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  const { data } = await adminClient().from('channel_links').select('kind,status,mode').eq('user_id', user.id);
  const wa = data?.find((r) => r.kind === 'whatsapp');
  const sms = data?.find((r) => r.kind === 'sms');
  return ok({
    whatsapp: { linked: wa?.status === 'connected' },
    sms: { linked: sms?.status === 'connected', mode: sms?.mode ?? null },
  });
});
