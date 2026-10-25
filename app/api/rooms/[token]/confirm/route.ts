import { confirmBody } from '@/lib/schemas';
import { dbError, handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { getRoom, requireOpen, roomColumns, roomView, type MeetupRow } from '@/lib/room';
import { limitRoom } from '@/lib/ratelimit';

type Ctx = { params: Promise<{ token: string }> };

// POST /api/rooms/:token/confirm  body: { venue_id }  (organizer only)
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'organizer', token);
  const { supabase, user } = await requireUser(req);
  const room = await getRoom(token);
  if (room.organizer_id !== user.id) throw new HttpError(403, 'Only the organiser can confirm a venue');
  requireOpen(room);
  const { venue_id } = await parseBody(req, confirmBody);

  const { data: venue } = await supabase.from('venues').select('id').eq('id', venue_id).maybeSingle();
  if (!venue) throw new HttpError(400, 'Unknown venue');

  // RLS double-checks ownership.
  const { data, error } = await supabase
    .from('meetups')
    .update({ final_venue_id: venue_id })
    .eq('id', room.id)
    .select(roomColumns)
    .single();
  dbError(error);
  if (!data) throw new HttpError(403, 'Could not confirm');
  // Same-venue retries are allowed by the DB trigger. Recheck the row returned
  // by the write so a committed close/expiry cannot look like an open success.
  const updated = data as MeetupRow;
  requireOpen(updated);
  return ok(await roomView(req, updated, true));
});
