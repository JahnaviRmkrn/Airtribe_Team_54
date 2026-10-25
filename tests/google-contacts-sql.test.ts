import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Entirely in-memory PostgreSQL. No application bootstrap, environment files,
// Vault, deployed database, Supabase client, or provider requests are used.
const migration = readFileSync(new URL('../supabase/migrations/20261025110000_google_contact_import.sql', import.meta.url), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const lease = '33333333-3333-4333-8333-333333333333';
const sessionId = 'a'.repeat(64);
let db: PGlite;
const candidate = { name: 'Alice', email: 'alice@example.test', category: 'personal' };

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values ('${owner}'), ('${other}');
    create type life_category as enum('personal', 'professional', 'community');
    create table public.contacts(id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), name text not null, email text, category life_category not null, interests text[] not null default '{}', notes text);
  `);
  await db.exec(migration);
}, 30000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('reset role; truncate contacts, google_connector_sessions;');
  await db.query('insert into google_connector_sessions(id,user_id,purpose,encrypted_payload,expires_at,lease,locked_until) values ($1,$2,$3,$4,now()+interval \'15 minutes\',$5,now()+interval \'30 seconds\')', [sessionId, owner, 'contacts', 'encrypted-synthetic', lease]);
});
const runImport = (rows: unknown[], opts: { session?: string; owner?: string; purpose?: string; lease?: string } = {}) => db.query<{ result: { added: number; skipped: number } }>('select import_google_contacts($1,$2,$3,$4,$5::jsonb) as result', [opts.session || sessionId, opts.owner || owner, opts.purpose || 'contacts', opts.lease || lease, JSON.stringify(rows)]);

describe('Google Contacts service-only SQL', () => {
  it.each(['anon', 'authenticated'])('denies %s session access and all privileged RPCs', async (role) => {
    await db.exec(`set role ${role}`);
    await expect(db.query('select * from google_connector_sessions')).rejects.toThrow('permission denied');
    await expect(db.query('select * from claim_google_connector_session($1,$2,$3,$4)', [sessionId, owner, 'contacts', lease])).rejects.toThrow('permission denied');
    await expect(runImport([candidate])).rejects.toThrow('permission denied');
    await expect(db.query('select * from preview_google_contact_duplicates($1,$2)', [owner, '[]'])).rejects.toThrow('permission denied');
  });
  it('permits service-role operations and reports exact inserted/skipped counts', async () => {
    await db.exec('set role service_role');
    const result = await runImport([candidate]);
    expect(result.rows[0].result).toEqual({ added: 1, skipped: 0 });
  });
  it('retries and overlapping imports do not duplicate or overwrite an existing category', async () => {
    const results = await Promise.all([runImport([candidate]), runImport([{ ...candidate, email: 'ALICE@example.test', category: 'professional' }])]);
    expect(results.map((result) => result.rows[0].result.added).sort()).toEqual([0, 1]);
    expect((await db.query('select * from contacts')).rows).toHaveLength(1);
    expect((await runImport([candidate])).rows[0].result).toEqual({ added: 0, skipped: 1 });
    expect((await db.query('select category from contacts')).rows[0]).toEqual({ category: 'personal' });
  });
  it('deduplicates name-only contacts, but distinguishes different email addresses', async () => {
    await runImport([{ ...candidate, email: null }]);
    expect((await runImport([{ ...candidate, name: ' ALICE ' }])).rows[0].result.added).toBe(0);
    await db.exec('truncate contacts');
    await runImport([candidate]);
    expect((await runImport([{ ...candidate, email: 'different@example.test' }])).rows[0].result.added).toBe(1);
  });
  it('does not confuse another owner’s contacts with duplicates', async () => {
    await db.query('insert into contacts(user_id,name,email,category) values($1,$2,$3,$4)', [other, candidate.name, candidate.email, candidate.category]);
    expect((await runImport([candidate])).rows[0].result.added).toBe(1);
    expect((await db.query('select * from contacts')).rows).toHaveLength(2);
  });
  it.each([{ owner: other }, { purpose: 'sheets' }, { purpose: 'gmail' }, { lease: other }, { session: 'b'.repeat(64) }])('rejects owner, purpose, lease or session substitution: %j', async (opts) => {
    await expect(runImport([candidate], opts)).rejects.toThrow();
    expect((await db.query('select * from contacts')).rows).toEqual([]);
  });
  it('rejects expired/cancelled sessions and batches larger than the onboarding limit', async () => {
    await expect(runImport(Array(6).fill(candidate))).rejects.toThrow('invalid_import_batch');
    await db.exec("update google_connector_sessions set expires_at = now() - interval '1 second'");
    await expect(runImport([candidate])).rejects.toThrow('connector_expired');
    await db.exec('delete from google_connector_sessions');
    await expect(runImport([candidate])).rejects.toThrow('connector_expired');
  });
  it('rolls back the whole batch if a later candidate is invalid', async () => {
    await expect(runImport([candidate, { ...candidate, name: '' }])).rejects.toThrow('invalid_import_contact');
    expect((await db.query('select * from contacts')).rows).toEqual([]);
  });
  it('accepts explicitly mapped bounded Sheets fields without changing Contacts defaults', async () => {
    await runImport([candidate]);
    expect((await db.query('select interests,notes from contacts')).rows[0]).toEqual({ interests: [], notes: null });
    await runImport([{ name: 'Bob', email: null, category: 'professional', interests: [' chess '], notes: 'Explicit note' }]);
    expect((await db.query("select interests,notes from contacts where name='Bob'")).rows[0]).toEqual({ interests: ['chess'], notes: 'Explicit note' });
    await expect(runImport([{ ...candidate, interests: Array(21).fill('tag') }])).rejects.toThrow('invalid_import_interests');
    await expect(runImport([{ ...candidate, notes: 'x'.repeat(5001) }])).rejects.toThrow('invalid_import_notes');
  });
  it('returns only preview IDs matching existing contacts for this owner', async () => {
    await runImport([candidate]);
    const rows = [{ ...candidate, id: 'preview-id' }, { name: 'Other', email: null, id: 'new-id' }];
    expect((await db.query('select * from preview_google_contact_duplicates($1,$2)', [owner, JSON.stringify(rows)])).rows).toEqual([{ id: 'preview-id' }]);
    expect((await db.query('select * from preview_google_contact_duplicates($1,$2)', [other, JSON.stringify(rows)])).rows).toEqual([]);
  });
  it('claims sessions only for correct owner/purpose and prevents concurrent lease acquisition', async () => {
    await db.exec('update google_connector_sessions set locked_until = null');
    const claim = (who = owner, purpose = 'contacts') => db.query('select * from claim_google_connector_session($1,$2,$3,$4)', [sessionId, who, purpose, lease]);
    expect((await claim(other)).rows).toEqual([]);
    expect((await claim(owner, 'sheets')).rows).toEqual([]);
    expect((await claim()).rows).toHaveLength(1);
    await expect(claim()).rejects.toThrow('connector_busy');
  });
  it('removes expired credentials during claim and scheduled cleanup', async () => {
    await db.exec("update google_connector_sessions set expires_at = now() - interval '1 second'");
    expect((await db.query('select * from claim_google_connector_session($1,$2,$3,$4)', [sessionId, owner, 'contacts', lease])).rows).toEqual([]);
    expect((await db.query('select * from google_connector_sessions')).rows).toEqual([]);
    await db.query("insert into google_connector_sessions(id,user_id,purpose,encrypted_payload,expires_at) values($1,$2,'contacts','encrypted',now()-interval '1 second')", [sessionId, owner]);
    await db.exec('select cleanup_google_connector_sessions()');
    expect((await db.query('select * from google_connector_sessions')).rows).toEqual([]);
  });
});
