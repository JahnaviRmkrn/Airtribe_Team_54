import { randomUUID } from 'node:crypto';
import { handle, HttpError, ok } from '@/lib/http';
import { amountPaise, createOrder, getOrderStatus, isConfigured } from '@/lib/pinelabs';
import { limitRoom } from '@/lib/ratelimit';
import { getRoom, requireGuest, requireOpen, type MeetupRow } from '@/lib/room';
import { adminClient } from '@/lib/supabase/admin';
import { roomUrl } from '@/lib/urls';

type Ctx = { params: Promise<{ token: string }> };
type CheckoutState = 'ready' | 'creating' | 'reconciliation_required';
type PaymentRow = {
  id: string;
  amount_paise: number;
  pine_order_id: string | null;
  redirect_url: string | null;
  merchant_order_reference: string | null;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  updated_at: string;
  checkout_state?: CheckoutState;
};
type Order = { orderId: string; redirectUrl: string };
type Attempt = {
  state: 'creating' | 'uncertain' | 'received';
  pine_order_id: string | null;
  redirect_url: string | null;
  created_at: string;
};

const legacyCols = 'id, amount_paise, pine_order_id, redirect_url, status, updated_at';
const cols = `${legacyCols}, merchant_order_reference`;
const setupMessage = 'Checkout is unavailable until the operator completes the payment safety upgrade. Do not start another payment; you can still check an existing payment status.';
const unavailableMessage = 'Payment status is temporarily unavailable. Check status before paying; do not start another payment.';
class PaymentSetupError extends HttpError {
  constructor() { super(503, setupMessage); }
}
// Only documented missing-object codes establish setup-needed. A timeout, empty
// acknowledgement or unknown error is NOT evidence that a migration is absent.
const missingSchema = (error: { code?: string } | null) =>
  !!error && ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code ?? '');
async function paymentSchemaReady() {
  try {
    const { data, error } = await adminClient().rpc('payment_checkout_ready');
    if (error && ['42883', 'PGRST202'].includes(error.code ?? '')) return false;
    if (missingSchema(error)) return false;
    if (error || typeof data !== 'boolean') throw new HttpError(503, unavailableMessage);
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, unavailableMessage);
  }
}
const readyResponse = (payment: ReturnType<typeof view> | null, status = 200) =>
  ok({ payment, checkout_availability: 'ready' }, status);
// This changes the message only. An elapsed timer NEVER releases a claim.
const CREATION_NOTICE_MS = 2 * 60_000;
const reconcileMessage = 'Payment creation could not be confirmed. Do not pay again. Check payment status or ask the organiser to reconcile it.';

// Only state, amount and this guest's checkout link go to the guest. Provider
// order IDs, merchant references and recovery receipts stay server-side.
const view = (p: PaymentRow) => ({
  status: p.status,
  amount_paise: p.amount_paise,
  redirect_url: p.status === 'pending' ? p.redirect_url : null,
  checkout_state: p.checkout_state ?? (p.pine_order_id || p.status === 'paid' ? 'ready' : 'reconciliation_required'),
});

async function setup(req: Request, token: string) {
  const room = await getRoom(token);
  if (!isConfigured()) throw new HttpError(503, 'Payments are not configured');
  const me = await requireGuest(req, room);
  return { room, me };
}

async function findPayment(room: MeetupRow, attendeeId: string, legacy = false) {
  const { data, error } = await adminClient()
    .from('meetup_payments').select(legacy ? legacyCols : cols)
    .eq('meetup_id', room.id).eq('attendee_id', attendeeId).maybeSingle();
  if (missingSchema(error)) throw new PaymentSetupError();
  if (error) throw new HttpError(503, unavailableMessage);
  return data as PaymentRow | null;
}

// Compatibility is deliberately READ ONLY. No receipt recovery, status save,
// legacy claim, checkout URL or automatic retry is permitted without the guard.
async function readOnlyStatus(room: MeetupRow, attendeeId: string) {
  const p = await findPayment(room, attendeeId, true);
  const status = p?.status === 'pending' && p.pine_order_id
    ? await getOrderStatus(p.pine_order_id) : p?.status;
  return ok({
    payment: p ? { ...view(p), status, redirect_url: null } : null,
    checkout_availability: 'setup_required',
    message: setupMessage,
  });
}

