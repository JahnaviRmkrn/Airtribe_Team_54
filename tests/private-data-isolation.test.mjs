import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';

let db, tenants;
const privateTables = [
  ['contacts', 'user_id', 'notes', 'private contact note'],
  ['interactions', 'user_id', 'notes', 'private interaction note'],
  ['balance_goals', 'user_id', 'target_percentage', 90],
  ['meetups', 'organizer_id', 'notes', 'private meetup note'],
  ['saved_discoveries', 'user_id', 'title', 'private discovery'],
];
const userQuery = (uid, sql, params = []) => asRole(db, 'authenticated', uid, (tx) => tx.query(sql, params));

beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
beforeEach(async () => { tenants = await seedPrivateData(db); });
afterAll(async () => { await db?.close(); });

describe('private data isolation with real PostgreSQL RLS', () => {
  it('executes as a non-owner, non-superuser authenticated role with a request-local identity', async () => {
    const result = await userQuery(identities.alice, `select current_user, auth.uid(), rolsuper, rolbypassrls
      from pg_roles where rolname = current_user`);
    expect(result.rows).toEqual([{ current_user: 'authenticated', uid: identities.alice, rolsuper: false, rolbypassrls: false }]);
    expect((await userQuery(null, 'select auth.uid()')).rows).toEqual([{ uid: null }]);
  });

  it.each(privateTables)('%s: each organizer reads only their own rows, including private fields', async (table, owner, field, value) => {
    for (const name of ['alice', 'bob']) {
      const { rows } = await userQuery(identities[name], `select * from ${table}`);
      expect(rows).toHaveLength(table === 'balance_goals' ? 3 : 1);
      expect(rows.every((row) => row[owner] === identities[name])).toBe(true);
      if (typeof value === 'string') expect(rows[0][field]).toBe(`${name} ${value}`);
      const foreign = await userQuery(identities[name], `select * from ${table} where ${owner} = $1`,
        [identities[name === 'alice' ? 'bob' : 'alice']]);
      expect(foreign.rows).toEqual([]);
    }
  });

  it.each(privateTables)('%s: guessed foreign identifiers cannot update or delete another organizer\'s data', async (table, owner, field, value) => {
    for (const [actor, victim] of [['alice', 'bob'], ['bob', 'alice']]) {
      const original = (await userQuery(identities[victim], `select * from ${table} order by ${field}`)).rows;
      expect((await userQuery(identities[actor], `update ${table} set ${field} = $1 where ${owner} = $2 returning *`,
        [value, identities[victim]])).rows).toEqual([]);
      expect((await userQuery(identities[actor], `delete from ${table} where ${owner} = $1 returning *`, [identities[victim]])).rows).toEqual([]);
      expect((await userQuery(identities[victim], `select * from ${table} order by ${field}`)).rows).toEqual(original);
    }
  });

  it.each(privateTables)('%s: ownership cannot be transferred to another user', async (table, owner) => {
    await expect(userQuery(identities.alice, `update ${table} set ${owner} = $1 where ${owner} = $2`,
      [identities.bob, identities.alice])).rejects.toThrow(table === 'interactions' ? /contact not found/ : /row-level security/);
  });

  it('rejects forged ownership on inserts, including interactions linked to the victim contact', async () => {
    const statements = [
      ["insert into contacts (user_id, name, category) values ($1, 'Forgery', 'personal')", [identities.bob]],
      ["insert into balance_goals (user_id, category, target_percentage) values ($1, 'personal', 10)", [identities.bob]],
      ["insert into meetups (organizer_id, title) values ($1, 'Forgery')", [identities.bob]],
      ["insert into saved_discoveries (user_id, title) values ($1, 'Forgery')", [identities.bob]],
    ];
    for (const [sql, params] of statements) await expect(userQuery(identities.alice, sql, params)).rejects.toThrow(/row-level security/);
    for (const claimedOwner of [identities.alice, identities.bob]) {
      await expect(userQuery(identities.alice, 'insert into interactions (user_id, contact_id) values ($1, $2)',
        [claimedOwner, tenants.bob.contact.id])).rejects.toThrow(/contact not found|row-level security/);
    }
  });

  it('does not allow an existing interaction to be re-linked to another organizer\'s contact', async () => {
    await expect(userQuery(identities.alice, 'update interactions set contact_id = $1 where id = $2',
      [tenants.bob.contact.id, tenants.alice.interaction.id])).rejects.toThrow('contact not found');
  });

  it('record_interaction remains security-invoker and cannot read, mutate, or return another organizer\'s contact', async () => {
    const call = (uid, contact) => userQuery(uid,
      "select record_interaction($1, now(), 'call', 'Synthetic RPC note', null, false) as result", [contact]);
    const before = (await userQuery(identities.bob, 'select * from contacts')).rows;
    await expect(call(identities.alice, tenants.bob.contact.id)).rejects.toThrow('contact not found');
    expect((await userQuery(identities.bob, 'select * from contacts')).rows).toEqual(before);
    expect((await userQuery(identities.bob, 'select * from interactions')).rows).toHaveLength(1);
    const { result } = (await call(identities.alice, tenants.alice.contact.id)).rows[0];
    expect(result.contact.user_id).toBe(identities.alice);
    expect(result.interaction.user_id).toBe(identities.alice);
    expect(result.contact.last_interaction_at).not.toBeNull();
  });

  it.each(['anon', 'authenticated'])('%s without a user identity cannot read or mutate private rows', async (role) => {
    for (const [table, , field, value] of privateTables) {
      const query = (sql, params) => asRole(db, role, null, (tx) => tx.query(sql, params));
      expect((await query(`select * from ${table}`)).rows).toEqual([]);
      expect((await query(`update ${table} set ${field} = $1 returning *`, [value])).rows).toEqual([]);
      expect((await query(`delete from ${table} returning *`)).rows).toEqual([]);
    }
    await expect(asRole(db, role, null, (tx) => tx.query(
      "insert into contacts (user_id, name, category) values ($1, 'Anonymous forgery', 'personal')", [identities.alice]))).rejects.toThrow(/row-level security/);
  });

  it('only the owner can read room guests, votes, and payment records directly, while guest writes require the server', async () => {
    for (const name of ['alice', 'bob']) {
      await asRole(db, 'service_role', null, async (tx) => {
        const attendee = (await tx.query(`insert into meetup_attendees (meetup_id, guest_name, secret_hash)
          values ($1, $2, 'synthetic-hash') returning id`, [tenants[name].meetup.id, `${name} guest`])).rows[0].id;
        await tx.query('insert into venue_votes (meetup_id, attendee_id, venue_id) values ($1, $2, $3)',
          [tenants[name].meetup.id, attendee, identities.venue]);
        await tx.query('insert into meetup_payments (meetup_id, attendee_id, amount_paise) values ($1, $2, 50000)',
          [tenants[name].meetup.id, attendee]);
      });
    }
    for (const table of ['meetup_attendees', 'venue_votes', 'meetup_payments']) {
      for (const name of ['alice', 'bob']) {
        const rows = (await userQuery(identities[name], `select * from ${table}`)).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0].meetup_id).toBe(tenants[name].meetup.id);
        expect((await userQuery(identities[name], `delete from ${table} returning *`)).rows).toEqual([]);
        expect((await userQuery(identities[name], `update ${table} set meetup_id = meetup_id returning *`)).rows).toEqual([]);
      }
      expect((await asRole(db, 'anon', null, (tx) => tx.query(`select * from ${table}`))).rows).toEqual([]);
    }
  });

  it('documents the service-role bypass: server routes, not RLS, must filter public responses and authenticate guests', async () => {
    for (const [table] of privateTables) {
      const result = await asRole(db, 'service_role', null, (tx) => tx.query(`select * from ${table}`));
      expect(result.rows).toHaveLength(table === 'balance_goals' ? 6 : 2);
    }
    expect((await asRole(db, 'service_role', null, (tx) => tx.query('select rolbypassrls from pg_roles where rolname = current_user'))).rows)
      .toEqual([{ rolbypassrls: true }]);
  });
});
