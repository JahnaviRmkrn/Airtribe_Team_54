import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const lease = '33333333-3333-4333-8333-333333333333', action = '44444444-4444-4444-8444-444444444444';
const anotherAction = '55555555-5555-4555-8555-555555555555';
const session = 'a'.repeat(64), hash = 'b'.repeat(64);
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key); insert into auth.users values('${owner}'),('${other}');
    create type life_category as enum('personal','professional','community');
    create table contacts(id uuid primary key default gen_random_uuid(),user_id uuid,name text,email text,category life_category,interests text[],notes text);`);
  for (const name of ['20261025110000_google_contact_import.sql', '20261025113000_google_confirmed_actions.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
}, 30000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('reset role; truncate google_confirmed_actions, google_connector_sessions;');
  await db.query("insert into google_connector_sessions(id,user_id,purpose,encrypted_payload,expires_at,lease,locked_until) values($1,$2,'gmail','synthetic',now()+interval '15 minutes',$3,now()+interval '30 seconds')", [session, owner, lease]);
});
const preview = (opts: { id?: string; owner?: string; purpose?: string; session?: string; lease?: string; hash?: string } = {}) => db.query<{ id: string; state: string }>('select * from create_google_action_preview($1,$2,$3,$4,$5,$6,$7)', [opts.id || action, opts.owner || owner, opts.purpose || 'gmail', opts.session || session, opts.lease || lease, opts.hash || hash, 'encrypted-synthetic']);
const claim = (opts: { owner?: string; purpose?: string; session?: string; lease?: string; hash?: string } = {}) => db.query('select * from claim_google_confirmed_action($1,$2,$3,$4,$5,$6)', [action, opts.owner || owner, opts.purpose || 'gmail', opts.session || session, opts.lease || lease, opts.hash || hash]);

describe('durable one-time action SQL', () => {
  it.each(['anon', 'authenticated'])('denies %s access, preview, claim and cleanup', async (role) => {
    await db.exec(`set role ${role}`);
    await expect(db.query('select * from google_confirmed_actions')).rejects.toThrow('permission denied');
    await expect(preview()).rejects.toThrow('permission denied'); await expect(claim()).rejects.toThrow('permission denied');
    await expect(db.query('select cleanup_google_confirmed_actions()')).rejects.toThrow('permission denied');
  });
  it('allows the service role and serializes repeated/concurrent claims', async () => {
    await db.exec('set role service_role'); await preview();
    const results = await Promise.all([claim(), claim()]);
    expect(results.map((r) => r.rows.length).sort()).toEqual([0, 1]); expect((await claim()).rows).toEqual([]);
  });
  it('makes preview retries idempotent and editing invalidates old confirmation', async () => {
    await preview(); const same = await preview({ id: anotherAction }); expect(same.rows[0].id).toBe(action);
    await preview({ id: anotherAction, hash: 'c'.repeat(64) });
    expect((await claim()).rows).toEqual([]); expect((await db.query('select state from google_confirmed_actions where id=$1', [action])).rows[0]).toEqual({ state: 'cancelled' });
  });
  it('binds owner, purpose, session, lease and exact preview hash', async () => {
    await preview();
    for (const opts of [{ owner: other }, { purpose: 'calendar' }, { session: 'c'.repeat(64) }, { lease: other }]) await expect(claim(opts)).rejects.toThrow('connector_expired');
    expect((await claim({ hash: 'c'.repeat(64) })).rows).toEqual([]);
    expect((await claim()).rows).toHaveLength(1);
  });
  it('cancel, expiration and an expired lease prevent any claim', async () => {
    await preview(); await db.exec("update google_confirmed_actions set state='cancelled'"); expect((await claim()).rows).toEqual([]);
    await db.exec('truncate google_confirmed_actions');
    await db.query("insert into google_confirmed_actions(id,user_id,purpose,session_id,preview_hash,encrypted_preview,expires_at) values($1,$2,'gmail',$3,$4,'synthetic',now()-interval '1 second')", [action, owner, session, hash]);
    expect((await claim()).rows).toEqual([]);
    await db.exec("update google_connector_sessions set locked_until=now()-interval '1 second'"); await expect(claim()).rejects.toThrow('connector_expired');
  });
  it('retains replay protection after OAuth session expiry, cleanup and reconnect', async () => {
    await preview(); await claim();
    await db.exec("update google_confirmed_actions set state='uncertain'; update google_connector_sessions set expires_at=now()-interval '1 second'; select cleanup_google_connector_sessions();");
    expect((await db.query('select * from google_connector_sessions')).rows).toHaveLength(0);
    expect((await db.query('select state from google_confirmed_actions')).rows[0]).toEqual({ state: 'uncertain' });
    const next = 'd'.repeat(64);
    await db.query("insert into google_connector_sessions(id,user_id,purpose,encrypted_payload,expires_at,lease,locked_until) values($1,$2,'gmail','synthetic',now()+interval '15 minutes',$3,now()+interval '30 seconds')", [next, owner, lease]);
    const result = await preview({ id: anotherAction, session: next }); expect(result.rows[0]).toMatchObject({ id: action, state: 'uncertain' });
    expect((await claim({ session: next })).rows).toEqual([]);
  });
  it('forbids mutation of preview content and reset/retry of a claimed action', async () => {
    await preview();
    await expect(db.query("update google_confirmed_actions set encrypted_preview='tampered'")).rejects.toThrow('immutable_google_preview');
    await expect(db.query('update google_confirmed_actions set preview_hash=$1', ['d'.repeat(64)])).rejects.toThrow('immutable_google_preview');
    await claim(); await expect(db.query("update google_confirmed_actions set state='preview'")).rejects.toThrow('invalid_google_action_transition');
    await db.exec("update google_confirmed_actions set state='uncertain'; update google_confirmed_actions set state='completed',provider_ref='provider-id';");
    await expect(db.query("update google_confirmed_actions set state='claimed'")).rejects.toThrow('invalid_google_action_transition');
  });
  it('clears old encrypted contents but preserves action tombstones', async () => {
    await db.query("insert into google_confirmed_actions(id,user_id,purpose,session_id,preview_hash,encrypted_preview,state,created_at,expires_at) values($1,$2,'gmail',$3,$4,'synthetic','claimed',now()-interval '8 days',now()-interval '8 days')", [action, owner, session, hash]);
    await db.exec('select cleanup_google_confirmed_actions()');
    expect((await db.query('select state,encrypted_preview from google_confirmed_actions')).rows).toEqual([{ state: 'claimed', encrypted_preview: null }]);
  });
  it('cancellation racing with claim never returns both a cancellable and claimable action', async () => {
    await preview();
    await Promise.all([claim(), db.query("update google_confirmed_actions set state='cancelled' where id=$1 and state='preview'", [action])]);
    const state = (await db.query<{ state: string }>('select state from google_confirmed_actions')).rows[0].state;
    expect(['claimed', 'cancelled']).toContain(state); expect((await claim()).rows).toEqual([]);
  });
});
