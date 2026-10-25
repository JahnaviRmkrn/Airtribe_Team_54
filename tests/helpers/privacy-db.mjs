import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Local PostgreSQL only. Supabase's normal table grants are modelled before
// migrations so explicit revocations (e.g. rate_limits) remain effective.
export async function privacyDatabase({ beforeMigration } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    alter default privileges in schema public grant select, insert, update, delete
      on tables to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  const directory = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    if (beforeMigration && file >= beforeMigration) continue;
    // Vault cannot run in PGlite; never load production secrets to test RLS.
    if (file === '20261025090000_app_secrets_vault.sql') continue;
    await db.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  return db;
}

// Transaction-local identity prevents a prior request's role/JWT leaking into
// the next request, even when a negative assertion raises a PostgreSQL error.
export function asRole(db, role, uid, work) {
  if (!['anon', 'authenticated', 'service_role'].includes(role)) throw new Error('Unexpected test role');
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? '']);
    return work(tx);
  });
}

export const identities = {
  alice: '11111111-1111-4111-8111-111111111111',
  bob: '22222222-2222-4222-8222-222222222222',
  venue: '33333333-3333-4333-8333-333333333333',
};

export async function seedPrivateData(db) {
  await db.exec('truncate auth.users cascade; truncate public.venues cascade;');
  await db.query('insert into auth.users (id) values ($1), ($2)', [identities.alice, identities.bob]);
  const tenants = {};
  for (const name of ['alice', 'bob']) {
    const uid = identities[name];
    tenants[name] = await asRole(db, 'authenticated', uid, async (tx) => {
      const contact = (await tx.query(`insert into contacts (name, category, notes, email)
        values ($1, 'personal', $2, $3) returning *`,
      [`${name} contact`, `${name} private contact note`, `${name}.contact@example.test`])).rows[0];
      const interaction = (await tx.query(`insert into interactions (contact_id, notes)
        values ($1, $2) returning *`, [contact.id, `${name} private interaction note`])).rows[0];
      await tx.query(`insert into balance_goals (category, target_percentage)
        values ('personal', $1), ('professional', $2), ('community', 20)`, name === 'alice' ? [50, 30] : [30, 50]);
      const meetup = (await tx.query(`insert into meetups (title, notes, area, budget)
        values ($1, $2, 'Indiranagar', 1000) returning *`,
      [`${name} room`, `${name} private meetup note`])).rows[0];
      const discovery = (await tx.query("insert into saved_discoveries (title) values ($1) returning *", [`${name} private discovery`])).rows[0];
      return { uid, contact, interaction, meetup, discovery };
    });
  }
  await asRole(db, 'service_role', null, (tx) => tx.query(`insert into venues (id, name, area, activity_types, price_per_person)
    values ($1, 'Synthetic Cafe', 'Indiranagar', '{dinner,coffee}', 500)`, [identities.venue]));
  return tenants;
}
