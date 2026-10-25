import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

// UPI settle-up through the real room routes over in-memory PostgreSQL with
// every authored migration. No network, payment provider or UPI app is involved.
const deps = vi.hoisted(() => ({ admin: null, userClient: null, cookies: null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => deps.cookies() }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.admin }));
vi.mock('@/lib/supabase/server', () => ({ userClient: (req) => deps.userClient(req) }));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn(), limitUser: vi.fn(), rateLimit: vi.fn(), LIMITS: {} }));

import { splitPaise, upiUri, settleView, VPA_RE } from '../lib/settle';
import { GET as viewRoom } from '../app/api/rooms/[token]/route';
import { POST as joinRoom } from '../app/api/rooms/[token]/join/route';
import { POST as closeRoom } from '../app/api/rooms/[token]/close/route';
import { POST as startSettle, DELETE as stopSettle } from '../app/api/rooms/[token]/settle/route';
import { POST as claimPaid, DELETE as unclaimPaid } from '../app/api/rooms/[token]/settle/paid/route';
import { POST as confirmPaid } from '../app/api/rooms/[token]/settle/confirm/route';

let db, tenants;
const requestStorage = new AsyncLocalStorage();
const browser = () => {
  const values = new Map();
  return { values, get: (n) => (values.has(n) ? { value: values.get(n) } : undefined), set(n, v) { values.set(n, v); } };
};
function invoke(handler, { session = browser(), token = tenants.alice.meetup.room_token, uid, body, method = 'GET' } = {}) {
  const headers = new Headers();
  if (uid) headers.set('x-test-user', uid);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const request = new Request(`https://example.test/api/rooms/${token}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return requestStorage.run(session, () => handler(request, { params: Promise.resolve({ token }) }));
}
const organizer = () => identities.alice;
const collect = { upi_vpa: 'alice.k@okhdfcbank', upi_payee: 'Alice', amount_paise: 75000 };
async function join(session, name) {
  const r = await invoke(joinRoom, { session, method: 'POST', body: { guest_name: name } });
  expect(r.status).toBe(201);
  return r.json();
}
const settlements = () => asRole(db, 'service_role', null, (tx) => tx.query('select attendee_id, status, amount_paise, confirmed_at from meetup_settlements order by claimed_at'));

beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
beforeEach(async () => {
  tenants = await seedPrivateData(db);
  deps.admin = pgliteClient(db, 'service_role');
  deps.userClient = (req) => {
    const uid = req.headers.get('x-test-user');
    return pgliteClient(db, uid ? 'authenticated' : 'anon', uid, { organizerQueries: true });
  };
  deps.cookies = () => requestStorage.getStore();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await db?.close(); });

describe('settle-up helpers', () => {
  it('splits a bill rounding up to the rupee so the organiser is never short', () => {
    expect(splitPaise(438000, 6)).toBe(73000);
    expect(splitPaise(100000, 3)).toBe(33400);
    expect(() => splitPaise(100, 0)).toThrow();
  });
  it('builds an encoded upi://pay link and refuses bad handles', () => {
    const uri = upiUri('alice.k@okhdfcbank', 'Alice & Co', 75050, 'Friday <b>dinner</b> & drinks!');
    expect(uri.startsWith('upi://pay?')).toBe(true);
    const q = new URLSearchParams(uri.slice('upi://pay?'.length));
    expect(Object.fromEntries(q)).toEqual({ pa: 'alice.k@okhdfcbank', pn: 'Alice & Co', am: '750.50', cu: 'INR', tn: 'Friday bdinnerb drinks' });
    expect(uri).not.toContain('+');
    expect(() => upiUri('javascript:alert(1)', 'x', 100, 'x')).toThrow();
    for (const bad of ['a@', '@bank', 'a b@bank', 'x@1bank', 'a@b']) expect(VPA_RE.test(bad)).toBe(false);
  });
  it('hides the UPI ID from people who have not joined', () => {
    const cfg = { upi_vpa: 'a.b@ybl', upi_payee: 'A', settle_amount_paise: 1000 };
    expect(settleView(cfg, [], { title: 't', canSeeVpa: false })).toMatchObject({ upi_vpa: null, upi_uri: null, amount_paise: 1000 });
    expect(settleView(cfg, [], { title: 't', canSeeVpa: true }).upi_vpa).toBe('a.b@ybl');
    expect(settleView({ upi_vpa: null, upi_payee: null, settle_amount_paise: null }, [], { title: 't', canSeeVpa: true })).toBeNull();
  });
});

describe('UPI settle-up routes', () => {
  it('runs the whole loop: organiser collects, guest claims, organiser confirms', async () => {
    const guest = browser();
    const g = await join(guest, 'Guest A');
    expect(g.room.settle_up).toBeNull();

    const started = await invoke(startSettle, { uid: organizer(), method: 'POST', body: collect });
    expect(started.status).toBe(200);
    expect((await started.json()).settle_up).toMatchObject({ amount_paise: 75000, payee: 'Alice', upi_vpa: collect.upi_vpa });

    // Joined guest sees the UPI ID and pay link; a stranger only sees that money is being collected.
    const mine = await (await invoke(viewRoom, { session: guest })).json();
    expect(mine.settle_up.upi_uri).toContain('pa=alice.k%40okhdfcbank');
    expect(mine.settle_up.upi_uri).toContain('am=750.00');
    const stranger = await (await invoke(viewRoom)).json();
    expect(stranger.settle_up).toMatchObject({ upi_vpa: null, upi_uri: null });
    expect(JSON.stringify(stranger)).not.toContain('okhdfcbank');

    const claimed = await invoke(claimPaid, { session: guest, method: 'POST' });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).settle_up.status).toEqual({ [g.attendee_id]: 'claimed' });
    // A repeat tap is a no-op.
    expect((await invoke(claimPaid, { session: guest, method: 'POST' })).status).toBe(200);
    expect((await settlements()).rows).toHaveLength(1);

    const confirmed = await invoke(confirmPaid, { uid: organizer(), method: 'POST', body: { attendee_id: g.attendee_id, confirmed: true } });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).settle_up.status).toEqual({ [g.attendee_id]: 'confirmed' });
    // The guest cannot withdraw a confirmed share.
    await invoke(unclaimPaid, { session: guest, method: 'DELETE' });
    expect((await settlements()).rows).toEqual([expect.objectContaining({ status: 'confirmed', amount_paise: 75000 })]);
  });

  it('lets the guest undo a mistaken claim and the organiser mark "not received"', async () => {
    const guest = browser();
    const g = await join(guest, 'Guest A');
    await invoke(startSettle, { uid: organizer(), method: 'POST', body: collect });
    await invoke(claimPaid, { session: guest, method: 'POST' });
    await invoke(unclaimPaid, { session: guest, method: 'DELETE' });
    expect((await settlements()).rows).toEqual([]);
    await invoke(claimPaid, { session: guest, method: 'POST' });
    await invoke(confirmPaid, { uid: organizer(), method: 'POST', body: { attendee_id: g.attendee_id, confirmed: false } });
    expect((await settlements()).rows).toEqual([]);
  });

  it('lets the organiser mark cash or untracked payments as received', async () => {
    const g = await join(browser(), 'Guest A');
    await invoke(startSettle, { uid: organizer(), method: 'POST', body: collect });
    const r = await invoke(confirmPaid, { uid: organizer(), method: 'POST', body: { attendee_id: g.attendee_id, confirmed: true } });
    expect(r.status).toBe(200);
    expect((await settlements()).rows).toEqual([expect.objectContaining({ status: 'confirmed', amount_paise: 75000 })]);
  });

  it('keeps settling possible after the room is closed', async () => {
    const guest = browser();
    await join(guest, 'Guest A');
    expect((await invoke(closeRoom, { uid: organizer(), method: 'POST' })).status).toBe(200);
    expect((await invoke(startSettle, { uid: organizer(), method: 'POST', body: collect })).status).toBe(200);
    expect((await invoke(claimPaid, { session: guest, method: 'POST' })).status).toBe(200);
  });

  it('refuses everyone but the organiser and joined guests', async () => {
    const g = await join(browser(), 'Guest A');
    // Signed out, another account, and a guest cannot start collecting or confirm.
    expect((await invoke(startSettle, { method: 'POST', body: collect })).status).toBe(401);
    expect((await invoke(startSettle, { uid: identities.bob, method: 'POST', body: collect })).status).toBe(403);
    await invoke(startSettle, { uid: organizer(), method: 'POST', body: collect });
    expect((await invoke(confirmPaid, { uid: identities.bob, method: 'POST', body: { attendee_id: g.attendee_id, confirmed: true } })).status).toBe(403);
    expect((await invoke(stopSettle, { uid: identities.bob, method: 'DELETE' })).status).toBe(403);
    // Not joined: no claim.
    expect((await invoke(claimPaid, { method: 'POST' })).status).toBe(401);
    // An attendee from another room cannot be confirmed here.
    const other = await (await invoke(joinRoom, { token: tenants.bob.meetup.room_token, method: 'POST', body: { guest_name: 'Elsewhere' } })).json();
    expect((await invoke(confirmPaid, { uid: organizer(), method: 'POST', body: { attendee_id: other.attendee_id, confirmed: true } })).status).toBe(404);
    expect((await settlements()).rows).toEqual([]);
  });

  it('validates the UPI ID and amount, and claims need an active collection', async () => {
    const guest = browser();
    await join(guest, 'Guest A');
    expect((await invoke(claimPaid, { session: guest, method: 'POST' })).status).toBe(409);
    for (const body of [{ ...collect, upi_vpa: 'not-a-vpa' }, { ...collect, upi_vpa: 'javascript:x@y' }, { ...collect, amount_paise: 50 }, { ...collect, amount_paise: 1.5 }, { ...collect, upi_payee: '' }]) {
      expect((await invoke(startSettle, { uid: organizer(), method: 'POST', body })).status).toBe(400);
    }
    await invoke(startSettle, { uid: organizer(), method: 'POST', body: collect });
    const stopped = await invoke(stopSettle, { uid: organizer(), method: 'DELETE' });
    expect((await stopped.json()).settle_up).toBeNull();
    expect((await invoke(claimPaid, { session: guest, method: 'POST' })).status).toBe(409);
  });
});

describe('settle-up schema', () => {
  it('rejects half-configured collections and direct writes by guests or other organisers', async () => {
    const id = tenants.alice.meetup.id;
    await expect(asRole(db, 'service_role', null, (tx) => tx.query("update meetups set upi_vpa='a.b@ybl' where id=$1", [id]))).rejects.toThrow();
    await expect(asRole(db, 'service_role', null, (tx) => tx.query("update meetups set upi_vpa='bad', upi_payee='A', settle_amount_paise=1000 where id=$1", [id]))).rejects.toThrow();
    const g = await join(browser(), 'Guest A');
    await expect(asRole(db, 'anon', null, (tx) => tx.query('insert into meetup_settlements (meetup_id, attendee_id, amount_paise) values ($1,$2,100)', [id, g.attendee_id]))).rejects.toThrow();
    await expect(asRole(db, 'authenticated', identities.alice, (tx) => tx.query('insert into meetup_settlements (meetup_id, attendee_id, amount_paise) values ($1,$2,100)', [id, g.attendee_id]))).rejects.toThrow();
    await asRole(db, 'service_role', null, (tx) => tx.query('insert into meetup_settlements (meetup_id, attendee_id, amount_paise) values ($1,$2,100)', [id, g.attendee_id]));
    expect((await asRole(db, 'authenticated', identities.alice, (tx) => tx.query('select * from meetup_settlements'))).rows).toHaveLength(1);
    expect((await asRole(db, 'authenticated', identities.bob, (tx) => tx.query('select * from meetup_settlements'))).rows).toHaveLength(0);
    // Attendee must belong to the meetup.
    await expect(asRole(db, 'service_role', null, (tx) => tx.query('insert into meetup_settlements (meetup_id, attendee_id, amount_paise) values ($1,$2,100)', [tenants.bob.meetup.id, g.attendee_id]))).rejects.toThrow('attendee not in meetup');
  });
});
