import { handle, HttpError, ok } from '@/lib/http';
import { getRoom, requireGuest, roomView } from '@/lib/room';
import { limitRoom } from '@/lib/ratelimit';
import { adminClient } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ token: string }> };

async function guest(req: Request, token: string) {
  await limitRoom(req, 'write', token);
  const room = await getRoom(token);
  const me = await requireGuest(req, room);
  return { room, me };
}

// POST /api/rooms/:token/settle/paid  (joined guest): "I've paid" for the current
// share. Only a claim - the organiser confirms it once the money arrives.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const { room, me } = await guest(req, token);
  const db = adminClient();
  const { data: cfg, error: cErr } = await db.from('meetups').select('settle_amount_paise').eq('id', room.id).single();
  if (cErr) throw new HttpError(503, 'Could not record that, please retry');
  if (!cfg?.settle_amount_paise) throw new HttpError(409, 'The organiser is not collecting money for this meetup');
  // A repeat tap, or a share the organiser already confirmed, stays as it is.
  const { error } = await db.from('meetup_settlements')
    .upsert({ meetup_id: room.id, attendee_id: me.id, amount_paise: cfg.settle_amount_paise }, { onConflict: 'meetup_id,attendee_id', ignoreDuplicates: true });
  if (error) throw new HttpError(503, 'Could not record that, please retry');
  return ok(await roomView(req, room));
});

// DELETE /api/rooms/:token/settle/paid  (joined guest): take back a claim made by
// mistake. A share the organiser has confirmed cannot be withdrawn by the guest.
export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const { room, me } = await guest(req, token);
  const { error } = await adminClient().from('meetup_settlements')
    .delete().eq('meetup_id', room.id).eq('attendee_id', me.id).eq('status', 'claimed');
  if (error) throw new HttpError(503, 'Could not update that, please retry');
  return ok(await roomView(req, room));
});
