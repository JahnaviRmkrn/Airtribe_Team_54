import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase } from './helpers/privacy-db.mjs';

const dependencies = vi.hoisted(() => ({ client: null }));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => dependencies.client }));
import { POST } from '../app/api/me/interactions/route';

// Synthetic local PostgreSQL only. The helper skips Vault; no environment files
// are loaded and every interaction mutation executes the authored SQL function.
let db, contact;
const query = (sql, params = []) => asRole(db, 'authenticated', identities.alice, (tx) => tx.query(sql, params));
const latest = '2026-10-20T06:00:00.000Z';
const previous = '2026-10-01T06:00:00.000Z';
const explicitNext = '2026-12-01T06:00:00.000Z';
const invoke = (body = {}) => POST(new Request('https://example.test/api/me/interactions', {
  method: 'POST', body: JSON.stringify({ contact_id: contact.id, type: 'call', ...body }),
}));
const current = async () => (await query('select * from contacts where id = $1', [contact.id])).rows[0];
const count = async () => (await query('select * from interactions')).rows.length;
const dates = async () => {
  const row = await current();
  return { last: row.last_interaction_at?.toISOString() ?? null, next: row.next_followup_at?.toISOString() ?? null };
};

beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-25T06:00:00.000Z');
  await db.exec('truncate auth.users cascade');
  await db.query('insert into auth.users(id) values ($1)', [identities.alice]);
  contact = (await query("insert into contacts(name, category, preferred_frequency_days) values ('Synthetic Alice', 'personal', 14) returning *")).rows[0];
  dependencies.client = {
    auth: { getUser: async () => ({ data: { user: { id: identities.alice } }, error: null }) },
    rpc: vi.fn(async (name, args) => {
      if (name !== 'record_interaction') throw new Error('Unexpected RPC');
      try {
        const { rows } = await query('select record_interaction($1, $2, $3, $4, $5, $6) as result', [
          args.p_contact_id, args.p_occurred_at, args.p_type, args.p_notes, args.p_next_followup_at, args.p_set_next,
        ]);
        return { data: rows[0].result, error: null };
      } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
    }),
  };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('recorded check-in scheduling with real PostgreSQL', () => {
  it('advances dates for the newest activity but not for a backdated or equal occurrence', async () => {
    expect((await invoke({ occurred_at: latest })).status).toBe(201);
    const expected = { last: latest, next: '2026-11-03T06:00:00.000Z' };
    expect(await dates()).toEqual(expected);
    for (const occurred_at of [previous, latest]) {
      expect((await invoke({ occurred_at })).status).toBe(201);
      expect(await dates()).toEqual(expected);
    }
    expect(await count()).toBe(3);
  });

  it('keeps the latest schedule regardless of historical insertion order', async () => {
    for (const occurred_at of [previous, latest, '2026-10-10T06:00:00.000Z']) {
      expect((await invoke({ occurred_at })).status).toBe(201);
    }
    expect(await dates()).toEqual({ last: latest, next: '2026-11-03T06:00:00.000Z' });
    expect(await count()).toBe(3);
  });

  it('preserves an explicitly chosen next date or clear even on a backdated log', async () => {
    await invoke({ occurred_at: latest });
    expect((await invoke({ occurred_at: previous, next_followup_at: explicitNext })).status).toBe(201);
    expect(await dates()).toEqual({ last: latest, next: explicitNext });
    expect((await invoke({ occurred_at: previous, next_followup_at: null })).status).toBe(201);
    expect(await dates()).toEqual({ last: latest, next: null });
  });

  it('does not invent a next reminder when no frequency is set', async () => {
    await query('update contacts set preferred_frequency_days = null, next_followup_at = $1 where id = $2', [explicitNext, contact.id]);
    expect((await invoke({ occurred_at: latest })).status).toBe(201);
    expect(await dates()).toEqual({ last: latest, next: explicitNext });
  });

  it('rejects future logs without history or schedule changes, then permits a real check-in', async () => {
    await invoke({ occurred_at: latest });
    const before = await current();
    dependencies.client.rpc.mockClear();
    const future = new Date(Date.now() + 365 * 864e5).toISOString();
    const rejected = await invoke({ occurred_at: future, next_followup_at: null });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain('future');
    expect(dependencies.client.rpc).not.toHaveBeenCalled();
    expect(await current()).toEqual(before); expect(await count()).toBe(1);
    const response = await invoke();
    expect(response.status).toBe(201);
    const saved = await dates();
    expect(Date.parse(saved.last)).toBeGreaterThan(Date.parse(latest));
    expect(Date.parse(saved.next) - Date.parse(saved.last)).toBe(14 * 864e5);
    expect(await count()).toBe(2);
  });
});
