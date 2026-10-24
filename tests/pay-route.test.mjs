import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  db: null,
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  getOrderStatus: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ userClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.db }));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn() }));
vi.mock('@/lib/room', () => ({
  getRoom: async () => ({ id: 'room', status: 'open', final_venue_id: 'venue' }),
  requireGuest: async () => ({ id: 'guest' }),
  requireOpen: vi.fn(),
}));
vi.mock('@/lib/pinelabs', () => ({
  amountPaise: (price) => price * 100,
  isConfigured: () => true,
  createOrder: deps.createOrder,
  cancelOrder: deps.cancelOrder,
  getOrderStatus: deps.getOrderStatus,
}));

import { HttpError } from '../lib/http';
import { POST } from '../app/api/rooms/[token]/pay/route';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let now;
let payment;
let version;
let venuePrice;
// In-memory query builder implements compare-and-swap filters, not real DB calls.
function database() {
  return { from(table) {
    let operation = 'read';
    let values;
    const filters = [];
    const query = {
      select() { return query; },
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
          if (operation === 'insert') {
            payment = { id: 'payment', status: 'pending', pine_order_id: null, redirect_url: null, ...values,
              updated_at: new Date(now + version++).toISOString() };
          } else if (operation === 'update') {
            if (!payment || filters.some(([key, value]) => payment[key] !== value)) return { data: null, error: null };
            payment = { ...payment, ...values, updated_at: new Date(now + version++).toISOString() };
          }
          return { data: payment ? { ...payment } : null, error: null };
        };
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return query;
  } };
}

const post = () => POST(new Request('https://example.test/api/rooms/token/pay', { method: 'POST' }), { params: Promise.resolve({ token: 'token' }) });
const order = (id) => ({ orderId: id, redirectUrl: `https://pay.example/${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  now = Date.parse('2026-10-24T12:00:00Z');
  version = 0;
  venuePrice = 500;
  payment = null;
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

  it('does not let a late order overwrite a newer checkout', async () => {
    const slow = deferred();
    const started = deferred();
    deps.createOrder.mockImplementationOnce(() => { started.resolve(); return slow.promise; })
      .mockResolvedValueOnce(order('B'));
    const first = post();
    await started.promise;
    now += 120_001;
    const second = await post();
    expect(second.status).toBe(201);
    expect((await second.json()).payment.redirect_url).toBe('https://pay.example/B');
    slow.resolve(order('A'));
    const stale = await first;
    expect(stale.status).toBe(409);
    expect(payment.pine_order_id).toBe('B');
    expect(deps.cancelOrder).toHaveBeenCalledWith('A');
  });

  it('does not let a late failure invalidate a newer in-flight claim', async () => {
    const firstOrder = deferred(), secondOrder = deferred();
    const firstStarted = deferred(), secondStarted = deferred();
    deps.createOrder.mockImplementationOnce(() => { firstStarted.resolve(); return firstOrder.promise; })
      .mockImplementationOnce(() => { secondStarted.resolve(); return secondOrder.promise; });
    const first = post();
    await firstStarted.promise;
    now += 120_001;
    const second = post();
    await secondStarted.promise;
    firstOrder.reject(new Error('First provider request failed'));
    expect((await first).status).toBe(500);
    expect(payment.status).toBe('pending');
    secondOrder.resolve(order('B'));
    expect((await second).status).toBe(201);
    expect(payment.pine_order_id).toBe('B');
  });

  it('preserves the old checkout when cancellation for a changed amount fails', async () => {
    deps.createOrder.mockResolvedValue(order('A'));
    expect((await post()).status).toBe(201);
    const original = { ...payment };
    venuePrice = 800;
    deps.cancelOrder.mockRejectedValueOnce(new HttpError(502, 'Cancellation unconfirmed'));
    expect((await post()).status).toBe(502);
    expect(payment).toEqual(original);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
  });

});
