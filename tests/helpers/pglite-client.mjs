import { asRole } from './privacy-db.mjs';

// Deliberately small Supabase query adapter for route integration tests. It
// translates the operations used by these routes to real PostgreSQL, including
// projections and predicates. It is not a PostgREST or Supabase Auth emulator.
const identifier = (value) => {
  if (!/^[a-z_][a-z_0-9]*$/i.test(value)) throw new Error(`Unsupported test identifier: ${value}`);
  return `"${value}"`;
};
const projection = (value) => value === '*' ? '*' : value.split(',').map((part) => identifier(part.trim())).join(', ');

export function pgliteClient(db, role, uid = null) {
  return {
    async rpc(name) {
      // Read-only capability probes only; never emulate mutation RPCs here.
      if (name !== 'payment_checkout_ready') throw new Error('Unsupported test RPC');
      try {
        const { rows } = await asRole(db, role, uid, (tx) => tx.query('select public.payment_checkout_ready() as ready'));
        return { data: rows[0].ready, error: null };
      } catch (error) {
        return { data: null, error: { message: error.message, code: error.code } };
      }
    },
    auth: { getUser: async () => ({ data: { user: uid ? { id: uid } : null }, error: null }) },
    from(table) {
      const state = { operation: 'select', columns: '*', filters: [], order: [], returning: false, single: null };
      let executed;
      const query = {
        select(columns = '*') { state.columns = columns; state.returning = true; return query; },
        eq(key, value) { state.filters.push([key, value]); return query; },
        is(key, value) {
          if (value !== null) throw new Error('Test adapter only supports IS NULL');
          state.filters.push([key, value, 'is']); return query;
        },
        order(key, options = {}) { state.order.push([key, options.ascending !== false]); return query; },
        insert(values) { state.operation = 'insert'; state.values = values; return query; },
        update(values) { state.operation = 'update'; state.values = values; return query; },
        upsert(values, options = {}) { state.operation = 'insert'; state.values = values; state.conflict = options.onConflict; return query; },
        delete() { state.operation = 'delete'; return query; },
        single() { state.single = 'required'; return query; },
        maybeSingle() { state.single = 'optional'; return query; },
        then(resolve, reject) {
          executed ??= execute();
          return executed.then(resolve, reject);
        },
      };
      async function execute() {
        const params = [];
        const bind = (value) => { params.push(value); return `$${params.length}`; };
        let sql;
        const target = `public.${identifier(table)}`;
        if (state.operation === 'insert') {
          const rows = Array.isArray(state.values) ? state.values : [state.values];
          const columns = Object.keys(rows[0]);
          sql = `insert into ${target} (${columns.map(identifier).join(', ')}) values `;
          sql += rows.map((row) => `(${columns.map((key) => bind(row[key])).join(', ')})`).join(', ');
          if (state.conflict) {
            sql += ` on conflict (${projection(state.conflict)}) do update set `;
            sql += columns.map((key) => `${identifier(key)} = excluded.${identifier(key)}`).join(', ');
          }
        } else if (state.operation === 'update') {
          sql = `update ${target} set ` + Object.entries(state.values).map(([key, value]) => `${identifier(key)} = ${bind(value)}`).join(', ');
        } else if (state.operation === 'delete') {
          sql = `delete from ${target}`;
        } else {
          sql = `select ${projection(state.columns)} from ${target}`;
        }
        if (state.filters.length) sql += ' where ' + state.filters.map(([key, value, operator]) => operator === 'is' ? `${identifier(key)} is null` : `${identifier(key)} = ${bind(value)}`).join(' and ');
        if (state.operation === 'select' && state.order.length) sql += ' order by ' + state.order.map(([key, asc]) => `${identifier(key)} ${asc ? 'asc' : 'desc'}`).join(', ');
        if (state.operation !== 'select' && state.returning) sql += ` returning ${projection(state.columns)}`;
        try {
          const { rows } = await asRole(db, role, uid, (tx) => tx.query(sql, params));
          if (state.single && (rows.length > 1 || (!rows.length && state.single === 'required'))) {
            return { data: null, error: { code: 'PGRST116', message: 'Expected one row' } };
          }
          const data = state.operation !== 'select' && !state.returning ? null : state.single ? rows[0] ?? null : rows;
          return { data, error: null };
        } catch (error) {
          return { data: null, error: { message: error.message, code: error.code } };
        }
      }
      return query;
    },
  };
}
