import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, privacyDatabase } from './helpers/privacy-db.mjs';
const purposes = ['contacts', 'sheets-import', 'sheets-export', 'gmail', 'calendar'];
const probe = async (db, purpose) => (await db.query('select public.google_connector_purpose_ready($1) ready', [purpose])).rows[0].ready;
let db;
beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
afterAll(async () => { await db?.close(); });
async function changed(sql, expected) {
  await expect(db.transaction(async tx => {
    await tx.exec(sql);
    for (const purpose of purposes) expect(await probe(tx, purpose), purpose).toBe(!expected.includes(purpose));
    throw new Error('Rollback synthetic schema change');
  })).rejects.toThrow('Rollback synthetic schema change');
}
describe('purpose-specific service-only Google capability probe', () => {
  it.each(purposes)('is ready for fully installed %s without reading Vault or writing anything', async purpose => {
    await asRole(db, 'service_role', null, async tx => {
      await tx.exec('set transaction read only');
      expect(await probe(tx, purpose)).toBe(true);
    });
  });
  it.each([null, '', 'unknown', 'GMAIL', 'toString'])('fails closed for unknown purpose %s', async purpose => {
    expect(await asRole(db, 'service_role', null, tx => probe(tx, purpose))).toBe(false);
  });
  it.each(['anon', 'authenticated'])('denies %s access instead of pretending a permission error is missing schema', async role => {
    await expect(asRole(db, role, null, tx => probe(tx, 'gmail'))).rejects.toThrow(/permission denied/);
  });
  it('supports a real partial deployment without the optional action migration', async () => {
    const partial = await privacyDatabase({ skipMigrations: ['20261025113000_google_confirmed_actions.sql'] });
    try {
      // This reproduces the old false-positive capability check.
      expect((await partial.query('select google_connector_session_ready() ready')).rows[0].ready).toBe(true);
      for (const purpose of purposes) expect(await probe(partial, purpose), purpose).toBe(!['gmail', 'calendar'].includes(purpose));
    } finally { await partial.close(); }
  }, 30_000);
  it.each([
    'drop function public.google_contact_matches(text,text,text,text)',
    'drop function public.preview_google_contact_duplicates(uuid,jsonb)',
    'drop function public.import_google_contacts(text,uuid,text,uuid,jsonb)',
  ])('requires import prerequisites only for Contacts and Sheets import: %s', async sql => {
    await changed(sql, ['contacts', 'sheets-import']);
  });
  it.each([
    'drop table public.google_connector_sessions cascade',
    'drop function public.claim_google_connector_session(text,uuid,text,uuid)',
    'drop function public.replace_google_connector_session(text,uuid,text,text,timestamptz)',
    'drop function public.cleanup_google_connector_sessions()',
    'alter table public.google_connector_sessions drop column protected_action',
    'alter table public.google_connector_sessions drop column lease',
    'alter table public.google_connector_sessions disable row level security',
    'revoke update on public.google_connector_sessions from service_role',
    'grant select on public.google_connector_sessions to authenticated',
    'revoke execute on function public.claim_google_connector_session(text,uuid,text,uuid) from service_role',
    'grant execute on function public.replace_google_connector_session(text,uuid,text,text,timestamptz) to anon',
  ])('requires intact shared session infrastructure: %s', async sql => { await changed(sql, purposes); });
  it.each([
    'drop table public.google_confirmed_actions cascade',
    'drop function public.guard_google_action_transition() cascade',
    'drop function public.create_google_action_preview(uuid,uuid,text,text,uuid,text,text)',
    'drop function public.claim_google_confirmed_action(uuid,uuid,text,text,uuid,text)',
    'drop function public.cleanup_google_confirmed_actions()',
    'drop trigger google_action_transition on public.google_confirmed_actions',
    'alter table public.google_confirmed_actions disable trigger google_action_transition',
    'alter table public.google_confirmed_actions drop column finished_at',
    'alter table public.google_confirmed_actions disable row level security',
    'revoke insert on public.google_confirmed_actions from service_role',
  ])('requires all confirmed action/transition infrastructure, not just its table: %s', async sql => { await changed(sql, ['gmail', 'calendar']); });
  it('requires Contacts rate-limit infrastructure without coupling other purposes', async () => {
    await changed('drop function public.hit_rate_limit(text,integer,integer)', ['contacts']);
    await changed('drop table public.rate_limits', ['contacts']);
  });
  it('requires contact fields only for the purposes which use contacts', async () => { await changed('alter table public.contacts drop column email', ['contacts', 'sheets-import', 'sheets-export']); });
  it('does not alter uncertain receipts, protected sessions, or manually created contacts during successful/failed probes', async () => {
    await expect(db.transaction(async tx => {
      const owner = '11111111-1111-4111-8111-111111111111';
      await tx.query('insert into auth.users(id) values ($1)', [owner]);
      await tx.query("insert into google_connector_sessions(id,user_id,purpose,encrypted_payload,expires_at,protected_action) values($1,$2,'sheets-export','synthetic-uncertain-receipt',now()+interval '10 minutes',true)", ['a'.repeat(64), owner]);
      await tx.query("insert into google_confirmed_actions(id,user_id,purpose,session_id,preview_hash,encrypted_preview,state,expires_at) values(gen_random_uuid(),$1,'gmail',$2,$3,'synthetic-uncertain-preview','uncertain',now()+interval '10 minutes')", [owner, 'b'.repeat(64), 'c'.repeat(64)]);
      const snapshots = async () => (await tx.query('select (select jsonb_agg(s) from google_connector_sessions s) sessions, (select jsonb_agg(a) from google_confirmed_actions a) actions')).rows;
      const before = await snapshots();
      for (const purpose of purposes) expect(await probe(tx, purpose)).toBe(true);
      await tx.exec('drop function public.import_google_contacts(text,uuid,text,uuid,jsonb)');
      expect(await probe(tx, 'contacts')).toBe(false);
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [owner]);
      await tx.exec("insert into public.contacts(name,category) values('Manual contact','personal')");
      await tx.exec('reset role');
      expect(await snapshots()).toEqual(before);
      expect((await tx.query("select count(*)::int n from contacts where name='Manual contact'")).rows).toEqual([{ n: 1 }]);
      throw new Error('Rollback synthetic receipts');
    })).rejects.toThrow('Rollback synthetic receipts');
  });
});
