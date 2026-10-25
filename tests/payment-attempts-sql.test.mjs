import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const deps = vi.hoisted(() => ({ admin: null, createOrder: vi.fn(), getOrderStatus: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.admin }));
vi.mock('@/lib/supabase/server', () => ({ userClient: vi.fn() }));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn() }));
vi.mock('@/lib/pinelabs', () => ({
  amountPaise: (price) => price * 100, isConfigured: () => true,
  createOrder: deps.createOrder, getOrderStatus: deps.getOrderStatus,
}));
import { hashSecret } from '../lib/room';
import { GET, POST } from '../app/api/rooms/[token]/pay/route';

let db, tenants, attendees;
const service = (sql, params = []) => asRole(db, 'service_role', null, (tx) => tx.query(sql, params));
const identityQuery = (uid, sql, params = []) => asRole(db, 'authenticated', uid, (tx) => tx.query(sql, params));
const secret = (name) => `synthetic-${name}-secret`;
function invoke(handler = GET, { who = 'alice', credential = secret(who) } = {}) {
  const token = tenants[who].meetup.room_token;
  return handler(new Request(`https://example.test/api/rooms/${token}/pay`, {
    method: handler === POST ? 'POST' : 'GET', headers: credential ? { 'x-guest-secret': credential } : {},
  }), { params: Promise.resolve({ token }) });
}
beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden in payment tests'); }));
  tenants = await seedPrivateData(db);
  attendees = {};
  deps.admin = pgliteClient(db, 'service_role');
  deps.getOrderStatus.mockResolvedValue('pending');
  deps.createOrder.mockImplementation(async ({ merchantRef, amountPaise }) => {
    // The exact reference/amount must already be committed BEFORE provider I/O.
    const receipt = (await service('select * from meetup_payment_attempts where merchant_order_reference = $1', [merchantRef])).rows[0];
    expect(receipt).toMatchObject({ state: 'creating', amount_paise: amountPaise, pine_order_id: null });
    return { orderId: `synthetic-${merchantRef}`, redirectUrl: `https://pay.example/${merchantRef}` };
  });
  for (const name of ['alice', 'bob']) {
    attendees[name] = (await service(`insert into meetup_attendees (meetup_id, guest_name, secret_hash)
      values ($1, $2, $3) returning id`, [tenants[name].meetup.id, `Synthetic ${name}`, hashSecret(secret(name))])).rows[0].id;
    await service('update meetups set final_venue_id = $1 where id = $2', [identities.venue, tenants[name].meetup.id]);
  }
});
afterEach(() => vi.unstubAllGlobals());

