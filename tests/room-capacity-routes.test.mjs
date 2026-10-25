import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const deps = vi.hoisted(() => ({ admin: null, user: null, cookies: null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => deps.cookies() }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.admin }));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => deps.user }));
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn(), rateLimit: vi.fn(), LIMITS: { view: 100, joinHourly: 100 } }));
// No provider, credential loader, Auth server, or outbound transport is used.
vi.mock('@/lib/pinelabs', () => ({ amountPaise: (price) => price == null ? null : Math.round(price * 100) }));

import { POST as joinRoom } from '../app/api/rooms/[token]/join/route';
import { PATCH as editGuest } from '../app/api/rooms/[token]/me/route';
import { POST as vote, DELETE as unvote } from '../app/api/rooms/[token]/vote/route';
import { POST as confirmRoom } from '../app/api/rooms/[token]/confirm/route';
import { POST as closeRoom } from '../app/api/rooms/[token]/close/route';

let db, tenants;
const storage = new AsyncLocalStorage();
const venueB = '44444444-4444-4444-8444-444444444444';
const browser = () => {
  const values = new Map();
  return {
    values,
    get: (name) => values.has(name) ? { value: values.get(name) } : undefined,
    set: vi.fn((name, value) => values.set(name, value)),
  };
};
function invoke(handler, { session = browser(), room = tenants.alice.meetup, method = 'POST', body } = {}) {
  const request = new Request(`https://example.test/api/rooms/${room.room_token}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return storage.run(session, () => handler(request, { params: Promise.resolve({ token: room.room_token }) }));
}
const sql = (query, values = []) => asRole(db, 'service_role', null, (tx) => tx.query(query, values));
const count = async (room = tenants.alice.meetup) => (await sql('select count(*)::int as n from meetup_attendees where meetup_id = $1', [room.id])).rows[0].n;
const fill = (n, room = tenants.alice.meetup) => sql(`insert into meetup_attendees (meetup_id, guest_name, secret_hash)
  select $1, 'Fixture guest ' || g, 'synthetic fixture ' || g from generate_series(1, $2::int) g`, [room.id, n]);
async function join(session = browser(), room = tenants.alice.meetup) {
  const response = await invoke(joinRoom, { session, room, body: { guest_name: 'Route guest' } });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.room.me.attendee_id).toBe(body.attendee_id);
  expect(session.values.get(`guest_${room.id}`)).toBe(body.guest_secret);
  return body;
}
async function guestState() {
  return {
    attendees: (await sql('select * from meetup_attendees order by id')).rows,
    votes: (await sql('select * from venue_votes order by id')).rows,
  };
}
const changeRoom = (state) => sql(state === 'closed'
  ? "update meetups set status = 'closed' where id = $1"
  : state === 'expired'
    ? "update meetups set expires_at = now() - interval '1 minute' where id = $1"
    : 'update meetups set final_venue_id = $2 where id = $1',
state === 'confirmed' ? [tenants.alice.meetup.id, identities.venue] : [tenants.alice.meetup.id]);

// Run another committed operation after the actual handler's reads and before
// its SQL write. The one-shot hook is removed before nested handlers execute.
// PGlite serializes queries: this establishes deterministic stale-read behavior,
// NOT independent PostgreSQL connections, lock contention, or load/race proof.
function beforeWrite(client, target, operation, work) {
  const from = client.from;
  const observed = { calls: 0 };
  client.from = (table) => {
    const query = from(table);
    if (table !== target) return query;
    const write = query[operation];
    query[operation] = (...args) => {
      const result = write(...args);
      const then = query.then;
      query.then = async (resolve, reject) => {
        client.from = from;
        observed.calls++;
        await work();
        return then(resolve, reject);
      };
      return result;
    };
    return query;
  };
  return observed;
}

beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
beforeEach(async () => {
  tenants = await seedPrivateData(db);
  await sql(`insert into venues (id, name, area, activity_types, price_per_person)
    values ($1, 'Synthetic second cafe', 'Indiranagar', '{dinner,coffee}', 600)`, [venueB]);
  deps.admin = pgliteClient(db, 'service_role');
  deps.user = pgliteClient(db, 'authenticated', identities.alice);
  deps.cookies = () => storage.getStore();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden in room capacity tests'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await db?.close(); });

describe('room capacity through real handlers and in-memory PostgreSQL', () => {
  it('admits guests 49 and 50, then rejects guest 51 without an attendee or cookie', async () => {
    await fill(48);
    for (const expected of [49, 50]) {
      const session = browser();
      const joined = await join(session);
      expect(joined.room.attendees).toHaveLength(expected);
      expect(await count()).toBe(expected);
      expect(session.set).toHaveBeenCalledTimes(1);
      expect(session.set.mock.calls[0][2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    }
    const before = await guestState(), rejected = browser();
    const response = await invoke(joinRoom, { session: rejected, body: { guest_name: 'Guest 51' } });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Room is full' });
    expect(await guestState()).toEqual(before);
    expect(rejected.set).not.toHaveBeenCalled();
    expect(rejected.values.size).toBe(0);
  });

  it('counts each room independently, including when another room is full', async () => {
    await fill(50);
    await fill(49, tenants.bob.meetup);
    const joined = await join(browser(), tenants.bob.meetup);
    expect(joined.room.attendees).toHaveLength(50);
    expect(await count()).toBe(50);
    expect(await count(tenants.bob.meetup)).toBe(50);
    for (const room of [tenants.alice.meetup, tenants.bob.meetup]) {
      const session = browser();
      const response = await invoke(joinRoom, { session, room, body: { guest_name: 'Overflow' } });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'Room is full' });
      expect(session.set).not.toHaveBeenCalled();
      expect(await count(room)).toBe(50);
    }
  });

  it('rejects a stale join after another handler claims the last slot', async () => {
    await fill(49);
    const loser = browser(), winner = browser();
    const interleave = beforeWrite(deps.admin, 'meetup_attendees', 'insert', async () => {
      expect(await count()).toBe(49);
      await join(winner);
      expect(await count()).toBe(50);
    });
    const response = await invoke(joinRoom, { session: loser, body: { guest_name: 'Stale guest' } });
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Room is full' });
    expect(await count()).toBe(50);
    expect((await sql("select count(*)::int as n from meetup_attendees where guest_name = 'Stale guest'")).rows[0].n).toBe(0);
    expect(loser.set).not.toHaveBeenCalled();
    expect(winner.set).toHaveBeenCalledTimes(1);
  });

  it('rolls back an entire two-guest SQL insert when only one slot remains', async () => {
    await fill(49);
    const before = await guestState();
    await expect(sql(`insert into meetup_attendees (meetup_id, guest_name, secret_hash)
      values ($1, 'Would be 50', 'synthetic A'), ($1, 'Would be 51', 'synthetic B')`, [tenants.alice.meetup.id])).rejects.toThrow('room_full');
    expect(await count()).toBe(49);
    expect(await guestState()).toEqual(before);
  });

  it('retains an existing full-room guest identity and still permits their preference edit', async () => {
    await fill(49);
    const session = browser();
    await join(session);
    const before = await guestState(), cookie = [...session.values];
    session.set.mockClear();
    const duplicate = await invoke(joinRoom, { session, body: { guest_name: 'Duplicate' } });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'Already joined. Use PATCH /me to update.' });
    expect(await guestState()).toEqual(before);
    expect([...session.values]).toEqual(cookie);
    expect(session.set).not.toHaveBeenCalled();
    expect((await invoke(editGuest, { session, method: 'PATCH', body: { guest_name: 'Renamed guest' } })).status).toBe(200);
    expect(await count()).toBe(50);
  });

  it('preserves the existing policy: confirmation freezes votes, not later joining or capacity', async () => {
    await fill(49);
    expect((await invoke(confirmRoom, { body: { venue_id: identities.venue } })).status).toBe(200);
    const session = browser();
    expect((await join(session)).room.meetup.final_venue.id).toBe(identities.venue);
    const response = await invoke(vote, { session, body: { venue_id: identities.venue } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'The organiser has already confirmed a venue' });
    expect((await invoke(joinRoom, { body: { guest_name: 'Overflow after confirmation' } })).status).toBe(429);
    expect(await count()).toBe(50);
  });
});

describe('committed state changes between handler read and database write', () => {
  it.each(['closed', 'expired'])('rejects a join when the room becomes %s after lookup, without partial rows or a cookie', async (state) => {
    const before = await guestState(), session = browser();
    const interleave = beforeWrite(deps.admin, 'meetup_attendees', 'insert', () => changeRoom(state));
    const response = await invoke(joinRoom, { session, body: { guest_name: 'Too late' } });
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'This meetup room is closed' });
    expect(await guestState()).toEqual(before);
    expect(session.set).not.toHaveBeenCalled();
    // A subsequent lookup observes expiry and uses the documented 404 instead.
    const repeat = await invoke(joinRoom, { session, body: { guest_name: 'Still too late' } });
    expect(repeat.status).toBe(state === 'expired' ? 404 : 410);
    expect(session.set).not.toHaveBeenCalled();
  });

  for (const operation of ['insert vote', 'replace vote', 'withdraw vote', 'edit guest']) {
    it.each(['closed', 'expired', ...(operation === 'edit guest' ? [] : ['confirmed'])])(`rejects ${operation} after a committed %s change and preserves guest data`, async (state) => {
      const session = browser();
      await join(session);
      if (operation === 'replace vote' || operation === 'withdraw vote') {
        expect((await invoke(vote, { session, body: { venue_id: identities.venue } })).status).toBe(200);
      }
      const before = await guestState(), cookies = [...session.values];
      session.set.mockClear();
      const editing = operation === 'edit guest', withdrawing = operation === 'withdraw vote';
      const interleave = beforeWrite(deps.admin, editing ? 'meetup_attendees' : 'venue_votes', editing ? 'update' : withdrawing ? 'delete' : 'upsert', () => changeRoom(state));
      const response = await invoke(editing ? editGuest : withdrawing ? unvote : vote, {
        session, method: editing ? 'PATCH' : withdrawing ? 'DELETE' : 'POST',
        body: editing ? { guest_name: 'Stale rename' } : withdrawing ? undefined : { venue_id: venueB },
      });
      expect(interleave.calls).toBe(1);
      expect(response.status).toBe(state === 'confirmed' ? 409 : 410);
      expect(await response.json()).toEqual({ error: state === 'confirmed' ? 'The organiser has already confirmed a venue' : 'This meetup room is closed' });
      expect(await guestState()).toEqual(before);
      expect([...session.values]).toEqual(cookies);
      expect(session.set).not.toHaveBeenCalled();
    });
  }

  it.each(['closed', 'expired'])('rejects first confirmation after a committed %s change without setting a venue', async (state) => {
    const before = await guestState();
    const interleave = beforeWrite(deps.user, 'meetups', 'update', () => changeRoom(state));
    const response = await invoke(confirmRoom, { body: { venue_id: identities.venue } });
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'This meetup room is closed' });
    expect((await sql('select final_venue_id from meetups where id = $1', [tenants.alice.meetup.id])).rows[0].final_venue_id).toBeNull();
    expect(await guestState()).toEqual(before);
  });

  it('allows a repeated close after another close commits, without changing guests or votes', async () => {
    const session = browser();
    await join(session);
    expect((await invoke(vote, { session, body: { venue_id: identities.venue } })).status).toBe(200);
    const before = await guestState();
    const interleave = beforeWrite(deps.user, 'meetups', 'update', () => changeRoom('closed'));
    const response = await invoke(closeRoom);
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(200);
    expect((await response.json()).meetup.status).toBe('closed');
    expect(await guestState()).toEqual(before);
  });

  it.each(['closed', 'expired'])('does not claim an open room when a repeated confirmation crosses a %s boundary', async (state) => {
    await changeRoom('confirmed');
    const interleave = beforeWrite(deps.user, 'meetups', 'update', () => changeRoom(state));
    const response = await invoke(confirmRoom, { body: { venue_id: identities.venue } });
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'This meetup room is closed' });
    expect((await sql('select final_venue_id from meetups where id = $1', [tenants.alice.meetup.id])).rows[0].final_venue_id).toBe(identities.venue);
  });

  it('keeps open same-venue confirmation idempotent and returns the current persisted room details', async () => {
    await changeRoom('confirmed');
    const interleave = beforeWrite(deps.user, 'meetups', 'update', () => sql(
      "update meetups set title = 'Current room title' where id = $1", [tenants.alice.meetup.id],
    ));
    const response = await invoke(confirmRoom, { body: { venue_id: identities.venue } });
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.meetup.status).toBe('open');
    expect(result.meetup.title).toBe('Current room title');
    expect(result.meetup.final_venue.id).toBe(identities.venue);
  });

  it('does not report a successful close when the room was deleted before the write', async () => {
    const interleave = beforeWrite(deps.user, 'meetups', 'update', () => sql('delete from meetups where id = $1', [tenants.alice.meetup.id]));
    const response = await invoke(closeRoom);
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect((await sql('select id from meetups where id = $1', [tenants.alice.meetup.id])).rows).toEqual([]);
  });

  it('keeps a close database failure generic instead of echoing internal details', async () => {
    const before = (await sql('select * from meetups where id = $1', [tenants.alice.meetup.id])).rows;
    const from = deps.user.from;
    deps.user.from = (table) => {
      const query = from(table);
      if (table === 'meetups') {
        const update = query.update;
        query.update = (body) => {
          query.then = (resolve, reject) => Promise.resolve({
            data: null, error: { code: '42501', message: 'Synthetic internal permission detail that must not be echoed' },
          }).then(resolve, reject);
          return update(body);
        };
      }
      return query;
    };
    const response = await invoke(closeRoom);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Could not close' });
    expect((await sql('select * from meetups where id = $1', [tenants.alice.meetup.id])).rows).toEqual(before);
  });

  it('does not expose an expired room if it expires between lookup and close', async () => {
    const before = await guestState();
    const interleave = beforeWrite(deps.user, 'meetups', 'update', () => changeRoom('expired'));
    const response = await invoke(closeRoom);
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Room not found' });
    // Closing is restrictive and may commit. The expired room must still not
    // be returned as a readable public room from a stale pre-write snapshot.
    expect((await sql('select status from meetups where id = $1', [tenants.alice.meetup.id])).rows[0].status).toBe('closed');
    expect(await guestState()).toEqual(before);
  });

  it('returns the persisted confirmed venue when another organizer request confirms before close writes', async () => {
    const interleave = beforeWrite(deps.user, 'meetups', 'update', () => changeRoom('confirmed'));
    const response = await invoke(closeRoom);
    expect(interleave.calls).toBe(1);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.meetup.status).toBe('closed');
    expect(result.meetup.final_venue?.id).toBe(identities.venue);
    expect((await sql('select final_venue_id from meetups where id = $1', [tenants.alice.meetup.id])).rows[0].final_venue_id).toBe(identities.venue);
  });
});
