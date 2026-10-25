import { handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { getRoom, roomView } from '@/lib/room';
import { limitRoom } from '@/lib/ratelimit';
import { settleConfirmBody } from '@/lib/settle';
import { adminClient } from '@/lib/supabase/admin';

type Ctx = { params: Promise<{ token: string }> };

// POST /api/rooms/:token/settle/confirm  body: { attendee_id, confirmed }  (organizer only)
// confirmed=true: the share reached the organiser (also for cash, or a guest who
// paid without tapping "I've paid"). confirmed=false: not received - the row is
// removed and the guest can mark it paid again.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'organizer', token);
  const { user } = await requireUser(req);
  const room = await getRoom(token);
  if (room.organizer_id !== user.id) throw new HttpError(403, 'Only the organiser can confirm payments');
  const { attendee_id, confirmed } = await parseBody(req, settleConfirmBody);
  const db = adminClient();
  const [{ data: cfg, error: cErr }, { data: attendee, error: aErr }] = await Promise.all([
    db.from('meetups').select('settle_amount_paise').eq('id', room.id).single(),
    db.from('meetup_attendees').select('id').eq('id', attendee_id).eq('meetup_id', room.id).maybeSingle(),
  ]);
  if (cErr || aErr) throw new HttpError(503, 'Could not update that, please retry');
  if (!attendee) throw new HttpError(404, 'That guest is not in this meetup');
  if (confirmed) {
    const { data: existing, error } = await db.from('meetup_settlements').select('amount_paise')
      .eq('meetup_id', room.id).eq('attendee_id', attendee_id).maybeSingle();
    if (error) throw new HttpError(503, 'Could not update that, please retry');
    const amount = existing?.amount_paise ?? cfg?.settle_amount_paise;
    if (!amount) throw new HttpError(409, 'Start collecting first');
    const { error: wErr } = await db.from('meetup_settlements').upsert(
      { meetup_id: room.id, attendee_id, amount_paise: amount, status: 'confirmed', confirmed_at: new Date().toISOString() },
      { onConflict: 'meetup_id,attendee_id' },
    );
    if (wErr) throw new HttpError(503, 'Could not update that, please retry');
  } else {
    const { error } = await db.from('meetup_settlements').delete().eq('meetup_id', room.id).eq('attendee_id', attendee_id);
    if (error) throw new HttpError(503, 'Could not update that, please retry');
  }
  return ok(await roomView(req, room, true));
});
