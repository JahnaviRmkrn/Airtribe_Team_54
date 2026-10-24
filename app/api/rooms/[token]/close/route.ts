import { handle, HttpError, ok, requireUser } from '@/lib/http';
import { getRoom, roomView } from '@/lib/room';

type Ctx = { params: Promise<{ token: string }> };

// POST /api/rooms/:token/close  (organizer only). The room stays readable
// until expires_at but accepts no more joins, edits or votes.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const { supabase, user } = await requireUser(req);
  const room = await getRoom(token);
  if (room.organizer_id !== user.id) throw new HttpError(403, 'Only the organiser can close this room');
  const { error } = await supabase.from('meetups').update({ status: 'closed' }).eq('id', room.id);
  if (error) throw new HttpError(403, 'Could not close');
  return ok(await roomView(req, { ...room, status: 'closed' }, true));
});