describe('payment attempts with real PostgreSQL receipts and authorization', () => {
  it('persists the recovery handle before calling provider and resumes without duplicate creation', async () => {
    expect((await invoke(POST)).status).toBe(201);
    expect((await invoke(POST)).status).toBe(200);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    const payment = (await service('select * from meetup_payments')).rows[0];
    const receipt = (await service('select * from meetup_payment_attempts')).rows[0];
    expect(receipt).toMatchObject({ merchant_order_reference: payment.merchant_order_reference,
      payment_id: payment.id, amount_paise: 50000, state: 'received', pine_order_id: payment.pine_order_id });
  });

  it('concurrent initial requests reserve only one provider invocation', async () => {
    const responses = await Promise.all([invoke(POST), invoke(POST), invoke(POST)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
    expect((await service('select * from meetup_payment_attempts')).rows).toHaveLength(1);
  });

  it('rejects legacy timeout reclamation and false failed updates at the database boundary', async () => {
    deps.createOrder.mockRejectedValue(new Error('Synthetic provider outcome unknown'));
    expect((await invoke(POST)).status).toBe(502);
    for (const sql of [
      "update meetup_payments set status = 'pending', pine_order_id = null, redirect_url = null",
      "update meetup_payments set status = 'failed'",
      "update meetup_payments set merchant_order_reference = 'new-reference'",
      "update meetup_payments set pine_order_id = 'different', amount_paise = 1",
    ]) await expect(service(sql)).rejects.toThrow('payment_attempt_requires_reconciliation');
    expect((await invoke(POST)).status).toBe(409);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'cancelled'])('fences an old-version %s retry before provider invocation, but permits a fresh-reference retry', async status => {
    expect((await invoke(POST)).status).toBe(201);
    const original = (await service('select * from meetup_payments')).rows[0];
    deps.getOrderStatus.mockResolvedValueOnce(status);
    expect((await invoke()).status).toBe(200);
    const legacyCreate = vi.fn();
    const legacyRetry = async () => {
      // Exact previous-version claim: it clears the order but retains the
      // reference of terminal order A. If accepted, old code would create B
      // while new code could recover A's receipt and create C concurrently.
      await service(`update meetup_payments set status = 'pending', amount_paise = 50000,
        pine_order_id = null, redirect_url = null where id = $1 returning *`, [original.id]);
      legacyCreate();
    };
    await expect(legacyRetry()).rejects.toThrow('payment_retry_requires_fresh_reference');
    expect(legacyCreate).not.toHaveBeenCalled();
    expect((await service('select * from meetup_payments')).rows[0]).toMatchObject({
      status, pine_order_id: original.pine_order_id, merchant_order_reference: original.merchant_order_reference,
    });
    expect((await invoke(POST)).status).toBe(201);
    const replacement = (await service('select * from meetup_payments')).rows[0];
    expect(replacement.merchant_order_reference).toMatch(/^[a-f0-9]{32}$/);
    expect(replacement.merchant_order_reference).not.toBe(original.merchant_order_reference);
    expect(replacement.pine_order_id).not.toBe(original.pine_order_id);
    expect((await service('select * from meetup_payment_attempts')).rows).toHaveLength(2);
    expect(deps.createOrder).toHaveBeenCalledTimes(2);
  });

  it('rejects missing, blank and previously used references for terminal retries', async () => {
    expect((await invoke(POST)).status).toBe(201);
    const first = (await service('select * from meetup_payments')).rows[0];
    deps.getOrderStatus.mockResolvedValueOnce('failed');
    expect((await invoke(POST)).status).toBe(201);
    deps.getOrderStatus.mockResolvedValueOnce('cancelled');
    expect((await invoke()).status).toBe(200);
    const current = (await service('select * from meetup_payments')).rows[0];
    for (const reference of [null, '', '   ', first.merchant_order_reference, current.merchant_order_reference]) {
      await expect(service(`update meetup_payments set status = 'pending', pine_order_id = null,
        redirect_url = null, merchant_order_reference = $1 where id = $2`, [reference, current.id]))
        .rejects.toThrow('payment_retry_requires_fresh_reference');
    }
    // Legacy terminal rows may have no saved reference at all. Old code must
    // not be allowed to retry those with another null reference either.
    await service('update meetup_payments set merchant_order_reference = null where id = $1', [current.id]);
    await expect(service("update meetup_payments set status = 'pending', pine_order_id = null, redirect_url = null where id = $1", [current.id]))
      .rejects.toThrow('payment_retry_requires_fresh_reference');
    expect((await invoke(POST)).status).toBe(201);
    expect(deps.createOrder).toHaveBeenCalledTimes(3);
  });

  it('never frees an uncertain create, even after arbitrary elapsed time or a price change', async () => {
    deps.createOrder.mockRejectedValue(new Error('Synthetic lost provider response'));
    expect((await invoke(POST)).status).toBe(502);
    await service("update meetup_payment_attempts set created_at = now() - interval '1 day'");
    await service('update venues set price_per_person = 800');
    const result = await invoke();
    expect((await result.json()).payment).toEqual({
      status: 'pending', amount_paise: 50000, redirect_url: null, checkout_state: 'reconciliation_required',
    });
    expect((await invoke(POST)).status).toBe(409);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
  });

  it('recovers an acknowledged receipt without a payment-row ID, including after room closure', async () => {
    expect((await invoke(POST)).status).toBe(201);
    const original = (await service('select * from meetup_payments')).rows[0];
    // Models receipt commit followed by a process crash before payment-row save.
    await service('update meetup_payments set pine_order_id = null, redirect_url = null');
    await service("update meetups set status = 'closed' where id = $1", [tenants.alice.meetup.id]);
    const recovered = await invoke();
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).payment.redirect_url).toBe(original.redirect_url);
    expect((await invoke(POST)).status).toBe(410);
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
  });

  it('does not expose or recover another room or guest payment using a substituted guest credential', async () => {
    expect((await invoke(POST)).status).toBe(201);
    deps.getOrderStatus.mockClear();
    for (const credential of [null, 'forged', secret('bob')]) {
      expect((await invoke(GET, { credential })).status).toBe(401);
      expect((await invoke(POST, { credential })).status).toBe(401);
    }
    expect(await (await invoke(GET, { who: 'bob' })).json()).toEqual({ payment: null, checkout_availability: 'ready' });
    expect(deps.getOrderStatus).not.toHaveBeenCalled();
    expect(deps.createOrder).toHaveBeenCalledTimes(1);
  });

  it('allows only each organizer to read their own attempt references, never authenticated writes', async () => {
    for (const who of ['alice', 'bob']) expect((await invoke(POST, { who })).status).toBe(201);
    for (const who of ['alice', 'bob']) {
      const rows = (await identityQuery(identities[who], 'select * from meetup_payment_attempts')).rows;
      expect(rows).toHaveLength(1);
      const expectedPayment = (await service('select id from meetup_payments where attendee_id = $1', [attendees[who]])).rows[0];
      expect(rows[0].payment_id).toBe(expectedPayment.id);
      expect((await identityQuery(identities[who], "update meetup_payment_attempts set state = 'uncertain' returning *")).rows).toEqual([]);
      expect((await identityQuery(identities[who], 'delete from meetup_payment_attempts returning *')).rows).toEqual([]);
      await expect(identityQuery(identities[who], `insert into meetup_payment_attempts
        (merchant_order_reference, payment_id, amount_paise) values ('forged', $1, 1)`, [expectedPayment.id])).rejects.toThrow(/row-level security/);
    }
    expect((await asRole(db, 'anon', null, (tx) => tx.query('select * from meetup_payment_attempts'))).rows).toEqual([]);
  });

  it('rejects receipt replacement or identity changes, even via service role', async () => {
    expect((await invoke(POST)).status).toBe(201);
    await expect(service("update meetup_payment_attempts set pine_order_id = 'different-order'")).rejects.toThrow('payment_attempt_receipt_immutable');
    await expect(service("update meetup_payment_attempts set state = 'uncertain', pine_order_id = null, redirect_url = null")).rejects.toThrow('payment_attempt_receipt_immutable');
    await expect(service('update meetup_payment_attempts set amount_paise = 1')).rejects.toThrow('payment_attempt_identity_immutable');
    await expect(service("update meetup_payment_attempts set merchant_order_reference = 'different-reference'")).rejects.toThrow('payment_attempt_identity_immutable');
    expect((await invoke()).status).toBe(200);
  });

  it('does not bind a receipt from another payment, even if the active reference is corrupted', async () => {
    for (const who of ['alice', 'bob']) expect((await invoke(POST, { who })).status).toBe(201);
    const rows = (await service('select * from meetup_payments order by attendee_id')).rows;
    const a = rows.find((row) => row.attendee_id === attendees.alice);
    const b = rows.find((row) => row.attendee_id === attendees.bob);
    await service('update meetup_payments set merchant_order_reference = null where id = $1', [b.id]);
    await service('update meetup_payments set pine_order_id = null, redirect_url = null, merchant_order_reference = $1 where id = $2', [b.merchant_order_reference, a.id]);
    const result = await invoke();
    expect((await result.json()).payment).toMatchObject({ redirect_url: null, checkout_state: 'reconciliation_required' });
    expect((await invoke(POST)).status).toBe(409);
    expect(deps.createOrder).toHaveBeenCalledTimes(2);
  });
});


