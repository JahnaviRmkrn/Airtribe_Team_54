import { guestUpdate } from '@/lib/schemas';
import { handle, ok, parseBody } from '@/lib/http';
import { getRoom, requireGuest, requireOpen, roomView, roomWriteError } from '@/lib/room';
import { adminClient } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ token: string }> };

// GET /api/rooms/:token/me -> the current guest's own entry
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const room = await getRoom(token);
  const me = await requireGuest(req, room);
  const { data } = await adminClient()
    .from('meetup_attendees')
    .select('id, guest_name, preferences, availability, joined_at')
    .eq('id', me.id)
    .single();
  return ok({ attendee: data });
});

// PATCH /api/rooms/:token/me -> a guest edits only their own name/preferences
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const room = await getRoom(token);
  requireOpen(room);
  const me = await requireGuest(req, room);
  const body = await parseBody(req, guestUpdate);
  const { error } = await adminClient().from('meetup_attendees').update(body).eq('id', me.id).eq('meetup_id', room.id);
  roomWriteError(error, 'Could not update');
  return ok(await roomView(req, room));
});
