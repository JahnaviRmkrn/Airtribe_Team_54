import { handle, HttpError, ok } from '@/lib/http';
import { amountPaise, cancelOrder, createOrder, getOrderStatus, isConfigured } from '@/lib/pinelabs';
import { limitRoom } from '@/lib/ratelimit';
import { getRoom, requireGuest, requireOpen, type MeetupRow } from '@/lib/room';
import { adminClient } from '@/lib/supabase/admin';
import { roomUrl } from '@/lib/urls';

type Ctx = { params: Promise<{ token: string }> };
type PaymentRow = {
  id: string;
  amount_paise: number;
  pine_order_id: string | null;
  redirect_url: string | null;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  updated_at: string;
};

const cols = 'id, amount_paise, pine_order_id, redirect_url, status, updated_at';
// A row stuck in "pending" with no order (crash mid-create) can be retried after this.
const STALE_CLAIM_MS = 2 * 60_000;

// Only status, amount and the checkout link go to the guest; never order ids.
const view = (p: PaymentRow) => ({
  status: p.status,
  amount_paise: p.amount_paise,
  redirect_url: p.status === 'pending' ? p.redirect_url : null,
});

async function setup(req: Request, token: string) {
  const room = await getRoom(token);
  if (!isConfigured()) throw new HttpError(503, 'Payments are not configured');
  const me = await requireGuest(req, room);
  return { room, me };
}

async function findPayment(room: MeetupRow, attendeeId: string) {
  const { data, error } = await adminClient()
    .from('meetup_payments')
    .select(cols)
    .eq('meetup_id', room.id)
    .eq('attendee_id', attendeeId)
    .maybeSingle();
  if (error) throw new HttpError(503, 'Could not load payment, please retry');
  return data as PaymentRow | null;
}

// Status always comes from Pine Labs (getOrder), never from the return URL,
// which anyone can open with any query string.
async function refresh(p: PaymentRow): Promise<PaymentRow> {
  if (p.status !== 'pending' || !p.pine_order_id) return p;
  const status = await getOrderStatus(p.pine_order_id);
  if (status === p.status) return p;
  const { data, error } = await adminClient()
    .from('meetup_payments')
    .update({ status })
    .eq('id', p.id)
    .eq('pine_order_id', p.pine_order_id)
    .eq('status', 'pending')
    .select(cols)
    .maybeSingle();
  if (error) throw new HttpError(503, 'Could not save payment status, please retry');
  if (!data) throw new HttpError(409, 'Payment changed, please check status again');
  return data as PaymentRow;
}

// GET /api/rooms/:token/pay -> the current guest's own payment (or null)
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'pay', token);
  const { room, me } = await setup(req, token);
  const p = await findPayment(room, me.id);
  return ok({ payment: p ? view(await refresh(p)) : null });
});

// POST /api/rooms/:token/pay -> start (or resume) paying this guest's share of
// the confirmed venue. The amount is computed here, never taken from the body.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'pay', token);
  const { room, me } = await setup(req, token);
  requireOpen(room);
  if (!room.final_venue_id) throw new HttpError(409, 'The organiser has not confirmed a venue yet');

  const db = adminClient();
  const { data: venue, error: vErr } = await db.from('venues').select('price_per_person').eq('id', room.final_venue_id).maybeSingle();
  if (vErr) throw new HttpError(503, 'Could not load venue, please retry');
  const amount = amountPaise(venue?.price_per_person);
  if (!amount) throw new HttpError(400, 'The confirmed venue has no price to pay');

  // Idempotent: reuse a paid or still-payable pending order for this guest.
  let row = await findPayment(room, me.id);
  if (row) {
    row = await refresh(row);
    if (row.status === 'paid') return ok({ payment: view(row) });
    if (row.status === 'pending') {
      if (row.pine_order_id && row.amount_paise === amount) return ok({ payment: view(row) });
      if (!row.pine_order_id && Date.now() - new Date(row.updated_at).getTime() < STALE_CLAIM_MS) {
        throw new HttpError(409, 'Payment is already being created, retry in a moment');
      }
      // Never replace an order that could still be paid in another tab.
      if (row.pine_order_id) throw new HttpError(409, 'The venue price changed. Ask the organiser to reconcile the existing payment before retrying.');
    }
    // Claim the row for a new order; updated_at guards against a concurrent claim.
    const { data } = await db
      .from('meetup_payments')
      .update({ status: 'pending', amount_paise: amount, pine_order_id: null, redirect_url: null })
      .eq('id', row.id)
      .eq('updated_at', row.updated_at)
      .select(cols)
      .maybeSingle();
    if (!data) throw new HttpError(409, 'Payment is already being created, retry in a moment');
    row = data as PaymentRow;
  } else {
    const { data, error } = await db
      .from('meetup_payments')
      .insert({ meetup_id: room.id, attendee_id: me.id, amount_paise: amount, status: 'pending' })
      .select(cols)
      .single();
    if (error?.code === '23505') throw new HttpError(409, 'Payment is already being created, retry in a moment');
    if (error || !data) throw new HttpError(400, 'Could not start payment');
    row = data as PaymentRow;
  }

  const { data: guest } = await db.from('meetup_attendees').select('guest_name').eq('id', me.id).single();
  let order: { orderId: string; redirectUrl: string };
  try {
    order = await createOrder({
      amountPaise: amount,
      // Unique per attempt (Pine Labs rejects reused references): 32 + 1 + ~8 chars.
      merchantRef: `${row.id.replaceAll('-', '')}-${Date.now().toString(36)}`,
      // WARNING: without NEXT_PUBLIC_SITE_URL this uses the request origin (Host
      // header). Set it in production so the return URL cannot be steered.
      callbackUrl: `${roomUrl(req, token)}?payment=done`,
      guestName: guest?.guest_name ?? 'Guest',
    });
  } catch (e) {
    await db.from('meetup_payments').update({ status: 'failed' })
      .eq('id', row.id).eq('updated_at', row.updated_at)
      .eq('status', 'pending').is('pine_order_id', null);
    throw e;
  }

  const { data: saved, error } = await db
    .from('meetup_payments')
    .update({ pine_order_id: order.orderId, redirect_url: order.redirectUrl })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .eq('status', 'pending')
    .is('pine_order_id', null)
    .select(cols)
    .maybeSingle();
  if (error) throw new HttpError(503, 'Could not save payment, please retry');
  if (!saved) {
    // A newer request owns the row. Never expose or store this stale checkout.
    await cancelOrder(order.orderId);
    throw new HttpError(409, 'A newer payment attempt exists, please retry');
  }
  return ok({ payment: view(saved as PaymentRow) }, 201);
});
