import { sendBody, sendMessage } from '@/lib/channels';
import { handle, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';

// POST /api/me/whatsapp/send  { contact_id | jid, text }
// Same as /api/me/send but WhatsApp only (no SMS fallback).
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const body = await parseBody(req, sendBody);
  await limitUser('send', user.id);
  return ok(await sendMessage({ userId: user.id, supabase }, { ...body, channel: 'whatsapp' }));
});
