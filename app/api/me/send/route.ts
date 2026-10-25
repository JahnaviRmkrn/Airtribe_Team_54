import { sendBody, sendMessage } from '@/lib/channels';
import { handle, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';

// POST /api/me/send  { contact_id | jid, text, channel? }
// Sends as the organiser through the best linked channel for that contact
// (WhatsApp, else SMS). Only to their own contacts, or WhatsApp groups and
// synced contacts the bridge confirms. 20 per hour per user across channels.
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const body = await parseBody(req, sendBody);
  await limitUser('send', user.id);
  return ok(await sendMessage({ userId: user.id, supabase }, body));
});
