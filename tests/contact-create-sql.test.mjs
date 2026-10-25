import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRole, identities, privacyDatabase } from './helpers/privacy-db.mjs';
// Real in-memory PostgreSQL, all authored migrations except Vault. No application
// env loading, Supabase connection, provider calls, or external database.
let db;
const key = '44444444-4444-4444-8444-444444444444';
const otherKey = '55555555-5555-4555-8555-555555555555';
const candidate = { name: 'Alice', category: 'personal', interests: [] };
const query = (owner, sql, params = []) => asRole(db, 'authenticated', owner, (tx) => tx.query(sql, params));
const create = async (rows = [candidate], owner = identities.alice, intent = key) =>
  (await query(owner, 'select create_contacts_once($1,$2::jsonb) as receipt', [intent, JSON.stringify(rows)])).rows[0].receipt;
beforeAll(async () => { db = await privacyDatabase(); }, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate auth.users cascade');
  await db.query('insert into auth.users values($1),($2)', [identities.alice, identities.bob]);
});
describe('atomic owner-scoped contact creation receipts', () => {
  it('replays exact immutable IDs/timestamps after a lost response and repeated requests', async () => {
    const committed = await create(); // Pretend the network drops this reply.
    expect(await create()).toEqual(committed);
    expect(await create()).toEqual(committed);
    expect((await query(identities.alice, 'select * from contacts')).rows).toHaveLength(1);
    expect((await query(identities.alice, 'select * from contact_create_intents')).rows).toHaveLength(1);
  });
  it('serializes submitted retries atomically, and rejects changed payloads without overwriting', async () => {
    // PGlite queues database work. This exercises transactional overlap/replay;
    // production PostgreSQL contention is enforced by the advisory lock + PK.
    const responses = await Promise.all(Array.from({ length: 5 }, () => create()));
    expect(responses.every((receipt) => JSON.stringify(receipt) === JSON.stringify(responses[0]))).toBe(true);
    await expect(create([{ ...candidate, category: 'professional' }])).rejects.toThrow('contact_intent_conflict');
    expect((await query(identities.alice, 'select category from contacts')).rows).toEqual([{ category: 'personal' }]);
  });
  it('allows distinct contacts with identical names and distinct intents, including within a batch', async () => {
    await create([candidate, candidate]); await create([candidate], identities.alice, otherKey);
    expect((await query(identities.alice, 'select * from contacts')).rows).toHaveLength(3);
  });
  it('never overwrites edits or resurrects deleted contacts when an old key is retried', async () => {
    const receipt = await create(); const id = receipt.contacts[0].id;
    await query(identities.alice, "update contacts set name='Edited', category='professional' where id=$1", [id]);
    const edited = await create();
    expect(edited.created_ids).toEqual(receipt.created_ids); expect(edited.contacts[0].name).toBe('Edited');
    expect((await query(identities.alice, 'select name from contacts')).rows).toEqual([{ name: 'Edited' }]);
    await query(identities.alice, 'delete from contacts where id=$1', [id]);
    expect(await create()).toEqual({ contacts: [], created_ids: [id], missing_ids: [id] });
    expect((await query(identities.alice, 'select * from contacts')).rows).toEqual([]);
  });
  it('isolates owner receipts even for the same key and cannot accept a forged owner', async () => {
    const alice = await create();
    expect((await query(identities.bob, 'select * from contact_create_intents')).rows).toEqual([]);
    const bob = await create([candidate], identities.bob);
    expect(alice.contacts[0].user_id).toBe(identities.alice); expect(bob.contacts[0].user_id).toBe(identities.bob);
    expect(alice.contacts[0].id).not.toBe(bob.contacts[0].id);
    await expect(create([{ ...candidate, user_id: identities.bob }], identities.alice, otherKey)).rejects.toThrow('invalid_contact_field');
  });
  it('denies anonymous execution, identity-free execution, and direct receipt writes even by the owner', async () => {
    await create();
    await expect(asRole(db, 'anon', null, (tx) => tx.query('select create_contacts_once($1,$2)', [key, JSON.stringify([candidate])]))).rejects.toThrow('permission denied');
    await expect(create([candidate], null)).rejects.toThrow('contact_auth_required');
    for (const sql of ['delete from contact_create_intents', "update contact_create_intents set request_digest=repeat('0',64)", `insert into contact_create_intents(user_id,intent_id,request_digest,contact_ids) values('${identities.alice}','${otherKey}',repeat('0',64),array['${key}']::uuid[])`]) {
      await expect(query(identities.alice, sql)).rejects.toThrow('permission denied');
    }
  });
  it.each([null, {}, [], Array(6).fill(candidate), [null], [{ ...candidate, name: '' }], [{ ...candidate, name: '\t\n' }], [{ ...candidate, name: 1 }], [{ ...candidate, name: 'a'.repeat(121) }], [{ ...candidate, category: null }], [{ ...candidate, category: 'work' }], [{ ...candidate, interests: null }], [{ ...candidate, interests: [1] }], [{ ...candidate, interests: ['\t'] }], [{ ...candidate, interests: Array(21).fill('a') }], [{ ...candidate, notes: {} }], [{ ...candidate, notes: 'a'.repeat(5001) }], [{ ...candidate, email: 'invalid' }], [{ ...candidate, preferred_frequency_days: 1.5 }], [{ ...candidate, preferred_frequency_days: 366 }], [{ ...candidate, next_followup_at: 'tomorrow' }], [{ ...candidate, next_followup_at: '2026-99-99T12:00:00Z' }], [{ ...candidate, id: key }]])('rejects malformed direct-RPC payload %# without writes', async (rows) => {
    await expect(create(rows)).rejects.toThrow();
    expect((await query(identities.alice, 'select * from contacts')).rows).toEqual([]);
    expect((await query(identities.alice, 'select * from contact_create_intents')).rows).toEqual([]);
  });
  it('rolls back earlier rows if a later row fails validation', async () => {
    await expect(create([candidate, { ...candidate, notes: true }])).rejects.toThrow();
    expect((await query(identities.alice, 'select * from contacts')).rows).toEqual([]);
    expect((await query(identities.alice, 'select * from contact_create_intents')).rows).toEqual([]);
    expect((await create()).contacts).toHaveLength(1);
  });
  it('supports every create field and nullable defaults', async () => {
    const full = { ...candidate, interests: [' chess '], notes: 'Note', email: 'alice@example.test', preferred_frequency_days: 14, next_followup_at: '2026-11-01T12:00:00Z', last_interaction_at: null };
    const saved = (await create([full])).contacts[0];
    expect(saved).toMatchObject({ ...full, interests: ['chess'], next_followup_at: expect.any(String) });
    expect(new Date(saved.next_followup_at).toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });
  it('stores no contact names, notes, emails, or full JSON payload after contact deletion', async () => {
    const sensitive = { ...candidate, name: 'Private contact name', notes: 'Private note sentinel', email: 'private@example.test' };
    const result = await create([sensitive]);
    await query(identities.alice, 'delete from contacts');
    const receipts = (await query(identities.alice, 'select * from contact_create_intents')).rows;
    expect(Object.keys(receipts[0]).sort()).toEqual(['user_id', 'intent_id', 'request_digest', 'contact_ids', 'created_at'].sort());
    expect(JSON.stringify(receipts)).not.toMatch(/Private|private@example|personal|notes/);
    expect((await create([sensitive]))).toEqual({ contacts: [], created_ids: result.created_ids, missing_ids: result.created_ids });
    await expect(create([{ ...sensitive, notes: 'Changed' }])).rejects.toThrow('contact_intent_conflict');
  });

});


describe('contact retry migration readiness', () => {
  it('uses a unique migration version without colliding with published payment receipts', () => {
    const files = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((name) => name.endsWith('.sql'));
    expect(files).toContain('20261025121000_contact_create_intents.sql');
    expect(files).not.toContain('20261025120000_contact_create_intents.sql');
    const versions = files.map((name) => name.split('_')[0]);
    expect(new Set(versions).size).toBe(versions.length);
  });
  it('reports readiness without creating or changing contacts or compact receipts', async () => {
    expect((await query(identities.alice, 'select contact_create_retry_ready() as ready')).rows).toEqual([{ ready: true }]);
    expect((await query(identities.alice, 'select * from contacts')).rows).toEqual([]);
    expect((await query(identities.alice, 'select * from contact_create_intents')).rows).toEqual([]);
    expect((await query(null, 'select contact_create_retry_ready() as ready')).rows).toEqual([{ ready: false }]);
    await expect(asRole(db, 'anon', null, (tx) => tx.query('select contact_create_retry_ready()'))).rejects.toThrow('permission denied');
  });
  it('does not report readiness if the create RPC is absent or its execute permission is revoked', async () => {
    await db.exec('alter function public.create_contacts_once(uuid,jsonb) rename to unavailable_create_contacts_once');
    try {
      expect((await query(identities.alice, 'select contact_create_retry_ready() as ready')).rows).toEqual([{ ready: false }]);
    } finally { await db.exec('alter function public.unavailable_create_contacts_once(uuid,jsonb) rename to create_contacts_once'); }
    await db.exec('revoke execute on function public.create_contacts_once(uuid,jsonb) from authenticated');
    try {
      expect((await query(identities.alice, 'select contact_create_retry_ready() as ready')).rows).toEqual([{ ready: false }]);
    } finally { await db.exec('grant execute on function public.create_contacts_once(uuid,jsonb) to authenticated'); }
  });
  it('does not report readiness if receipt table access is unavailable', async () => {
    await db.exec('revoke select on public.contact_create_intents from authenticated');
    try {
      expect((await query(identities.alice, 'select contact_create_retry_ready() as ready')).rows).toEqual([{ ready: false }]);
    } finally { await db.exec('grant select on public.contact_create_intents to authenticated'); }
  });
});