describe('payment rollout database contract', () => {
  it('exposes the readiness capability only to service_role', async () => {
    expect((await service('select public.payment_checkout_ready() as ready')).rows[0].ready).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(db, role, identities.alice, tx => tx.query('select public.payment_checkout_ready()')))
        .rejects.toThrow(/permission denied/);
    }
  });
  it.each([
    ['meetup_payments', 'payments_unknown_attempt'],
    ['meetup_payments', 'payments_new_attempt'],
    ['meetup_payment_attempts', 'payment_attempts_receipt'],
  ])('fails closed before provider creation when %s.%s is disabled', async (table, trigger) => {
    await db.exec(`alter table ${table} disable trigger ${trigger}`);
    try {
      expect((await service('select public.payment_checkout_ready() as ready')).rows[0].ready).toBe(false);
      expect((await invoke(POST)).status).toBe(503);
      expect(deps.createOrder).not.toHaveBeenCalled();
      expect((await service('select * from meetup_payments')).rows).toHaveLength(0);
    } finally { await db.exec(`alter table ${table} enable trigger ${trigger}`); }
  });
  it('fences an old binary inserting a new claim without a durable reference', async () => {
    const oldCreate = vi.fn();
    const oldRequest = async () => {
      await service(`insert into meetup_payments(meetup_id, attendee_id, amount_paise)
        values ($1, $2, 50000)`, [tenants.alice.meetup.id, attendees.alice]);
      oldCreate();
    };
    await expect(oldRequest()).rejects.toThrow('payment_upgrade_required');
    expect(oldCreate).not.toHaveBeenCalled();
    expect((await service('select * from meetup_payments')).rows).toHaveLength(0);
  });
});
