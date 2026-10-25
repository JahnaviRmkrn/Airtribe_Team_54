import { asRole } from './privacy-db.mjs';

// Deliberately small Supabase query adapter for route integration tests. Every
// supported operation runs real PostgreSQL under the requested role, including
// RLS, projections and predicates. This is not a PostgREST/Auth emulator.
const identifier = (value) => {
  if (!/^[a-z_][a-z_0-9]*$/i.test(value)) throw new Error(`Unsupported test identifier: ${value}`);
  return `"${value}"`;
};
const plainProjection = (value) => value === '*' ? '*' : value.split(',').map((part) => identifier(part.trim())).join(', ');
const rpcDefinitions = {
  payment_checkout_ready: { args: [], sql: 'select public.payment_checkout_ready() as result' },
  contact_create_retry_ready: { args: [], sql: 'select public.contact_create_retry_ready() as result' },
  create_contacts_once: { args: ['p_intent', 'p_contacts'], sql: 'select public.create_contacts_once($1::uuid, $2::jsonb) as result', jsonArgs: ['p_contacts'] },
  record_interaction: {
    args: ['p_contact_id', 'p_occurred_at', 'p_type', 'p_notes', 'p_next_followup_at', 'p_set_next'],
    sql: 'select public.record_interaction($1::uuid, $2::timestamptz, $3::text, $4::text, $5::timestamptz, $6::boolean) as result',
  },
};

