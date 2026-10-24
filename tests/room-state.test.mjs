import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db, room, attendee;
const owner = '11111111-1111-4111-8111-111111111111';
const venueA = '22222222-2222-4222-8222-222222222222';
const venueB = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  // Real PostgreSQL engine in memory. No network, accounts, or live databases.
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create publication supabase_realtime;
  `);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  await db.query('insert into auth.users (id) values ($1)', [owner]);
  await db.query("insert into venues (id, name, area, price_per_person) values ($1, 'A', 'Area', 500), ($2, 'B', 'Area', 800)", [venueA, venueB]);
}, 30_000);

afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  const result = await db.query("insert into meetups (organizer_id, title) values ($1, 'Test') returning id", [owner]);
  room = result.rows[0].id;
  const guest = await db.query("insert into meetup_attendees (meetup_id, guest_name, secret_hash) values ($1, 'Guest', 'hash') returning id", [room]);
  attendee = guest.rows[0].id;
  await db.query('insert into venue_votes (meetup_id, attendee_id, venue_id) values ($1, $2, $3)', [room, attendee, venueA]);
});
const confirm = () => db.query('update meetups set final_venue_id = $1 where id = $2', [venueA, room]);
const close = () => db.query("update meetups set status = 'closed' where id = $1", [room]);

describe('database room-state invariants', () => {
  it('allows confirmation and an idempotent repeat of the same venue', async () => {
    await confirm();
    await expect(confirm()).resolves.toMatchObject({ affectedRows: 1 });
  });

  it('rejects changing or clearing a confirmed venue', async () => {
    await confirm();
    await expect(db.query('update meetups set final_venue_id = $1 where id = $2', [venueB, room])).rejects.toThrow('venue_confirmed');
    await expect(db.query('update meetups set final_venue_id = null where id = $1', [room])).rejects.toThrow('venue_confirmed');
  });

  it('rejects reopening a closed room', async () => {
    await close();
    await expect(db.query("update meetups set status = 'open' where id = $1", [room])).rejects.toThrow('room_closed');
  });

  it('rejects confirmation after a close has committed', async () => {
    await close();
    await expect(confirm()).rejects.toThrow('room_closed');
  });

  it('rejects confirmation of an expired room through a direct update', async () => {
    await db.query("update meetups set expires_at = now() - interval '1 minute' where id = $1", [room]);
    await expect(confirm()).rejects.toThrow('room_closed');
  });

  it('rejects withdrawal after confirmation and preserves the vote', async () => {
    await confirm();
    await expect(db.query('delete from venue_votes where meetup_id = $1', [room])).rejects.toThrow('venue_confirmed');
    expect((await db.query('select count(*)::int as count from venue_votes where meetup_id = $1', [room])).rows[0].count).toBe(1);
  });

  it('still cascades a closed and confirmed meetup deletion', async () => {
    await confirm();
    await close();
    await db.query('delete from meetups where id = $1', [room]);
    expect((await db.query('select count(*)::int as count from venue_votes where meetup_id = $1', [room])).rows[0].count).toBe(0);
    expect((await db.query('select count(*)::int as count from meetup_attendees where meetup_id = $1', [room])).rows[0].count).toBe(0);
  });
});
