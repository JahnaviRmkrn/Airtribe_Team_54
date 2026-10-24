import { voteBody } from '@/lib/schemas';
import { handle, HttpError, ok, parseBody } from '@/lib/http';
import { getRoom, requireGuest, requireOpen, roomView, roomWriteError } from '@/lib/room';
import { adminClient } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ token: string }> };

// POST /api/rooms/:token/vote  body: { venue_id }
// One vote per guest; voting again moves the vote. Must be a shortlisted venue.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const room = await getRoom(token);
  requireOpen(room);
  if (room.final_venue_id) throw new HttpError(409, 'The organiser has already confirmed a venue');
  const me = await requireGuest(req, room);
  const { venue_id } = await parseBody(req, voteBody);

  const view = await roomView(req, room);
  if (!view.shortlist.some((s) => s.venue.id === venue_id)) throw new HttpError(400, 'Venue is not on the shortlist');

  const { error } = await adminClient()
    .from('venue_votes')
    .upsert({ meetup_id: room.id, attendee_id: me.id, venue_id }, { onConflict: 'meetup_id,attendee_id' });
  roomWriteError(error, 'Could not record vote');
  return ok(await roomView(req, room));
});

// DELETE /api/rooms/:token/vote -> withdraw own vote
export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const room = await getRoom(token);
  requireOpen(room);
  const me = await requireGuest(req, room);
  const { error } = await adminClient().from('venue_votes').delete().eq('meetup_id', room.id).eq('attendee_id', me.id);
  if (error) throw new HttpError(400, 'Could not withdraw vote');
  return ok(await roomView(req, room));
});
