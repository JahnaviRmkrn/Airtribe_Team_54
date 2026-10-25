import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const deps = vi.hoisted(() => ({ userClient: null }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ userClient: (req) => deps.userClient(req) }));
import { GET, PATCH } from '../app/api/me/meetups/[id]/route';

let db, tenants;
const query = (sql, params = [], uid = identities.alice) => asRole(db, 'authenticated', uid, (tx) => tx.query(sql, params));
const invoke = (handler, body, { uid = identities.alice, id = tenants.alice.meetup.id } = {}) => handler(new Request('https://example.test/api/me/meetups/' + id, {
  method: body === undefined ? 'GET' : 'PATCH', headers: uid ? { 'x-test-user': uid } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
}), { params: Promise.resolve({ id }) });
// PGlite exposes timestamptz as JS Date, while PostgREST preserves microseconds.
// Read the unrounded SQL token to test the same precise conditional predicate.
const version = async () => (await query(`select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as version from meetups where id = $1`, [tenants.alice.meetup.id])).rows[0].version;
const current = async () => (await query('select * from meetups where id = $1', [tenants.alice.meetup.id])).rows[0];

beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
beforeEach(async () => {
  tenants = await seedPrivateData(db);
  deps.userClient = (req) => {
    const uid = req.headers.get('x-test-user');
    return pgliteClient(db, uid ? 'authenticated' : 'anon', uid);
  };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden in meetup edit tests'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await db?.close(); });

describe('meetup edit API with real owner RLS and PostgreSQL updates', () => {
  it('returns the owner’s current details and version but hides foreign or absent rooms', async () => {
    const response = await invoke(GET);
    expect(response.status).toBe(200);
    expect((await response.json()).meetup).toMatchObject({ title: 'alice room', notes: 'alice private meetup note', room_url: expect.stringContaining(tenants.alice.meetup.room_token), updated_at: expect.any(String) });
    for (const id of [tenants.bob.meetup.id, '99999999-9999-4999-8999-999999999999']) {
      expect((await invoke(GET, undefined, { id })).status).toBe(404);
      expect((await invoke(PATCH, { title: 'Intruder', expected_updated_at: await version() }, { id })).status).toBe(404);
    }
    expect((await invoke(GET, undefined, { uid: null })).status).toBe(401);
    expect((await invoke(PATCH, { title: 'Intruder' }, { uid: null })).status).toBe(401);
    expect((await query('select title from meetups', [], identities.bob)).rows).toEqual([{ title: 'bob room' }]);
  });

  it('updates only requested details and preserves exact time, room, guests, votes and confirmed venue', async () => {
    const id = tenants.alice.meetup.id;
    await query("update meetups set starts_at = '2026-11-01T01:30:45.123456-04:00' where id = $1", [id]);
    await asRole(db, 'service_role', null, async (tx) => {
      const guest = (await tx.query("insert into meetup_attendees(meetup_id, guest_name, secret_hash) values ($1, 'Guest', 'synthetic') returning id", [id])).rows[0].id;
      await tx.query('insert into venue_votes(meetup_id, attendee_id, venue_id) values ($1, $2, $3)', [id, guest, identities.venue]);
    });
    await query('update meetups set final_venue_id = $1 where id = $2', [identities.venue, id]);
    const before = await current();
    const guests = (await query('select * from meetup_attendees')).rows;
    const votes = (await query('select * from venue_votes')).rows;
    const response = await invoke(PATCH, { title: 'New title', activity: 'board games', area: 'New area', budget: 0, notes: 'Updated private note', expected_updated_at: await version() });
    expect(response.status).toBe(200);
    expect(await current()).toMatchObject({ ...before, title: 'New title', activity: 'board games', area: 'New area', budget: 0, notes: 'Updated private note', updated_at: expect.any(Date) });
    expect((await query("select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as exact from meetups where id = $1", [id])).rows[0].exact).toBe('2026-11-01 05:30:45.123456');
    expect((await query('select * from meetup_attendees')).rows).toEqual(guests);
    expect((await query('select * from venue_votes')).rows).toEqual(votes);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reschedules and recomputes expiry, then permits nullable clearing without resetting other details', async () => {
    const starts = new Date(Date.now() + 40 * 864e5).toISOString();
    let response = await invoke(PATCH, { starts_at: starts, expected_updated_at: await version() });
    expect(response.status).toBe(200);
    let row = await current();
    expect(row.starts_at.toISOString()).toBe(starts);
    expect(row.expires_at.getTime()).toBe(Date.parse(starts) + 2 * 864e5);
    response = await invoke(PATCH, { starts_at: null, area: null, budget: null, notes: null, expected_updated_at: await version() });
    expect(response.status).toBe(200);
    row = await current();
    expect(row).toMatchObject({ starts_at: null, area: null, budget: null, notes: null, title: 'alice room', activity: 'dinner', status: 'open' });
    expect(Math.abs(row.expires_at.getTime() - (Date.now() + 14 * 864e5))).toBeLessThan(5000);
  });

  it('rejects stale writes and retries of a committed save without overwriting a newer tab', async () => {
    const token = await version();
    expect((await invoke(PATCH, { title: 'Tab one', expected_updated_at: token })).status).toBe(200);
    for (const title of ['Tab two', 'Tab one']) {
      const response = await invoke(PATCH, { title, expected_updated_at: token });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain('Reload the latest details');
    }
    expect((await current()).title).toBe('Tab one');
  });

  it('atomically allows only one update for two writers sharing a version', async () => {
    const token = await version();
    const responses = await Promise.all(['Tab one', 'Tab two'].map((title) => invoke(PATCH, { title, expected_updated_at: token })));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('does not edit or reopen a room that closed after loading, including a combined edit/reopen', async () => {
    const token = await version();
    expect((await invoke(PATCH, { status: 'closed' })).status).toBe(200);
    const before = await current();
    for (const body of [{ title: 'Changed', expected_updated_at: token }, { starts_at: null }, { status: 'open' }, { title: 'Changed', status: 'open' }]) {
      expect((await invoke(PATCH, body)).status).toBe(410);
      expect(await current()).toEqual(before);
    }
  });

  it.each([
    {}, { expected_updated_at: 'invalid' }, { expected_updated_at: '2026-10-25T00:00:00Z' },
    { title: '' }, { title: ' '.repeat(5) }, { title: 'x'.repeat(121) },
    { activity: null }, { activity: '' }, { activity: 'x'.repeat(41) },
    { area: 'x'.repeat(81) }, { notes: 'x'.repeat(2001) },
    { budget: -1 }, { budget: 1.5 }, { budget: 1000001 }, { budget: '0' },
    { starts_at: '2026-02-30T12:00:00Z' }, { starts_at: '2026-11-01T01:30:00' },
  ])('rejects invalid/empty edits without changing the room: %j', async (body) => {
    const before = await current();
    expect((await invoke(PATCH, body)).status).toBe(400);
    expect(await current()).toEqual(before);
  });

  it('ignores injected ownership/link/expiry fields and never writes the version token as a column', async () => {
    const before = await current();
    const response = await invoke(PATCH, { title: 'Safe title', organizer_id: identities.bob, room_token: 'forged', expires_at: '2099-01-01T00:00:00Z', expected_updated_at: await version() });
    expect(response.status).toBe(200);
    expect(await current()).toMatchObject({ title: 'Safe title', organizer_id: before.organizer_id, room_token: before.room_token, expires_at: before.expires_at });
  });
});
