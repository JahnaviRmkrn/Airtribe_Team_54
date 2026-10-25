import { handle, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { publicStatus, syncedStatus } from '@/lib/whatsapp';

// GET /api/me/whatsapp/status
// state: unlinked | connecting | waiting_qr | connected | logged_out | error.
// While waiting_qr, `qr` is the current string (it rotates every ~20 s):
// render it client-side. Never cached.
export const GET = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  await limitUser('waStatus', user.id);
  const st = await syncedStatus(user.id);
  return new Response(JSON.stringify({ ...publicStatus(st), bridge_up: st.bridge_up }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
});
