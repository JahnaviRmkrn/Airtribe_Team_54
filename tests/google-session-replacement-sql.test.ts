import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Real in-memory PostgreSQL statements cover both serialized race orderings.
// PGlite is single-connection; this is not production concurrency load testing.
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const lease = '33333333-3333-4333-8333-333333333333';
const oldId = 'a'.repeat(64); const newId = 'b'.repeat(64);
let db: PGlite;
let protectedUpgradeSession = false;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key); insert into auth.users values ('${owner}'),('${other}');
    create type life_category as enum('personal','professional','community');
    create table contacts(id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), name text not null, email text, category life_category not null, interests text[] not null default '{}', notes text);`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261025110000_google_contact_import.sql', import.meta.url), 'utf8'));
  await db.query("insert into google_connector_sessions(id,user_id,purpose,encrypted_payload,expires_at) values($1,$2,'sheets-export','unclassified-pre-migration-state',now()+interval '15 minutes')", [oldId, owner]);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261025114000_google_session_replacement.sql', import.meta.url), 'utf8'));
  protectedUpgradeSession = (await db.query<{ protected_action: boolean }>('select protected_action from google_connector_sessions')).rows[0].protected_action;
}, 30_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('reset role; truncate contacts, google_connector_sessions;'); });
const replace = (id = oldId, purpose = 'sheets-export', who = owner) => db.query("select replace_google_connector_session($1,$2,$3,'encrypted-synthetic',now()+interval '15 minutes')", [id, who, purpose]);
const claim = (id = oldId, purpose = 'sheets-export') => db.query('select * from claim_google_connector_session($1,$2,$3,$4)', [id, owner, purpose, lease]);
const rows = () => db.query<{ id: string; protected_action: boolean; lease: string | null; encrypted_payload: string }>('select id,protected_action,lease,encrypted_payload from google_connector_sessions order by id');

describe('atomic Google session replacement', () => {
  it('conservatively protects live ciphertext already present during migration', () => { expect(protectedUpgradeSession).toBe(true); });
  it.each(['anon', 'authenticated'])('rejects %s replacement and marker access', async role => {
    await db.exec(`set role ${role}`);
    await expect(replace()).rejects.toThrow('permission denied');
    await expect(db.exec('select protected_action from google_connector_sessions')).rejects.toThrow('permission denied');
    await expect(db.exec('select google_connector_session_ready()')).rejects.toThrow('permission denied');
  });
  it('reports full schema capability only through the service-only read probe', async () => {
    await db.exec('set role service_role');
    expect((await db.query('select google_connector_session_ready() ready')).rows).toEqual([{ ready: true }]);
  });
  it('reports not-ready if a partial migration is missing the atomic replacement function', async () => {
    await expect(db.transaction(async tx => {
      await tx.exec('drop function replace_google_connector_session(text,uuid,text,text,timestamptz)');
      expect((await tx.query('select google_connector_session_ready() ready')).rows).toEqual([{ ready: false }]);
      throw new Error('Rollback the synthetic schema probe');
    })).rejects.toThrow('Rollback the synthetic schema probe');
  });
  it.each(['contacts', 'sheets-import', 'sheets-export', 'gmail', 'calendar'])('supports isolated %s creation and safe unprotected replacement', async purpose => {
    await db.exec('set role service_role'); await replace(oldId, purpose); await replace(newId, purpose);
    expect((await rows()).rows).toEqual([{ id: newId, protected_action: false, lease: null, encrypted_payload: 'encrypted-synthetic' }]);
  });
  it('checks owner/purpose protected intent without any cookie or caller-supplied previous session ID', async () => {
    await replace(); await db.exec("update google_connector_sessions set protected_action=true, encrypted_payload='uncertain-create-receipt'");
    await expect(replace(newId)).rejects.toThrow('connector_action_pending');
    expect((await rows()).rows).toEqual([{ id: oldId, protected_action: true, lease: null, encrypted_payload: 'uncertain-create-receipt' }]);
  });
  it('claim-first race rejects reconnect before the action checkpoint exists', async () => {
    await replace();
    const outcomes = await Promise.allSettled([claim(), replace(newId)]);
    expect(outcomes[0].status).toBe('fulfilled'); expect(outcomes[1].status).toBe('rejected');
    expect((await rows()).rows[0]).toMatchObject({ id: oldId, lease, protected_action: false });
  });
  it('replacement-first race invalidates the old confirmation handle before it can claim', async () => {
    await replace();
    const [replacement, claimed] = await Promise.all([replace(newId), claim()]);
    expect(replacement).toBeDefined(); expect(claimed.rows).toEqual([]);
    expect((await rows()).rows[0].id).toBe(newId);
  });
  it('checkpoint then lease release keeps the receipt protected across the connect precheck gap', async () => {
    await replace(); await claim();
    await db.query("update google_connector_sessions set protected_action=true,encrypted_payload='creating-intent' where id=$1 and lease=$2", [oldId, lease]);
    await db.query('update google_connector_sessions set lease=null,locked_until=null where id=$1 and lease=$2', [oldId, lease]);
    await expect(replace(newId)).rejects.toThrow('connector_action_pending');
    expect((await rows()).rows[0]).toMatchObject({ id: oldId, protected_action: true, encrypted_payload: 'creating-intent' });
  });
  it('an expired lease does not make an unresolved action replaceable', async () => {
    await replace();
    await db.exec("update google_connector_sessions set protected_action=true,locked_until=now()-interval '1 second'");
    await expect(replace(newId)).rejects.toThrow('connector_action_pending');
  });
  it('replacement cannot erase an active lease even when session expiry just passed', async () => {
    await replace(); await claim();
    await db.exec("update google_connector_sessions set expires_at=now()-interval '1 second'");
    await expect(replace(newId)).rejects.toThrow('connector_busy');
    expect((await rows()).rows[0].id).toBe(oldId);
  });
  it('ordinary final saves and stale leases cannot clear protected action state', async () => {
    await replace(); await claim();
    await db.exec('update google_connector_sessions set protected_action=true');
    await db.query("update google_connector_sessions set encrypted_payload='uncertain-write-receipt',lease=null,locked_until=null where id=$1 and lease=$2", [oldId, lease]);
    // The old lease has no authority to overwrite the receipt after release.
    const stale = await db.query("update google_connector_sessions set encrypted_payload='stale-payload' where id=$1 and lease=$2 returning id", [oldId, lease]);
    expect(stale.rows).toEqual([]);
    expect((await rows()).rows[0]).toMatchObject({ protected_action: true, encrypted_payload: 'uncertain-write-receipt' });
    await expect(replace(newId)).rejects.toThrow('connector_action_pending');
  });
  it('protects only the same owner and purpose', async () => {
    await replace(); await db.exec('update google_connector_sessions set protected_action=true');
    await replace(newId, 'sheets-import'); await replace('c'.repeat(64), 'sheets-export', other);
    expect((await rows()).rows).toHaveLength(3);
  });
  it('allows explicit disconnect or original expired retention to begin a new session', async () => {
    await replace(); await db.exec('update google_connector_sessions set protected_action=true');
    await db.query('delete from google_connector_sessions where user_id=$1 and purpose=$2', [owner, 'sheets-export']);
    await replace(newId);
    await db.exec("update google_connector_sessions set protected_action=true,expires_at=now()-interval '1 second'");
    await replace(oldId);
    expect((await rows()).rows[0]).toMatchObject({ id: oldId, protected_action: false });
  });
  it('does not let a skipped name-only row suppress a later distinct nonempty email', async () => {
    await replace(oldId, 'sheets-import'); await claim(oldId, 'sheets-import');
    const candidates = [{ name: 'Ada', email: 'a@example.test', category: 'personal' }, { name: 'Ada', email: null, category: 'personal' }, { name: 'Ada', email: 'b@example.test', category: 'personal' }];
    const result = await db.query<{ result: { added: number; skipped: number } }>("select import_google_contacts($1,$2,'sheets-import',$3,$4::jsonb) result", [oldId, owner, lease, JSON.stringify(candidates)]);
    expect(result.rows[0].result).toEqual({ added: 2, skipped: 1 });
    expect((await db.query('select email from contacts order by email')).rows).toEqual([{ email: 'a@example.test' }, { email: 'b@example.test' }]);
  });
});