/** @param {string | null} [uid] */
export function pgliteClient(db, role, uid = null, options = {}) {
  const maxLimit = options.maxLimit ?? 100;
  if (!Number.isInteger(maxLimit) || maxLimit < 1 || maxLimit > 1001) throw new Error('Unsupported test limit ceiling');
  const allowedRpcs = new Set(options.allowedRpcs ?? ['payment_checkout_ready']);
  for (const name of allowedRpcs) if (!Object.hasOwn(rpcDefinitions, name)) throw new Error('Unknown test RPC allowlist entry');
  const allowedTables = options.allowedTables ? new Set(options.allowedTables) : null;
  const projection = (value, table) => {
    // Only the exact relationship used by organizer reads is implemented.
    const relation = 'contact:contacts(id, name, category)';
    if (!value.includes(':')) return plainProjection(value);
    if (!options.organizerQueries || table !== 'interactions' || !value.endsWith(relation) || (allowedTables && !allowedTables.has('contacts'))) throw new Error('Unsupported test relationship');
    const base = value.slice(0, -relation.length).replace(/,\s*$/, '').trim();
    const fields = base === '*' ? 'interactions.*' : plainProjection(base);
    return `${fields}, (select jsonb_build_object('id', c.id, 'name', c.name, 'category', c.category)
      from public.contacts c where c.id = interactions.contact_id) as contact`;
  };
  const advanced = () => { if (!options.organizerQueries) throw new Error('Organizer test query support is not enabled'); };
  return {
    rpc(name, args = {}) {
      if (!allowedRpcs.has(name)) throw new Error('Unsupported test RPC');
      const definition = rpcDefinitions[name];
      if (Object.keys(args).length !== definition.args.length || definition.args.some((key) => !Object.hasOwn(args, key))) throw new Error('Unsupported test RPC arguments');
      let signal, executed;
      const run = async () => {
        try {
          signal?.throwIfAborted();
          const params = definition.args.map((key) => definition.jsonArgs?.includes(key) ? JSON.stringify(args[key]) : args[key]);
          const { rows } = await asRole(db, role, uid, (tx) => tx.query(definition.sql, params));
          signal?.throwIfAborted();
          return { data: rows[0].result, error: null };
        } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
      };
      return {
        // The fixture checks cancellation at entry/exit. It does not simulate
        // network cancellation or interrupt an already-running SQL statement.
        abortSignal(value) { signal = value; return this; },
        then(resolve, reject) { executed ??= run(); return executed.then(resolve, reject); },
      };
    },
    auth: { getUser: async () => ({ data: { user: uid ? { id: uid } : null }, error: null }) },
    from(table) {
      if (allowedTables && !allowedTables.has(table)) throw new Error('Unsupported test table');
      const state = { operation: 'select', columns: '*', filters: [], order: [], returning: false, single: null };
      let executed;
      const query = {
        select(columns = '*', selectOptions = {}) {
          if (selectOptions.head || selectOptions.count) {
            if (selectOptions.head !== true || selectOptions.count !== 'exact') throw new Error('Only exact HEAD counts are supported');
            state.head = true;
          }
          state.columns = columns; state.returning = true; return query;
        },
        eq(key, value) { state.filters.push([key, value, '=']); return query; },
        in(key, values) {
          advanced();
          if (!Array.isArray(values) || !values.length || values.length > 100) throw new Error('Unsupported test IN values');
          state.filters.push([key, [...values], 'in']); return query;
        },
        is(key, value) {
          if (value !== null) throw new Error('Test adapter only supports IS NULL');
          state.filters.push([key, value, 'is']); return query;
        },
        not(key, operator, value) {
          advanced();
          if (operator !== 'is' || value !== null) throw new Error('Test adapter only supports IS NOT NULL');
          state.filters.push([key, value, 'not null']); return query;
        },
        gte(key, value) { advanced(); state.filters.push([key, value, '>=']); return query; },
        gt(key, value) { advanced(); state.filters.push([key, value, '>']); return query; },
        lte(key, value) { advanced(); state.filters.push([key, value, '<=']); return query; },
        or(value) {
          advanced();
          // Never interpolate a PostgREST expression into SQL. This one explicit
          // dashboard predicate becomes fixed SQL with a bound timestamp.
          const match = value.match(/^starts_at\.is\.null,starts_at\.gte\.(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/);
          if (table !== 'meetups' || !match) throw new Error('Unsupported test OR expression');
          state.filters.push(['starts_at', match[1], 'null or >=']); return query;
        },
        order(key, orderOptions = {}) { state.order.push([key, orderOptions.ascending !== false, orderOptions.nullsFirst]); return query; },
        limit(value) { advanced(); if (!Number.isInteger(value) || value < 1 || value > maxLimit) throw new Error('Unsupported test limit'); state.limit = value; return query; },
        insert(values) { state.operation = 'insert'; state.values = values; return query; },
        update(values) { state.operation = 'update'; state.values = values; return query; },
        upsert(values, upsertOptions = {}) {
          state.operation = 'insert'; state.values = values;
          state.conflict = upsertOptions.onConflict ?? options.defaultConflicts?.[table];
          if (!state.conflict) throw new Error('Test upsert requires an explicit conflict target');
          return query;
        },
        delete() { state.operation = 'delete'; return query; },
        single() { state.single = 'required'; return query; },
        maybeSingle() { state.single = 'optional'; return query; },
        // Cancellation is checked at entry/exit; this fixture does not interrupt
        // a running SQL statement or model PostgREST network cancellation.
        abortSignal(value) { state.signal = value; return query; },
        then(resolve, reject) { executed ??= execute(); return executed.then(resolve, reject); },
      };
      async function execute() {
        const params = [];
        const bind = (value) => { params.push(value); return `$${params.length}`; };
        let sql;
        const target = `public.${identifier(table)}`;
        if (state.operation === 'insert') {
          const rows = Array.isArray(state.values) ? state.values : [state.values];
          if (!rows.length) throw new Error('Empty test insert is not supported');
          const columns = [...new Set(rows.flatMap(Object.keys))];
          sql = `insert into ${target} (${columns.map(identifier).join(', ')}) values `;
          sql += rows.map((row) => `(${columns.map((key) => Object.hasOwn(row, key) ? bind(row[key]) : 'default').join(', ')})`).join(', ');
          if (state.conflict) {
            sql += ` on conflict (${plainProjection(state.conflict)}) do update set `;
            sql += columns.map((key) => `${identifier(key)} = excluded.${identifier(key)}`).join(', ');
          }
        } else if (state.operation === 'update') {
          sql = `update ${target} set ` + Object.entries(state.values).map(([key, value]) => `${identifier(key)} = ${bind(value)}`).join(', ');
        } else if (state.operation === 'delete') {
          sql = `delete from ${target}`;
        } else {
          sql = `select ${state.head ? 'count(*)::int as exact_count' : projection(state.columns, table)} from ${target}`;
        }
        if (state.filters.length) sql += ' where ' + state.filters.map(([key, value, operator]) => {
          const field = identifier(key);
          if (operator === 'in') return `${field} in (${value.map(bind).join(', ')})`;
          if (operator === 'is') return `${field} is null`;
          if (operator === 'not null') return `${field} is not null`;
          if (operator === 'null or >=') return `(${field} is null or ${field} >= ${bind(value)})`;
          return `${field} ${operator} ${bind(value)}`;
        }).join(' and ');
        if (!state.head && state.operation === 'select' && state.order.length) sql += ' order by ' + state.order.map(([key, asc, nullsFirst]) => `${identifier(key)} ${asc ? 'asc' : 'desc'}${nullsFirst === undefined ? '' : nullsFirst ? ' nulls first' : ' nulls last'}`).join(', ');
        if (!state.head && state.limit) sql += ` limit ${bind(state.limit)}`;
        if (state.operation !== 'select' && state.returning) sql += ` returning ${plainProjection(state.columns)}`;
        // PostgreSQL JSON serialization retains six fractional digits where
        // present. A JS Date would round updated_at to milliseconds and make
        // an unchanged real handler's optimistic-lock token falsely stale.
        const jsonRows = !state.head && options.jsonRows && (state.operation === 'select' || state.returning);
        if (jsonRows) sql = state.operation === 'select'
          ? `select to_jsonb(fixture_row) as fixture_row from (${sql}) fixture_row`
          : `with fixture_result as (${sql}) select to_jsonb(fixture_result) as fixture_row from fixture_result`;
        try {
          state.signal?.throwIfAborted();
          const result = await asRole(db, role, uid, (tx) => tx.query(sql, params));
          state.signal?.throwIfAborted();
          if (state.head) return { data: null, error: null, count: result.rows[0].exact_count };
          const rows = jsonRows ? result.rows.map((row) => row.fixture_row) : result.rows;
          if (state.single && (rows.length > 1 || (!rows.length && state.single === 'required'))) {
            return { data: null, error: { code: 'PGRST116', message: 'Expected one row' } };
          }
          const data = state.operation !== 'select' && !state.returning ? null : state.single ? rows[0] ?? null : rows;
          return { data, error: null };
        } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
      }
      return query;
    },
  };
}
