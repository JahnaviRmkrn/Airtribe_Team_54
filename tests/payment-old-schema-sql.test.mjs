import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const deps = vi.hoisted(() => ({ db: null, room: null, guest: null, create: vi.fn(), status: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ userClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.db }));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn() }));
vi.mock('@/lib/room', () => ({ getRoom: async () => deps.room, requireGuest: async () => ({ id: deps.guest }), requireOpen: vi.fn() }));
vi.mock('@/lib/pinelabs', () => ({ amountPaise: price => price * 100, isConfigured: () => true, createOrder: deps.create, getOrderStatus: deps.status }));
import { GET, POST } from '../app/api/rooms/[token]/pay/route';
let db;
const service = (sql, values = []) => asRole(db, 'service_role', null, tx => tx.query(sql, values));
const invoke = handler => handler(new Request('http://localhost/api/rooms/synthetic/pay', { method: handler === POST ? 'POST' : 'GET' }), { params: Promise.resolve({ token: 'synthetic' }) });
beforeAll(async () => { db = await privacyDatabase({ beforeMigration: '20261025120000' }); }, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in old-schema tests'); }));
  const tenants = await seedPrivateData(db);
  deps.room = { ...tenants.alice.meetup, final_venue_id: identities.venue };
  deps.guest = (await service('insert into meetup_attendees(meetup_id, guest_name, secret_hash) values ($1, $2, $3) returning id',
    [deps.room.id, 'Synthetic guest', 'synthetic-not-a-secret'])).rows[0].id;
  deps.db = pgliteClient(db, 'service_role');
  deps.status.mockResolvedValue('paid');
});
afterEach(() => vi.unstubAllGlobals());

describe('actual database without payment receipts or readiness migrations', () => {
  it('shows setup-required for no payment and never inserts a claim on repeated POST', async () => {
    expect((await (await invoke(GET)).json()).checkout_availability).toBe('setup_required');
    expect((await invoke(POST)).status).toBe(503);
    expect((await invoke(POST)).status).toBe(503);
    expect((await service('select * from meetup_payments')).rows).toEqual([]);
    expect(deps.create).not.toHaveBeenCalled();
  });
  it.each(['pending', 'paid'])('reads legacy %s payment status without mutating the old database', async status => {
    await service(`insert into meetup_payments(meetup_id, attendee_id, amount_paise, status, pine_order_id, redirect_url)
      values ($1, $2, 50000, $3, 'synthetic-old-order', 'https://pay.example/old')`, [deps.room.id, deps.guest, status]);
    const before = (await service('select * from meetup_payments')).rows;
    const response = await invoke(GET);
    expect(response.status).toBe(200);
    expect((await response.json())).toMatchObject({ checkout_availability: 'setup_required', payment: { status: 'paid', redirect_url: null } });
    expect((await service('select * from meetup_payments')).rows).toEqual(before);
    expect(deps.status).toHaveBeenCalledTimes(status === 'pending' ? 1 : 0);
    expect(deps.create).not.toHaveBeenCalled();
  });
});
