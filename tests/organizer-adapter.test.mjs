import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

let db, tenants;
const options = {
  organizerQueries: true, jsonRows: true,
  allowedTables: ['contacts', 'interactions', 'balance_goals', 'meetups'],
  allowedRpcs: ['record_interaction', 'contact_create_retry_ready', 'create_contacts_once'],
  defaultConflicts: { balance_goals: 'user_id,category' },
};
const client = (uid = identities.alice, changes = {}) => pgliteClient(db, uid ? 'authenticated' : 'anon', uid, { ...options, ...changes });
const sql = (query, params = []) => asRole(db, 'authenticated', identities.alice, (tx) => tx.query(query, params));
beforeAll(async () => { db = await privacyDatabase(); await db.exec("set timezone = 'UTC'"); }, 30_000);
beforeEach(async () => { tenants = await seedPrivateData(db); });
afterAll(async () => { await db?.close(); });

describe('bounded organizer PGlite adapter extensions', () => {
  it('keeps mutation RPCs and advanced query support opt-in and restricts tables/expressions', () => {
    const limited = pgliteClient(db, 'authenticated', identities.alice);
    expect(() => limited.rpc('record_interaction')).toThrow('Unsupported test RPC');
    expect(() => limited.from('contacts').gte('updated_at', '2026-01-01')).toThrow('not enabled');
    expect(() => client().from('google_connector_sessions')).toThrow('Unsupported test table');
    expect(() => client().rpc('arbitrary_function')).toThrow('Unsupported test RPC');
    expect(() => client().rpc('record_interaction', { unexpected: true })).toThrow('arguments');
    expect(() => client().from('meetups').or('starts_at.is.null,starts_at.gte.2026-10-25T00:00:00.000Z,organizer_id.neq.x')).toThrow('OR expression');
    expect(() => client().from('contacts').or('starts_at.is.null,starts_at.gte.2026-10-25T00:00:00.000Z')).toThrow('OR expression');
    expect(() => client().from('interactions').limit(101)).toThrow('test limit');
    expect(() => pgliteClient(db, 'authenticated', identities.alice, { allowedRpcs: ['unreviewed'] })).toThrow('allowlist');
  });

  it('preserves exact PostgreSQL timestamps without changing the old Date-based adapter default', async () => {
    const id = (await sql("insert into meetups(title, updated_at) values ('Precision', '2026-10-25T01:02:03.123456Z') returning id")).rows[0].id;
    const exact = (await client().from('meetups').select('*').eq('id', id).single()).data;
    expect(exact.updated_at).toBe('2026-10-25T01:02:03.123456+00:00');
    const old = (await pgliteClient(db, 'authenticated', identities.alice).from('meetups').select('*').eq('id', id).single()).data;
    expect(old.updated_at).toBeInstanceOf(Date);
    expect(old.updated_at.toISOString()).toBe('2026-10-25T01:02:03.123Z');
    const saved = await client().from('meetups').update({ title: 'Unrounded lock succeeds' }).eq('id', id).eq('updated_at', exact.updated_at).select('*').maybeSingle();
    expect(saved.error).toBeNull(); expect(saved.data.title).toBe('Unrounded lock succeeds');
    expect(saved.data.updated_at).toBe((await sql("select to_jsonb(m)->>'updated_at' as version from meetups m where id = $1", [id])).rows[0].version);
    expect((await client().from('meetups').update({ title: 'Stale' }).eq('id', id).eq('updated_at', exact.updated_at).select('*').maybeSingle()).data).toBeNull();
  });

  it('uses database defaults for heterogeneous bulk rows and binds hostile text as data', async () => {
    const result = await client().from('contacts').insert([
      { name: "Synthetic '); delete from contacts; --", category: 'personal', interests: ['games'] },
      { name: 'Synthetic second', category: 'community', notes: 'Only second row', email: 'second@example.test' },
    ]).select('*');
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({ user_id: identities.alice, interests: ['games'], notes: null, email: null });
    expect(result.data[1]).toMatchObject({ user_id: identities.alice, interests: [], notes: 'Only second row', email: 'second@example.test' });
    expect((await client().from('contacts').select('*')).data).toHaveLength(3);
    await expect(client().from('contacts').select('*').eq('id; drop table contacts', tenants.alice.contact.id)).rejects.toThrow('identifier');
  });

  it('executes owner-scoped upserts against the real composite primary key', async () => {
    const result = await client().from('balance_goals').upsert([
      { user_id: identities.alice, category: 'personal', target_percentage: 70 },
      { user_id: identities.alice, category: 'professional', target_percentage: 20 },
      { user_id: identities.alice, category: 'community', target_percentage: 10 },
    ]);
    expect(result.error).toBeNull();
    expect((await client().from('balance_goals').select('*')).data).toHaveLength(3);
    expect((await client(identities.bob).from('balance_goals').select('target_percentage').eq('category', 'personal').single()).data.target_percentage).toBe(30);
    const forbidden = await client().from('balance_goals').upsert({ user_id: identities.bob, category: 'personal', target_percentage: 99 });
    expect(forbidden.error.message).toMatch(/row-level security/);
  });

  it('calls the actual interaction function under real RLS and projects only owned contact relations', async () => {
    const args = { p_contact_id: tenants.alice.contact.id, p_occurred_at: '2026-10-25T01:02:03.123456Z', p_type: 'call', p_notes: 'Synthetic RPC', p_next_followup_at: null, p_set_next: false };
    const result = await client().rpc('record_interaction', args);
    expect(result.error).toBeNull(); expect(result.data.interaction.user_id).toBe(identities.alice);
    expect(result.data.contact.last_interaction_at).toBe('2026-10-25T01:02:03.123456+00:00');
    const forbidden = await client(identities.bob).rpc('record_interaction', args);
    expect(forbidden.error.message).toContain('contact not found');
    const recent = await client().from('interactions').select('*, contact:contacts(id, name, category)').gte('occurred_at', '2020-01-01T00:00:00Z').order('occurred_at', { ascending: false }).limit(100);
    expect(recent.error).toBeNull();
    expect(recent.data.every((row) => row.user_id === identities.alice && row.contact.id === tenants.alice.contact.id)).toBe(true);
    await expect(client(identities.alice, { allowedTables: ['interactions'] }).from('interactions').select('*, contact:contacts(id, name, category)')).rejects.toThrow('relationship');
    const anonymous = await client(null).from('interactions').select('*, contact:contacts(id, name, category)');
    expect(anonymous.data).toEqual([]);
  });

  it('uses the actual receipt functions and honors pre-aborted calls without inserting', async () => {
    const ready = await client().rpc('contact_create_retry_ready').abortSignal(AbortSignal.timeout(1_500));
    expect(ready).toEqual({ data: true, error: null });
    const args = { p_intent: '77777777-7777-4777-8777-777777777777', p_contacts: [{ name: 'Receipt synthetic', category: 'personal' }] };
    const aborted = await client().rpc('create_contacts_once', args).abortSignal(AbortSignal.abort());
    expect(aborted.error).not.toBeNull();
    expect((await client().from('contacts').select('*')).data).toHaveLength(1);
    const first = await client().rpc('create_contacts_once', args);
    const repeat = await client().rpc('create_contacts_once', args);
    expect(first.error).toBeNull(); expect(repeat.data.created_ids).toEqual(first.data.created_ids);
    expect((await client().from('contacts').select('*')).data).toHaveLength(2);
  });
});
