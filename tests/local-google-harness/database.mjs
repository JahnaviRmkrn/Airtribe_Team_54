import { readFileSync } from 'node:fs';
import { asRole, privacyDatabase, seedPrivateData } from '../helpers/privacy-db.mjs';
import { pgliteClient } from '../helpers/pglite-client.mjs';

// Only fixed function signatures are supported. There is no generic RPC or
// PostgREST transport, and SQL serialization preserves timestamp precision.
const definitions = {
  google_connector_purpose_ready: ['p_purpose', 'text', false],
  hit_rate_limit: ['p_key,p_window_seconds,p_max', 'text,integer,integer', false],
  replace_google_connector_session: ['p_id,p_owner,p_purpose,p_payload,p_expires_at', 'text,uuid,text,text,timestamptz', false],
  claim_google_connector_session: ['p_id,p_owner,p_purpose,p_lease', 'text,uuid,text,uuid', true],
  preview_google_contact_duplicates: ['p_owner,p_contacts', 'uuid,jsonb', true],
  import_google_contacts: ['p_session,p_owner,p_purpose,p_lease,p_contacts', 'text,uuid,text,uuid,jsonb', false],
  create_google_action_preview: ['p_id,p_owner,p_purpose,p_session,p_lease,p_hash,p_preview', 'uuid,uuid,text,text,uuid,text,text', true],
  claim_google_confirmed_action: ['p_id,p_owner,p_purpose,p_session,p_lease,p_hash', 'uuid,uuid,text,text,uuid,text', true],
};

export async function googleDatabase() {
  // Reuse the actual local schema/RLS fixture. Its fixed Vault exclusion runs
  // before opening any file. Later unrelated payment/contact-receipt SQL is not
  // needed here. These SQL files execute ONLY in this in-memory PGlite instance.
  const db = await privacyDatabase({ beforeMigration: '20261025120000' });
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261025121500_google_purpose_readiness.sql', import.meta.url), 'utf8'));
  await db.exec("set timezone = 'UTC'");
  return db;
}

export async function resetDatabase(db) {
  await db.exec('truncate public.google_confirmed_actions, public.google_connector_sessions, public.rate_limits');
  return seedPrivateData(db);
}

export function googleClient(db, owner, state, admin = false) {
  const role = admin ? 'service_role' : owner ? 'authenticated' : 'anon';
  const base = pgliteClient(db, role, owner, {
    organizerQueries: true, jsonRows: true, maxLimit: 1001, allowedRpcs: [],
    allowedTables: admin ? ['google_connector_sessions', 'google_confirmed_actions'] : ['contacts'],
  });
  return { ...base, from(table) {
    const query = base.from(table), update = query.update, then = query.then;
    let finishing = false;
    query.update = values => { finishing = table === 'google_confirmed_actions' && values.state === 'completed'; return update(values); };
    query.then = (resolve, reject) => then(async result => {
      if (finishing && state.loseFinish && !result.error) {
        state.loseFinish = false;
        return resolve({ data: null, error: { message: 'Synthetic lost saved outcome receipt' } });
      }
      return resolve(result);
    }, reject);
    return query;
  }, async rpc(name, args = {}) {
    if (!admin || !Object.hasOwn(definitions, name)) throw new Error('Unsupported Google fixture RPC');
    const [keys, types, rows] = definitions[name];
    const names = keys.split(','), casts = types.split(',');
    if (Object.keys(args).length !== names.length || names.some(key => !Object.hasOwn(args, key))) throw new Error('Unsupported Google fixture RPC arguments');
    const values = names.map((key, i) => casts[i] === 'jsonb' ? JSON.stringify(args[key]) : args[key]);
    const invocation = `public.${name}(${casts.map((type, i) => `$${i + 1}::${type}`).join(',')})`;
    // A single OUT column is a scalar range-function value in PostgreSQL. The
    // subquery preserves PostgREST's object-row shape even for { id: text }.
    const sql = rows ? `select to_jsonb(r) as result from (select * from ${invocation}) r` : `select ${invocation} as result`;
    state.rpcs.push(name);
    try {
      const result = await asRole(db, 'service_role', null, tx => tx.query(sql, values));
      // Deliberately lose only the transport receipt AFTER the real transaction
      // commits, rather than substituting a fake successful SQL implementation.
      if (state.loseRpc === name) { state.loseRpc = null; return { data: null, error: { message: 'Synthetic lost response after commit' } }; }
      return { data: rows ? result.rows.map(row => row.result) : result.rows[0].result, error: null };
    } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
  } };
}
