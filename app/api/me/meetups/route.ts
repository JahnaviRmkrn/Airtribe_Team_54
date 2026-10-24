import { meetupCreate } from '@/lib/schemas';
import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';
import { roomUrl } from '@/lib/urls';
import { roomExpiry } from '@/lib/expiry';
import { trackProductEvent } from '@/lib/product-analytics';

// GET /api/me/meetups -> the organizer's meetups
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const { data, error } = await supabase.from('meetups').select('*').order('created_at', { ascending: false });
  dbError(error);
  return ok({ meetups: (data ?? []).map((m) => ({ ...m, room_url: roomUrl(req, m.room_token) })) });
});

// POST /api/me/meetups -> creates a room with an unguessable token + share link.
// Nothing is sent to anyone: the organizer copies the link.
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const body = await parseBody(req, meetupCreate);
  const expires_at = roomExpiry(body.starts_at);
  const { data, error } = await supabase
    .from('meetups')
    .insert({ ...body, organizer_id: user.id, expires_at })
    .select('*')
    .single();
  dbError(error);
  const room_url = roomUrl(req, data.room_token);
  await trackProductEvent('meetup_created');
  const when = data.starts_at ? ` on ${new Date(data.starts_at).toDateString()}` : '';
  return ok(
    {
      meetup: { ...data, room_url },
      invite_text: `Join "${data.title}"${when}! Add your preferences and vote on a place: ${room_url}`,
    },
    201,
  );
});
