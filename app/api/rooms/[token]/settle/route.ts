import { dbError, handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { getRoom, roomView } from '@/lib/room';
import { limitRoom } from '@/lib/ratelimit';
import { settleBody } from '@/lib/settle';

type Ctx = { params: Promise<{ token: string }> };

async function organizer(req: Request, token: string) {
  await limitRoom(req, 'organizer', token);
  const { supabase, user } = await requireUser(req);
  const room = await getRoom(token);
  if (room.organizer_id !== user.id) throw new HttpError(403, 'Only the organiser can collect money for this meetup');
  return { supabase, room };
}

// POST /api/rooms/:token/settle  body: { upi_vpa, upi_payee, amount_paise }  (organizer only)
// Starts (or changes) collecting each guest's share to the organiser's UPI ID.
// Works on closed rooms too: people usually settle up after the meetup.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const { supabase, room } = await organizer(req, token);
  const body = await parseBody(req, settleBody);
  // RLS double-checks ownership.
  const { error } = await supabase.from('meetups')
    .update({ upi_vpa: body.upi_vpa, upi_payee: body.upi_payee, settle_amount_paise: body.amount_paise })
    .eq('id', room.id);
  dbError(error);
  return ok(await roomView(req, room, true));
});

// DELETE /api/rooms/:token/settle  (organizer only): stop collecting. Existing
// claims and confirmations are kept so turning it back on loses nothing.
export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  const { supabase, room } = await organizer(req, token);
  const { error } = await supabase.from('meetups')
    .update({ upi_vpa: null, upi_payee: null, settle_amount_paise: null })
    .eq('id', room.id);
  dbError(error);
  return ok(await roomView(req, room, true));
});
