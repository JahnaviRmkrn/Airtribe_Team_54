import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const deps = vi.hoisted(() => ({ admin: null, cookies: null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => deps.cookies() }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.admin }));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn(), rateLimit: vi.fn(), LIMITS: { view: 100, joinHourly: 100 } }));
// No provider, credential loader, Auth, or outbound transport is exercised.
vi.mock('@/lib/pinelabs', () => ({ amountPaise: (price) => price == null ? null : Math.round(price * 100) }));

import { GET as viewRoom } from '../app/api/rooms/[token]/route';
import { POST as joinRoom } from '../app/api/rooms/[token]/join/route';
import { GET as getGuest, PATCH as editGuest } from '../app/api/rooms/[token]/me/route';
import { POST as vote, DELETE as unvote } from '../app/api/rooms/[token]/vote/route';

let db, tenants;
const storage = new AsyncLocalStorage();
const browser = () => {
  const values = new Map();
  return { get: (name) => values.has(name) ? { value: values.get(name) } : undefined, set: (name, value) => values.set(name, value) };
};
function invoke(handler, { session = browser(), token = tenants.alice.meetup.room_token, method = 'GET', body } = {}) {
  const request = new Request(`https://example.test/api/rooms/${token}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return storage.run(session, () => handler(request, { params: Promise.resolve({ token }) }));
}
async function join(session, preferences = {}) {
  const response = await invoke(joinRoom, { session, method: 'POST', body: { guest_name: 'Synthetic guest', preferences } });
  expect(response.status).toBe(201);
  return response.json();
}
const guests = () => asRole(db, 'service_role', null, (tx) => tx.query('select id, guest_name, preferences, availability from meetup_attendees order by id'));
const location = { lat: 12.971234, lng: 77.641234, label: 'Synthetic location' };
const roundedLocation = { lat: 12.971, lng: 77.641, label: 'Synthetic location' };

beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
beforeEach(async () => {
  tenants = await seedPrivateData(db);
  deps.admin = pgliteClient(db, 'service_role');
  deps.cookies = () => storage.getStore();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden in preference tests'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await db?.close(); });

describe('guest preference boundaries through real routes and PostgreSQL', () => {
  it('keeps omitted preferences, retains omitted location, and clears only an explicitly null location', async () => {
    const session = browser();
    const guest = await join(session, { area: 'Indiranagar', location, budget_min: 0, budget_max: 0 });
    expect((await guests()).rows[0].preferences).toEqual({ area: 'Indiranagar', location: roundedLocation, budget_min: 0, budget_max: 0 });
    expect((await invoke(editGuest, { session, method: 'PATCH', body: { guest_name: 'Renamed guest' } })).status).toBe(200);
    expect((await guests()).rows[0].preferences.location).toEqual(roundedLocation);

    const replaced = await invoke(editGuest, { session, method: 'PATCH', body: { preferences: { area: 'Whitefield', budget_max: 0 }, availability: [] } });
    expect(replaced.status).toBe(200);
    expect((await guests()).rows[0].preferences).toEqual({ area: 'Whitefield', budget_max: 0, location: roundedLocation });
    for (const payload of [guest.room, await replaced.json(), await (await invoke(viewRoom)).json()]) {
      expect(payload.attendees[0].preferences.location).toEqual({ label: 'Synthetic location' });
      expect(JSON.stringify(payload.attendees)).not.toContain('12.971');
      expect(JSON.stringify(payload.attendees)).not.toContain('77.641');
    }

    expect((await invoke(editGuest, { session, method: 'PATCH', body: { preferences: { location: null } } })).status).toBe(200);
    expect((await guests()).rows[0].preferences).toEqual({});
    expect((await invoke(editGuest, { session, method: 'PATCH', body: { preferences: { budget_min: 0, budget_max: 0 } } })).status).toBe(200);
    expect((await guests()).rows[0].preferences).toEqual({ budget_min: 0, budget_max: 0 });
  });

  it('does not add a location when joining without one or explicitly declining it', async () => {
    const without = await join(browser());
    const declined = await join(browser(), { location: null });
    expect(without.room.attendees.find((a) => a.id === without.attendee_id).preferences).toEqual({});
    expect(declined.room.attendees.find((a) => a.id === declined.attendee_id).preferences.location).toBeNull();
    const response = await invoke(viewRoom);
    expect((await response.json()).meeting_point).toEqual({ people: 0 });
  });

  it.each([
    { preferences: null }, { availability: null }, { guest_name: null },
    { preferences: { budget_min: null } }, { preferences: { budget_max: null } },
    { preferences: { budget_min: 1, budget_max: 0 } },
    { preferences: { location: { lat: 91, lng: 0 } } },
  ])('rejects invalid nulls and ranges without overwriting existing data: %j', async (body) => {
    const session = browser();
    await join(session, { location, budget_max: 0 });
    const before = (await guests()).rows;
    expect((await invoke(editGuest, { session, method: 'PATCH', body })).status).toBe(400);
    expect((await guests()).rows).toEqual(before);
  });

  it.each(['error', 'missing'])('fails closed when the location-retention read is %s', async (failure) => {
    const session = browser();
    await join(session, { location, area: 'Indiranagar' });
    const before = (await guests()).rows;
    const originalFrom = deps.admin.from;
    let failedReads = 0, writes = 0;
    deps.admin.from = (table) => {
      const query = originalFrom(table);
      const select = query.select, update = query.update;
      query.select = (columns) => {
        if (table === 'meetup_attendees' && columns === 'preferences') {
          failedReads++;
          query.then = (resolve, reject) => Promise.resolve({ data: null, error: failure === 'error' ? { message: 'Synthetic unavailable read' } : null }).then(resolve, reject);
        }
        return select(columns);
      };
      query.update = (body) => { writes++; return update(body); };
      return query;
    };
    const response = await invoke(editGuest, { session, method: 'PATCH', body: { preferences: { area: 'Whitefield' } } });
    expect(response.status).toBe(503);
    expect(failedReads).toBe(1);
    expect(writes).toBe(0);
    expect((await guests()).rows).toEqual(before);
  });

  it.each(['closed', 'expired'])('rejects join, edit, vote and withdrawal in a %s room, including direct SQL writes', async (state) => {
    const session = browser();
    const guest = await join(session, { location, area: 'Indiranagar' });
    expect((await invoke(vote, { session, method: 'POST', body: { venue_id: identities.venue } })).status).toBe(200);
    await asRole(db, 'service_role', null, (tx) => tx.query(state === 'closed'
      ? "update meetups set status = 'closed' where id = $1"
      : "update meetups set expires_at = now() - interval '1 minute' where id = $1", [tenants.alice.meetup.id]));
    const before = (await guests()).rows;
    const expectedStatus = state === 'closed' ? 410 : 404;
    for (const [handler, method, body, identity] of [
      [joinRoom, 'POST', { guest_name: 'Late guest' }, browser()],
      [editGuest, 'PATCH', { preferences: { location: null } }, session],
      [vote, 'POST', { venue_id: identities.venue }, session], [unvote, 'DELETE', undefined, session],
    ]) expect((await invoke(handler, { session: identity, method, body })).status).toBe(expectedStatus);
    // Service-role writes still encounter real trigger guards, not only route checks.
    for (const [sql, values] of [
      ["insert into meetup_attendees (meetup_id, guest_name, secret_hash) values ($1, 'Late', 'synthetic')", [tenants.alice.meetup.id]],
      ["update meetup_attendees set preferences = '{}' where id = $1", [guest.attendee_id]],
      ['update venue_votes set venue_id = $1 where attendee_id = $2', [identities.venue, guest.attendee_id]],
      ['delete from venue_votes where attendee_id = $1', [guest.attendee_id]],
    ]) await expect(asRole(db, 'service_role', null, (tx) => tx.query(sql, values))).rejects.toThrow('room_closed');
    expect((await guests()).rows).toEqual(before);
    expect((await asRole(db, 'service_role', null, (tx) => tx.query('select count(*)::int as n from venue_votes'))).rows[0].n).toBe(1);
    expect((await invoke(viewRoom, { session })).status).toBe(state === 'closed' ? 200 : 404);
  });

  it.each([
    ['cleared', { location: null }, {}],
    ['replaced', { location: { lat: 12.981, lng: 77.651 } }, { location: { lat: 12.981, lng: 77.651 } }],
  ])('does not restore a shared location %s between the retention read and write', async (_label, nextPreferences, expected) => {
    const session = browser();
    await join(session, { location, area: 'Indiranagar' });
    const originalFrom = deps.admin.from;
    let cleared = false;
    deps.admin.from = (table) => {
      const query = originalFrom(table);
      const select = query.select;
      query.select = (columns) => {
        if (table === 'meetup_attendees' && columns === 'preferences') {
          const then = query.then;
          query.then = async (resolve, reject) => {
            const snapshot = await then((result) => result);
            // Deterministic interleaving of two legitimate requests in one
            // worker, not a live DB race or concurrent browser session.
            const response = await invoke(editGuest, { session, method: 'PATCH', body: { preferences: nextPreferences } });
            expect(response.status).toBe(200);
            cleared = true;
            return Promise.resolve(snapshot).then(resolve, reject);
          };
        }
        return select(columns);
      };
      return query;
    };
    const response = await invoke(editGuest, { session, method: 'PATCH', body: { preferences: { area: 'Whitefield' } } });
    expect(cleared).toBe(true);
    expect(response.status).toBe(409);
    expect((await guests()).rows[0].preferences).toEqual(expected);
  });

  it('serializes the actual route snapshot filter through supabase-js and detects an unmatched update without retrying', async () => {
    const session = browser();
    const preferences = { location: roundedLocation, area: 'A comma, quote " and & symbol' };
    await join(session, preferences);
    const captured = [];
    // A synthetic SDK key and local fetch implementation only. This callback
    // records construction, never invokes fetch or sends a network request.
    const sdk = createClient('https://synthetic.example.test', 'synthetic-test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (url, options) => {
        captured.push({ url: new URL(url), body: JSON.parse(options.body) });
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      } },
    });
    const originalFrom = deps.admin.from;
    deps.admin.from = (table) => {
      const query = originalFrom(table);
      // Reads use real PostgreSQL; only the final write goes to the SDK
      // capture, whose empty representation simulates an unmatched snapshot.
      query.update = (body) => sdk.from(table).update(body);
      return query;
    };
    const response = await invoke(editGuest, { session, method: 'PATCH', body: { preferences: { area: 'Whitefield' } } });
    expect(response.status).toBe(409);
    expect(captured).toHaveLength(1);
    const filter = captured[0].url.searchParams.get('preferences');
    expect(filter.startsWith('eq.')).toBe(true);
    expect(JSON.parse(filter.slice(3))).toEqual(preferences);
    expect(filter).not.toContain('[object Object]');
    expect(captured[0].url.searchParams.get('select')).toBe('id');
    expect(captured[0].url.searchParams.get('meetup_id')).toBe(`eq.${tenants.alice.meetup.id}`);
    expect(captured[0].body.preferences).toEqual({ area: 'Whitefield', location: roundedLocation });
    expect((await guests()).rows[0].preferences).toEqual(preferences);
  });

  it.each(['error', 'missing'])('does not report a successful guest read when its data query is %s', async (failure) => {
    const session = browser();
    await join(session, { location });
    const originalFrom = deps.admin.from;
    deps.admin.from = (table) => {
      const query = originalFrom(table);
      const select = query.select;
      query.select = (columns) => {
        if (table === 'meetup_attendees' && columns === 'id, guest_name, preferences, availability, joined_at') {
          query.then = (resolve, reject) => Promise.resolve({ data: null, error: failure === 'error' ? { message: 'Synthetic unavailable read' } : null }).then(resolve, reject);
        }
        return select(columns);
      };
      return query;
    };
    const response = await invoke(getGuest, { session });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Could not load your preferences, please retry' });
  });
});
