import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  db: null,
  guestId: 'guest',
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  getOrderStatus: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ userClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.db }));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn() }));
vi.mock('@/lib/room', () => ({
  getRoom: async () => ({ id: 'room', status: 'open', final_venue_id: 'venue' }),
  requireGuest: async () => ({ id: deps.guestId }),
  requireOpen: vi.fn(),
}));
vi.mock('@/lib/pinelabs', () => ({
  amountPaise: (price) => price * 100,
  isConfigured: () => true,
  createOrder: deps.createOrder,
  cancelOrder: deps.cancelOrder,
  getOrderStatus: deps.getOrderStatus,
}));

import { GET, POST } from '../app/api/rooms/[token]/pay/route';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let now;
let payment;
let version;
let venuePrice;
let receipts;
let faults;
let missingReference;
let missingReceipts;
let writes;
// In-memory query builder implements compare-and-swap filters, not real DB calls.
function database() {
  return { rpc: deps.readiness, from(table) {
    let operation = 'read';
    let values, columns;
    const filters = [];
    const query = {
      select(value) { columns = value; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      is(key, value) { filters.push([key, value]); return query; },
      update(data) { operation = 'update'; values = data; return query; },
      insert(data) { operation = 'insert'; values = data; return query; },
      single() { return query; },
      maybeSingle() { return query; },
      then(resolve, reject) {
        const run = () => {
          if (table === 'venues') return { data: { price_per_person: venuePrice }, error: null };
          if (table === 'meetup_attendees') return { data: { guest_name: 'Guest' }, error: null };
          if (operation !== 'read') writes.push({ table, operation });
          if ((missingReference && columns?.includes('merchant_order_reference')) || (missingReceipts && table === 'meetup_payment_attempts')) {
            return { data: null, error: { code: missingReference ? '42703' : '42P01', message: 'Synthetic missing private schema detail' } };
          }
          const isReceipt = table === 'meetup_payment_attempts';
          const rows = isReceipt ? [...receipts.values()] : payment ? [payment] : [];
          const matches = (row) => !filters.some(([key, value]) => row[key] !== value);
          let current = rows.find(matches) ?? null;
          const key = `${table}:${operation}${values?.pine_order_id ? ':order' : ''}`;
          const fault = faults[key]?.shift();
          const failure = () => {
            if (fault?.includes('throw')) throw new Error('Synthetic DB transport loss');
            return { data: null, error: fault?.includes('empty') ? null : { code: '08006', message: 'Synthetic DB response loss' } };
          };
          if (fault?.startsWith('before')) return failure();
          if (operation === 'insert') {
            if ((!isReceipt && payment) || (isReceipt && receipts.has(values.merchant_order_reference))) {
              return { data: null, error: { code: '23505' } };
            }
            current = isReceipt
              ? { state: 'creating', pine_order_id: null, redirect_url: null, ...values,
                  created_at: new Date(now).toISOString() }
              : { id: 'payment', status: 'pending', pine_order_id: null, redirect_url: null, ...values };
          } else if (operation === 'update') {
            if (!current) return { data: null, error: null };
            current = { ...current, ...values };
          }
          if (operation !== 'read') {
            current.updated_at = new Date(now + version++).toISOString();
            if (isReceipt) receipts.set(current.merchant_order_reference, current);
            else payment = current;
          }
          if (fault?.startsWith('after')) return failure();
          return { data: current ? { ...current } : null, error: null };
        };
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return query;
  } };
}

const post = () => POST(new Request('https://example.test/api/rooms/token/pay', { method: 'POST' }), { params: Promise.resolve({ token: 'token' }) });
const get = () => GET(new Request('https://example.test/api/rooms/token/pay'), { params: Promise.resolve({ token: 'token' }) });
const order = (id) => ({ orderId: id, redirectUrl: `https://pay.example/${id}` });

beforeEach(() => {
  vi.resetAllMocks();
  now = Date.parse('2026-10-24T12:00:00Z');
  version = 0;
  venuePrice = 500;
  payment = null;
  receipts = new Map();
  faults = {};
  missingReference = false; missingReceipts = false; writes = [];
  deps.readiness.mockResolvedValue({ data: true, error: null });
  deps.guestId = 'guest';
  deps.db = database();
  deps.cancelOrder.mockResolvedValue(undefined);
  deps.getOrderStatus.mockResolvedValue('pending');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('payment creation claim fencing', () => {
  it('creates and reuses one checkout for repeated requests', async () => {
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(200);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(payment.pine_order_id).toBe('A');
  });

  it('never reclaims a slow provider attempt just because two minutes elapsed', async () => {
    const slow = deferred(), started = deferred();
    deps.createOrder.mockImplementationOnce(() => { started.resolve(); return slow.promise; })
      .mockResolvedValueOnce(order('B'));
    const first = post();
    await started.promise;
    now += 120_001;
    expect((await post()).status).toBe(409);
    slow.resolve(order('A'));
    expect((await first).status).toBe(201);
    expect(payment.pine_order_id).toBe('A');
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(deps.cancelOrder).not.toHaveBeenCalled();
  });

  it('does not retry an upstream order whose response was lost', async () => {
    // The provider created A before the transport lost its response.
    const remotelyCreated = [];
    deps.createOrder.mockImplementation(async () => {
      remotelyCreated.push('A');
      throw new Error('Synthetic connection reset after provider committed');
    });
    const first = await post();
    expect(first.status).toBe(502);
    expect((await first.json()).error).toContain('Do not pay again');
    now += 120_001;
    expect((await post()).status).toBe(409);
    expect(remotelyCreated).toEqual(['A']);
    expect(payment.status).toBe('pending');
    expect(deps.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['after-error', 'after-empty', 'after-throw'])('recovers a committed payment save with a lost acknowledgement (%s)', async fault => {
    faults['meetup_payments:update:order'] = [fault];
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(200);
    expect(payment.pine_order_id).toBe('A');
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(deps.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['before-error', 'after-error', 'after-empty', 'after-throw'])('recovers a receipt write failure without another provider call (%s)', async fault => {
    faults['meetup_payment_attempts:update:order'] = [fault];
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(201);
    expect([...receipts.values()][0].pine_order_id).toBe('A');
    expect((await post()).status).toBe(200);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(deps.cancelOrder).not.toHaveBeenCalled();
  });

  it('keeps the claim when both payment write and read acknowledgements are unavailable', async () => {
    deps.createOrder.mockImplementation(async () => {
      faults['meetup_payments:update:order'] = ['after-error'];
      faults['meetup_payments:read'] = ['before-error'];
      return order('A');
    });
    expect((await post()).status).toBe(503);
    expect(payment.pine_order_id).toBe('A');
    expect((await post()).status).toBe(200);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(deps.cancelOrder).not.toHaveBeenCalled();
  });

  it('recovers the same known order from its durable receipt after payment writes fail', async () => {
    faults['meetup_payments:update:order'] = ['before-error', 'before-error'];
    deps.createOrder.mockResolvedValue(order('A'));
    const first = await post();
    expect(first.status).toBe(503);
    expect((await first.json()).error).toContain('Do not pay again');
    expect(payment.pine_order_id).toBeNull();
    expect([...receipts.values()][0].pine_order_id).toBe('A');
    now += 120_001;
    const recovered = await get();
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).payment.redirect_url).toBe(order('A').redirectUrl);
    expect((await post()).status).toBe(200);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(deps.cancelOrder).not.toHaveBeenCalled();
  });

  it('retains a pre-call merchant reference if every post-provider save fails', async () => {
    faults['meetup_payments:update:order'] = ['before-error', 'before-error'];
    faults['meetup_payment_attempts:update:order'] = ['before-error', 'before-error'];
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(503);
    const reference = payment.merchant_order_reference;
    expect(deps.createOrder.mock.calls[0][0].merchantRef).toBe(reference);
    expect(receipts.get(reference).state).toBe('creating');
    now += 120_001;
    expect((await post()).status).toBe(409);
    const response = await get();
    expect((await response.json()).payment.checkout_state).toBe('reconciliation_required');
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect(deps.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['before-error', 'after-error', 'after-throw'])('does not call provider when attempt reservation is not acknowledged (%s)', async fault => {
    faults['meetup_payment_attempts:insert'] = [fault];
    await post();
    now += 120_001;
    expect((await post()).status).toBe(409);
    expect(deps.createOrder).not.toHaveBeenCalled();
    expect(payment.merchant_order_reference).toMatch(/^[a-f0-9]{32}$/);
  });

  it('does not retry legacy unknown failed rows without a provider order ID', async () => {
    payment = { id: 'payment', meetup_id: 'room', attendee_id: 'guest', status: 'failed', amount_paise: 50000,
      pine_order_id: null, redirect_url: null, merchant_order_reference: null, updated_at: new Date(now - 999_999).toISOString() };
    expect((await post()).status).toBe(409);
    expect(deps.createOrder).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'])('permits a fresh attempt only after provider-confirmed %s', async status => {
    deps.createOrder.mockResolvedValueOnce(order('A')).mockResolvedValueOnce(order('B'));
    expect((await post()).status).toBe(201);
    const firstRef = payment.merchant_order_reference;
    deps.getOrderStatus.mockResolvedValueOnce(status);
    expect((await post()).status).toBe(201);
    expect(payment.pine_order_id).toBe('B');
    expect(payment.merchant_order_reference).not.toBe(firstRef);
    expect(receipts.get(firstRef).pine_order_id).toBe('A');
    expect(receipts.size).toBe(2);
    expect(deps.createOrder).toHaveBeenCalledTimes(2);
  });

  it('never re-creates after provider-confirmed payment', async () => {
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(201);
    deps.getOrderStatus.mockResolvedValue('paid');
    expect((await post()).status).toBe(200);
    expect(payment.status).toBe('paid');
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
  });

  it('preserves the old payable checkout when the venue amount changes', async () => {
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(201);
    const original = { ...payment };
    venuePrice = 800;
    expect((await post()).status).toBe(409);
    expect(deps.cancelOrder).not.toHaveBeenCalled();
    expect(payment).toEqual(original);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
  });

});


describe('payment guest ownership', () => {
  it('returns only guest-safe payment fields, never merchant references or receipt details', async () => {
    deps.createOrder.mockResolvedValue(order('A'));
    const response = await post();
    expect(await response.json()).toEqual({ checkout_availability: 'ready', payment: {
      status: 'pending', amount_paise: 50000, redirect_url: order('A').redirectUrl, checkout_state: 'ready',
    } });
  });

  it('does not expose another guest checkout or query its provider status', async () => {
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(201);
    deps.guestId = 'other-guest';
    const response = await GET(new Request('https://example.test/api/rooms/token/pay'), { params: Promise.resolve({ token: 'token' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ payment: null, checkout_availability: 'ready' });
    expect(deps.getOrderStatus).not.toHaveBeenCalled();
  });
});


describe('payment schema rollout readiness', () => {
  const oldPayment = (status = 'pending', id = 'legacy-order') => ({
    id: 'payment', meetup_id: 'room', attendee_id: 'guest', status, amount_paise: 50000,
    pine_order_id: id, redirect_url: id ? 'https://pay.example/legacy' : null,
    updated_at: new Date(now).toISOString(),
  });
  it.each(['PGRST202', '42883'])('blocks creation before any write for a missing readiness RPC (%s)', async code => {
    deps.readiness.mockResolvedValue({ data: null, error: { code, message: 'private schema details' } });
    for (let i = 0; i < 2; i++) {
      const response = await post();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: expect.stringContaining('operator completes the payment safety upgrade') });
    }
    expect(writes).toEqual([]);
    expect(deps.createOrder).not.toHaveBeenCalled();
    expect(deps.getOrderStatus).not.toHaveBeenCalled();
  });
  it.each(['pending', 'paid'])('keeps legacy %s status available with no schema/provider writes or checkout links', async status => {
    missingReference = true;
    payment = oldPayment(status);
    const original = { ...payment };
    deps.readiness.mockResolvedValue({ data: false, error: null });
    deps.getOrderStatus.mockResolvedValue('paid');
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      payment: { status: 'paid', amount_paise: 50000, redirect_url: null, checkout_state: 'ready' },
      checkout_availability: 'setup_required', message: expect.stringContaining('operator completes'),
    });
    expect(payment).toEqual(original);
    expect(writes).toEqual([]);
    expect(deps.getOrderStatus).toHaveBeenCalledTimes(status === 'pending' ? 1 : 0);
    expect(deps.createOrder).not.toHaveBeenCalled();
  });
  it('detects a missing reference column even after a stale successful probe and reads legacy status only', async () => {
    missingReference = true;
    payment = oldPayment();
    const response = await get();
    expect((await response.json()).checkout_availability).toBe('setup_required');
    expect((await post()).status).toBe(503);
    expect(writes).toEqual([]);
    expect(deps.createOrder).not.toHaveBeenCalled();
  });
  it('keeps an old schema with no payment explicit and unavailable, without creating a claim', async () => {
    missingReference = true;
    deps.readiness.mockResolvedValue({ data: false, error: null });
    const body = await (await get()).json();
    expect(body.payment).toBeNull();
    expect(body.checkout_availability).toBe('setup_required');
    expect((await post()).status).toBe(503);
    expect(writes).toEqual([]);
  });
  it('does not turn a legacy unknown outcome into permission for a new payment', async () => {
    payment = oldPayment('failed', null);
    deps.readiness.mockResolvedValue({ data: false, error: null });
    const body = await (await get()).json();
    expect(body.payment.checkout_state).toBe('reconciliation_required');
    expect((await post()).status).toBe(503);
    expect(writes).toEqual([]);
    expect(deps.getOrderStatus).not.toHaveBeenCalled();
    expect(deps.createOrder).not.toHaveBeenCalled();
  });
  it('stops before provider creation if the receipts table disappears after the probe', async () => {
    missingReceipts = true;
    expect((await post()).status).toBe(503);
    expect(deps.createOrder).not.toHaveBeenCalled();
    const body = await (await get()).json();
    expect(body.checkout_availability).toBe('setup_required');
    expect(body.payment.checkout_state).toBe('reconciliation_required');
  });
  it.each([
    { data: null, error: { code: '08006', message: 'lost acknowledgement' } },
    { data: null, error: null },
    { data: null, error: { message: 'unknown schema failure' } },
  ])('does not misclassify an inconclusive readiness result as setup-needed', async result => {
    deps.readiness.mockResolvedValue(result);
    for (const invoke of [get, post]) {
      const response = await invoke();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: expect.stringContaining('temporarily unavailable') });
    }
    expect(writes).toEqual([]);
    expect(deps.createOrder).not.toHaveBeenCalled();
  });
  it('does not retry or misclassify a thrown readiness transport failure', async () => {
    deps.readiness.mockRejectedValue(new Error('lost read acknowledgement'));
    const body = await (await get()).json();
    expect(body.error).toContain('temporarily unavailable');
    expect(body.checkout_availability).toBeUndefined();
    expect(deps.readiness).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
  it('does not misclassify a lost legacy status read as a confirmed setup result', async () => {
    deps.readiness.mockResolvedValue({ data: false, error: null });
    faults['meetup_payments:read'] = ['before-error'];
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringContaining('temporarily unavailable') });
  });
});
