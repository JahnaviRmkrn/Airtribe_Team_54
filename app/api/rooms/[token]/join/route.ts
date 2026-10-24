import { guestJoin } from '@/lib/schemas';
import { handle, HttpError, ok, parseBody } from '@/lib/http';
import { currentGuest, getRoom, hashSecret, newSecret, requireOpen, roomView, setGuestCookie } from '@/lib/room';
import { adminClient } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ token: string }> };
const MAX_GUESTS = 50;

// POST /api/rooms/:token/join  body: { guest_name, preferences?, availability? }
// Sets an httpOnly guest cookie. The secret is also returned once so a client
// can keep it (e.g. to test several guests from one browser via X-Guest-Secret).
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const room = await getRoom(token);
  requireOpen(room);
  if (await currentGuest(req, room)) throw new HttpError(409, 'Already joined. Use PATCH /me to update.');
  const body = await parseBody(req, guestJoin);

  const db = adminClient();
  const { count } = await db.from('meetup_attendees').select('id', { count: 'exact', head: true }).eq('meetup_id', room.id);
  if ((count ?? 0) >= MAX_GUESTS) throw new HttpError(429, 'Room is full');

  const secret = newSecret();
  const { data, error } = await db
    .from('meetup_attendees')
    .insert({ ...body, meetup_id: room.id, secret_hash: hashSecret(secret) })
    .select('id')
    .single();
  if (error) throw new HttpError(400, 'Could not join');
  await setGuestCookie(room, secret);
  return ok({ attendee_id: data.id, guest_secret: secret, room: await roomView(new Request(req.url, { headers: { 'x-guest-secret': secret } }), room) }, 201);
});