// Bounded, idempotent DB-only recovery. A lost write acknowledgement may mean
// the first write COMMITTED. Read before repeating it, and never cancel the
// provider order or issue another create based on a DB error/empty response.
async function saveOrder(p: PaymentRow, order: Order): Promise<PaymentRow | null> {
  const db = adminClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await db.from('meetup_payments')
        .update({ pine_order_id: order.orderId, redirect_url: order.redirectUrl })
        .eq('id', p.id).eq('merchant_order_reference', p.merchant_order_reference)
        .eq('status', 'pending').is('pine_order_id', null).select(cols).maybeSingle();
      if (!error && data) return data as PaymentRow;
    } catch { /* A transport exception also has an uncertain commit outcome. */ }
    try {
      const { data, error } = await db.from('meetup_payments').select(cols)
        .eq('id', p.id).eq('merchant_order_reference', p.merchant_order_reference).maybeSingle();
      if (error) return null;
      if (data?.pine_order_id === order.orderId && data.redirect_url === order.redirectUrl) return data as PaymentRow;
      if (!data || data.status !== 'pending' || data.pine_order_id) return null;
    } catch { return null; }
  }
  return null;
}

async function saveReceipt(p: PaymentRow, order: Order) {
  const db = adminClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await db.from('meetup_payment_attempts')
        .update({ state: 'received', pine_order_id: order.orderId, redirect_url: order.redirectUrl })
        .eq('merchant_order_reference', p.merchant_order_reference).eq('payment_id', p.id)
        .is('pine_order_id', null).select('pine_order_id, redirect_url').maybeSingle();
      if (!error && data) return true;
    } catch { /* Read back before repeating the same local receipt write. */ }
    try {
      const { data, error } = await db.from('meetup_payment_attempts').select('pine_order_id, redirect_url')
        .eq('merchant_order_reference', p.merchant_order_reference).eq('payment_id', p.id).maybeSingle();
      if (error || !data) return;
      if (data.pine_order_id) return data.pine_order_id === order.orderId && data.redirect_url === order.redirectUrl;
    } catch { return; }
  }
}

async function recover(p: PaymentRow): Promise<PaymentRow> {
  if (p.pine_order_id || p.status === 'paid') return p;
  if (!p.merchant_order_reference) return { ...p, checkout_state: 'reconciliation_required' };
  const { data, error } = await adminClient().from('meetup_payment_attempts')
    .select('state, pine_order_id, redirect_url, created_at')
    .eq('merchant_order_reference', p.merchant_order_reference).eq('payment_id', p.id)
    .eq('amount_paise', p.amount_paise).maybeSingle();
  if (missingSchema(error)) throw new PaymentSetupError();
  if (error) throw new HttpError(503, reconcileMessage);
  const receipt = data as Attempt | null;
  if (p.status === 'pending' && receipt?.state === 'received' && receipt.pine_order_id && receipt.redirect_url) {
    const saved = await saveOrder(p, { orderId: receipt.pine_order_id, redirectUrl: receipt.redirect_url });
    if (!saved) throw new HttpError(503, reconcileMessage);
    return saved;
  }
  const age = receipt ? Date.now() - new Date(receipt.created_at).getTime() : Number.NaN;
  return { ...p, checkout_state: receipt?.state === 'creating' && age >= 0 && age < CREATION_NOTICE_MS
    ? 'creating' : 'reconciliation_required' };
}

// Status always comes from Pine Labs (getOrder), never from the return URL.
async function refresh(p: PaymentRow): Promise<PaymentRow> {
  p = await recover(p);
  if (p.status !== 'pending' || !p.pine_order_id) return p;
  const status = await getOrderStatus(p.pine_order_id);
  if (status === p.status) return p;
  const { data, error } = await adminClient().from('meetup_payments').update({ status })
    .eq('id', p.id).eq('pine_order_id', p.pine_order_id).eq('status', 'pending').select(cols).maybeSingle();
  if (error) throw new HttpError(503, 'Could not save payment status, please check status again');
  if (!data) throw new HttpError(409, 'Payment changed, please check status again');
  return data as PaymentRow;
}

