import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { adminClient } from '@/lib/supabase/admin';
import { bridge, linkBody, publicStatus, type BridgeStatus } from '@/lib/whatsapp';

// POST /api/me/whatsapp/link  { accept: true, phone? }
// Opt-in: records consent, then asks the bridge to start a linked-device
// session. Poll GET /status for the QR (or the pairing code if `phone` is given).
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  const body = await parseBody(req, linkBody);
  await limitUser('waLink', user.id);
  const { error } = await adminClient().from('channel_links').upsert({
    user_id: user.id,
    kind: 'whatsapp',
    status: 'connecting',
    last_error: null,
    consented_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  dbError(error);
  const st = await bridge<BridgeStatus>(`/sessions/${user.id}/start`, { method: 'POST', body: { phone: body.phone } });
  return ok(publicStatus(st));
});
