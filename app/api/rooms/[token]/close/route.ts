import { handle, HttpError, ok, requireUser } from '@/lib/http';
import { getRoom, roomColumns, roomView, type MeetupRow } from '@/lib/room';
import { limitRoom } from '@/lib/ratelimit';

type Ctx = { params: Promise<{ token: string }> };

// POST /api/rooms/:token/close  (organizer only). The room stays readable
// until expires_at but accepts no more joins, edits or votes.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'organizer', token);
  const { supabase, user } = await requireUser(req);
  const room = await getRoom(token);
  if (room.organizer_id !== user.id) throw new HttpError(403, 'Only the organiser can close this room');
  const { data, error } = await supabase.from('meetups').update({ status: 'closed' }).eq('id', room.id).select(roomColumns).single();
  if (error?.code === 'PGRST116') throw new HttpError(404, 'Not found');
  if (error) throw new HttpError(403, 'Could not close');
  if (!data) throw new HttpError(404, 'Not found');
  // Closing may succeed after expiry, but expired rooms still must not be
  // returned. Use the write result, including any intervening confirmation.
  const updated = data as MeetupRow;
  if (new Date(updated.expires_at) < new Date()) throw new HttpError(404, 'Room not found');
  return ok(await roomView(req, updated, true));
});