export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'pay', token);
  const { room, me } = await setup(req, token);
  if (!await paymentSchemaReady()) return readOnlyStatus(room, me.id);
  try {
    const p = await findPayment(room, me.id);
    return readyResponse(p ? view(await refresh(p)) : null);
  } catch (error) {
    if (error instanceof PaymentSetupError) return readOnlyStatus(room, me.id);
    throw error;
  }
});

export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'pay', token);
  const { room, me } = await setup(req, token);
  if (!await paymentSchemaReady()) throw new PaymentSetupError();
  requireOpen(room);
  if (!room.final_venue_id) throw new HttpError(409, 'The organiser has not confirmed a venue yet');

  const db = adminClient();
  const { data: venue, error: vErr } = await db.from('venues').select('price_per_person').eq('id', room.final_venue_id).maybeSingle();
  if (vErr) throw new HttpError(503, 'Could not load venue, please retry');
  const amount = amountPaise(venue?.price_per_person);
  if (!amount) throw new HttpError(400, 'The confirmed venue has no price to pay');

  let row = await findPayment(room, me.id);
  if (row) {
    row = await refresh(row);
    if (row.status === 'paid') return readyResponse(view(row));
    if (!row.pine_order_id) {
      throw new HttpError(409, row.checkout_state === 'creating'
        ? 'Payment is being created. Check payment status; do not start another checkout.' : reconcileMessage);
    }
    if (row.status === 'pending') {
      if (row.amount_paise === amount) return readyResponse(view(row));
      throw new HttpError(409, 'The venue price changed. Ask the organiser to reconcile the existing payment before retrying.');
    }
  }

  // Persist a new unique merchant reference before calling the provider. It is
  // a recovery handle, not a claim of provider-side idempotency or safe replay.
  const merchantRef = randomUUID().replaceAll('-', '');
  if (row) {
    const { data, error } = await db.from('meetup_payments')
      .update({ status: 'pending', amount_paise: amount, pine_order_id: null, redirect_url: null, merchant_order_reference: merchantRef })
      .eq('id', row.id).eq('updated_at', row.updated_at).eq('status', row.status).select(cols).maybeSingle();
    if (missingSchema(error)) throw new PaymentSetupError();
    if (error) throw new HttpError(503, reconcileMessage);
    if (!data) throw new HttpError(409, 'Payment changed. Check payment status before continuing.');
    row = data as PaymentRow;
  } else {
    const { data, error } = await db.from('meetup_payments')
      .insert({ meetup_id: room.id, attendee_id: me.id, amount_paise: amount, status: 'pending', merchant_order_reference: merchantRef })
      .select(cols).single();
    if (error?.code === '23505') throw new HttpError(409, 'Payment is already being created. Check payment status.');
    if (missingSchema(error)) throw new PaymentSetupError();
    if (error || !data) throw new HttpError(503, reconcileMessage);
    row = data as PaymentRow;
  }

  const { error: receiptError } = await db.from('meetup_payment_attempts').insert({
    merchant_order_reference: merchantRef, payment_id: row.id, amount_paise: amount,
  });
  if (missingSchema(receiptError)) throw new PaymentSetupError();
  if (receiptError) throw new HttpError(503, reconcileMessage);

  const { data: guest } = await db.from('meetup_attendees').select('guest_name').eq('id', me.id).single();
  let order: Order;
  try {
    order = await createOrder({
      amountPaise: amount, merchantRef,
      // Configure NEXT_PUBLIC_SITE_URL in production; otherwise this uses Host.
      callbackUrl: `${roomUrl(req, token)}?payment=done`,
      guestName: guest?.guest_name ?? 'Guest',
    });
  } catch {
    // An exception includes timeouts, lost responses and malformed success
    // bodies. None proves that the provider did not create a payable order.
    try {
      await db.from('meetup_payment_attempts').update({ state: 'uncertain' })
        .eq('merchant_order_reference', merchantRef).eq('payment_id', row.id).is('pine_order_id', null);
    } catch { /* The durable claim still blocks all automatic retries. */ }
    throw new HttpError(502, reconcileMessage);
  }

  // Keep a separate durable receipt first. If the payment-row save fails, a
  // later authenticated GET/POST can attach this same order, never create anew.
  if (await saveReceipt(row, order) === false) throw new HttpError(503, reconcileMessage);
  const saved = await saveOrder(row, order);
  if (!saved) throw new HttpError(503, reconcileMessage);
  return readyResponse(view(saved), 201);
});
