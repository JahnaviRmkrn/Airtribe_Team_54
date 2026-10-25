import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real route functions and real supabase-js query construction, backed only by
// a synthetic capped HTTP transport or local PostgreSQL. No live services.
const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => state.client }));
import { GET as contactsRoute } from '../app/api/me/contacts/route';
import { GET as followupsRoute } from '../app/api/me/followups/route';
import { GET as dashboardRoute } from '../app/api/me/dashboard/route';
import { privacyDatabase, identities, asRole } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';
import { COMPLETE_READ_LIMITS, compareReadTimestamps, withCompleteReads, type CompleteReader } from '../lib/complete-read';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const now = '2026-10-25T08:00:00.000Z';
type Row = Record<string, unknown> & { id: string };
type QueryTrace = { table: string; params: URLSearchParams; method: string };
const uuid = (index: number) => `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
const contact = (index: number, extra: Record<string, unknown> = {}): Row => ({
  id: uuid(index), user_id: owner, name: `Synthetic ${String(index).padStart(5, '0')}`,
  category: 'personal', next_followup_at: '2026-10-27T00:00:00.000Z',
  last_interaction_at: null, ...extra,
});

function cappedTransport(tables: Record<string, Row[]>, cap: number) {
  const compare = (key: string, a: unknown, b: unknown) => key === 'category'
    ? ['personal', 'professional', 'community'].indexOf(String(a)) - ['personal', 'professional', 'community'].indexOf(String(b))
    : String(a).localeCompare(String(b));
  const trace: QueryTrace[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://synthetic.example.test' || !url.pathname.startsWith('/rest/v1/')) {
      throw new Error('Only the in-memory synthetic PostgREST transport is permitted');
    }
    const table = url.pathname.slice('/rest/v1/'.length);
    if (!Object.hasOwn(tables, table)) throw new Error('Unexpected synthetic table');
    const method = init?.method ?? 'GET';
    if (!['GET', 'HEAD'].includes(method)) throw new Error('Read-only transport');
    trace.push({ table, params: url.searchParams, method });
    // This is a transport model, not proof of production RLS. A separate test
    // below uses actual PostgreSQL policies through the existing PGlite adapter.
    let rows = tables[table].filter((row) => row.user_id === owner);
    for (const [key, value] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      if (key === 'or') {
        if (!value.startsWith('(starts_at.is.null,starts_at.gte.')) throw new Error('Unsupported OR fixture');
        const since = value.slice('(starts_at.is.null,starts_at.gte.'.length, -1);
        rows = rows.filter((row) => row.starts_at == null || String(row.starts_at) >= since);
      } else if (value.startsWith('eq.')) rows = rows.filter((row) => String(row[key]) === value.slice(3));
      else if (value.startsWith('gte.')) rows = rows.filter((row) => row[key] != null && String(row[key]) >= value.slice(4));
      else if (value.startsWith('lte.')) rows = rows.filter((row) => row[key] != null && String(row[key]) <= value.slice(4));
      else if (value.startsWith('gt.')) rows = rows.filter((row) => row[key] != null && compare(key, row[key], value.slice(3)) > 0);
      else if (value === 'not.is.null') rows = rows.filter((row) => row[key] != null);
      else throw new Error(`Unsupported fixture filter: ${key}`);
    }
    const order = (url.searchParams.get('order') ?? '').split(',').filter(Boolean).map((item) => item.split('.'));
    rows = rows.slice().sort((a, b) => {
      for (const [key, direction, nulls] of order) {
        if (a[key] === b[key]) continue;
        if (a[key] == null) return nulls === 'nullsfirst' ? -1 : 1;
        if (b[key] == null) return nulls === 'nullsfirst' ? 1 : -1;
        return compare(key, a[key], b[key]) * (direction === 'desc' ? -1 : 1);
      }
      return 0;
    });
    const total = rows.length;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Math.min(cap, Number(url.searchParams.get('limit') ?? cap));
    const page = rows.slice(offset, offset + limit);
    const headers = new Headers(init?.headers);
    const count = headers.get('prefer')?.includes('count=exact') ? total : '*';
    return new Response(method === 'HEAD' ? null : JSON.stringify(page), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/${count}` },
    });
  });
  const db = createClient('https://synthetic.example.test', 'synthetic-test-key-not-a-real-credential', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  const client = { from: db.from.bind(db), auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) } };
  return { client, trace, fetch };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch is forbidden'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('complete route reads, actual Supabase builder and capped synthetic transport', () => {
  it.each([1, 2, 1000])('preserves the final owned contact when the backend cap is %i', async (cap) => {
    const rows = Array.from({ length: cap + 1 }, (_, index) => contact(index + 1));
    const fixture = cappedTransport({ contacts: [...rows, contact(cap + 2, { user_id: other })] }, cap);
    state.client = fixture.client;
    const response = await contactsRoute(new Request('https://app.example.test/api/me/contacts'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.contacts).toHaveLength(cap + 1);
    expect(body.contacts.some((row: Row) => row.id === rows.at(-1)!.id)).toBe(true);
    expect(Object.keys(body)).toEqual(['contacts']);
    expect(fixture.trace).toHaveLength(Math.ceil((cap + 1) / Math.min(cap, COMPLETE_READ_LIMITS.pageRows)) + 2);
    expect(fixture.trace.every(({ params }) => params.get('limit') === '100' && !params.has('offset'))).toBe(true);
    expect(fixture.trace.at(-1)!.params.get('id')).toBe(`gt.${rows.at(-1)!.id}`);
    expect(fixture.trace.at(-1)!.method).toBe('HEAD');
    expect(body.contacts.every((row: Row) => row.user_id === owner)).toBe(true);
  });

  it('preserves an upcoming follow-up behind a full overdue page', async () => {
    const rows = [contact(1, { next_followup_at: '2026-10-01T00:00:00.000Z' }), contact(2, { next_followup_at: '2026-10-02T00:00:00.000Z' }), contact(3)];
    state.client = cappedTransport({ contacts: rows }, 2).client;
    const response = await followupsRoute(new Request('https://app.example.test/api/me/followups?days=14'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.overdue).toHaveLength(2);
    expect(body.upcoming.map((row: Row) => row.id)).toEqual([uuid(3)]);
    expect(Object.keys(body).sort()).toEqual(['overdue', 'upcoming']);
  });

  it('retains category/horizon filters, alphabetical ordering and equal-name id tie-breaks', async () => {
    const rows = [contact(3, { name: 'A synthetic', category: 'community' }), contact(2, { name: 'A synthetic' }),
      contact(1, { name: 'A synthetic' }), contact(4, { name: 'Z synthetic', next_followup_at: null }),
      contact(5, { name: 'Later synthetic', next_followup_at: '2027-01-01T00:00:00.000Z' })];
    state.client = cappedTransport({ contacts: rows }, 1).client;
    const response = await contactsRoute(new Request('https://app.example.test/api/me/contacts?category=personal'));
    expect(response.status).toBe(200);
    expect((await response.json()).contacts.map((row: Row) => row.id)).toEqual([1, 2, 5, 4].map(uuid));
    const due = await followupsRoute(new Request('https://app.example.test/api/me/followups?days=14'));
    expect(due.status).toBe(200);
    expect((await due.json()).upcoming.map((row: Row) => row.id)).toEqual([1, 2, 3].map(uuid));
  });

  it('keeps validation/authentication ahead of data reads and returns genuine empty payloads', async () => {
    const fixture = cappedTransport({ contacts: [] }, 1);
    state.client = fixture.client;
    expect((await contactsRoute(new Request('https://app.example.test/api/me/contacts?category=invalid'))).status).toBe(400);
    expect((await followupsRoute(new Request('https://app.example.test/api/me/followups?days=-1'))).status).toBe(400);
    expect(fixture.trace).toHaveLength(0);
    expect(await (await contactsRoute(new Request('https://app.example.test/api/me/contacts'))).json()).toEqual({ contacts: [] });
    state.client = { ...fixture.client, auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
    expect((await contactsRoute(new Request('https://app.example.test/api/me/contacts'))).status).toBe(401);
    expect(fixture.trace).toHaveLength(2);
  });

  it('returns an explicit error, never a partial list, for oversized private notes', async () => {
    state.client = cappedTransport({ contacts: [contact(1, { notes: 'x'.repeat(COMPLETE_READ_LIMITS.bytes) })] }, 1).client;
    const response = await contactsRoute(new Request('https://app.example.test/api/me/contacts'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringContaining('record size exceeds') });
  });

  it('counts all categories/activity and includes overdue contacts, meetups, and all three goal categories', async () => {
    const contacts = [contact(1), contact(2), contact(3, { category: 'community', next_followup_at: '2026-10-01T00:00:00.000Z' })];
    const interactions = Array.from({ length: 3 }, (_, index) => ({ id: uuid(100 + index), user_id: owner,
      occurred_at: `2026-10-${String(22 + index).padStart(2, '0')}T00:00:00.000Z`, contact: { category: 'personal' } }));
    const meetups = Array.from({ length: 3 }, (_, index) => ({ id: uuid(200 + index), user_id: owner,
      starts_at: `2026-10-${String(26 + index).padStart(2, '0')}T00:00:00.000Z`, expires_at: '2026-12-31T00:00:00.000Z', status: 'open' }));
    const goals = ['personal', 'professional', 'community'].map((category, index) => ({ id: uuid(300 + index), user_id: owner, category, target_percentage: [50, 30, 20][index] }));
    state.client = cappedTransport({ contacts, interactions, meetups, balance_goals: goals }, 2).client;
    const response = await dashboardRoute(new Request('https://app.example.test/api/me/dashboard'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contact_counts).toEqual({ personal: 2, professional: 0, community: 1 });
    expect(body.recorded_activity).toMatchObject({ total: 3, sufficient_data: true, by_category: { personal: 3, professional: 0, community: 0 } });
    expect(body.followups.overdue.map((row: Row) => row.id)).toEqual([uuid(3)]);
    expect(body.upcoming_meetups).toHaveLength(3);
    expect(body.goals).toEqual({ personal: 50, professional: 30, community: 20 });
    expect(body).not.toHaveProperty('incomplete');
  });

  it('preserves timestamp microseconds, equivalent offsets, tie-breaks and null-last meetup ordering', async () => {
    const contacts = [contact(1, { next_followup_at: '2026-10-27T00:00:00.000002Z' }),
      contact(2, { next_followup_at: '2026-10-27T00:00:00.000001Z' })];
    const interactions = [
      { id: uuid(1), user_id: owner, occurred_at: '2026-10-24T00:00:00.000001Z', contact: null },
      { id: uuid(2), user_id: owner, occurred_at: '2026-10-24T00:00:00.000002Z', contact: null },
      { id: uuid(3), user_id: owner, occurred_at: '2026-10-24T00:00:00.000002Z', contact: null },
    ];
    const meetups = [null, '2026-10-27T00:00:00.000002Z', '2026-10-27T00:00:00.000001Z', null]
      .map((starts_at, index) => ({ id: uuid(index + 1), user_id: owner, starts_at, expires_at: '2026-12-31T00:00:00.000Z', status: 'open' }));
    state.client = cappedTransport({ contacts, interactions, meetups, balance_goals: [] }, 1).client;
    const due = await followupsRoute(new Request('https://app.example.test/api/me/followups'));
    expect(due.status).toBe(200);
    expect((await due.json()).upcoming.map((row: Row) => row.id)).toEqual([2, 1].map(uuid));
    const response = await dashboardRoute(new Request('https://app.example.test/api/me/dashboard'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recent_activity.map((row: Row) => row.id)).toEqual([2, 3, 1].map(uuid));
    expect(body.upcoming_meetups.map((row: Row) => row.id)).toEqual([3, 2, 1, 4].map(uuid));
    expect(compareReadTimestamps('2026-10-24T05:30:00.000002+05:30', '2026-10-24T00:00:00.000001Z')).toBeGreaterThan(0);
    expect(compareReadTimestamps('2026-10-24T05:30:00.000001+05:30', '2026-10-24T00:00:00.000001Z')).toBe(0);
  });

  it('applies the dashboard horizon to instants without dropping microseconds or depending on offset formatting', async () => {
    const contacts = [
      contact(1, { next_followup_at: '2026-11-08T13:30:00.000000+05:30' }),
      contact(2, { next_followup_at: '2026-11-08T08:00:00.000001Z' }),
    ];
    state.client = cappedTransport({ contacts, interactions: [], meetups: [], balance_goals: [] }, 1).client;
    const response = await dashboardRoute(new Request('https://app.example.test/api/me/dashboard'));
    expect(response.status).toBe(200);
    expect((await response.json()).followups.upcoming.map((row: Row) => row.id)).toEqual([uuid(1)]);
  });

  it('preserves complete contacts after capped transport and real PGlite owner RLS', async () => {
    const db = await privacyDatabase();
    try {
      await db.query('insert into auth.users (id) values ($1), ($2)', [identities.alice, identities.bob]);
      await asRole(db, 'authenticated', identities.alice, (tx: { query: (sql: string) => Promise<unknown> }) => tx.query(
        "insert into contacts (name, category) values ('A synthetic owned', 'personal'), ('B synthetic owned', 'personal'), ('C synthetic owned', 'community')"));
      await asRole(db, 'authenticated', identities.bob, (tx: { query: (sql: string) => Promise<unknown> }) => tx.query(
        "insert into contacts (name, category) values ('0 synthetic other owner', 'personal')"));
      const uncapped = pgliteClient(db, 'authenticated', identities.alice, { organizerQueries: true, jsonRows: true, allowedTables: ['contacts'] });
      const visible = await asRole(db, 'authenticated', identities.alice, (tx: { query: (sql: string) => Promise<{ rows: Row[] }> }) => tx.query('select * from contacts'));
      expect(visible.rows).toHaveLength(3);
      const from = uncapped.from.bind(uncapped);
      state.client = { ...uncapped, from(table: string) {
        const query = from(table); const original = query.then.bind(query);
        query.then = (resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) => original((result: { data: Row[] | null }) =>
          resolve({ ...result, data: result.data?.slice(0, 2) ?? result.data }), reject);
        return query;
      } };
      const response = await contactsRoute(new Request('https://app.example.test/api/me/contacts'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.contacts.map((row: Row) => row.name)).toEqual(['A synthetic owned', 'B synthetic owned', 'C synthetic owned']);
      expect(body.contacts.every((row: Row) => row.user_id === identities.alice)).toBe(true);
    } finally { await db.close(); }
  }, 30_000);
});

async function completeContacts(client: ReturnType<typeof cappedTransport>['client'], overrides = {}) {
  return withCompleteReads(new Request('https://app.example.test'), (read) => read((after, signal, pageRows, verifyEmpty) => {
    let query = client.from('contacts').select('*', verifyEmpty ? { count: 'exact', head: true } : undefined)
      .order('id').limit(pageRows).abortSignal(signal);
    if (after) query = query.gt('id', after);
    return query;
  }, (row) => row.id), { ...COMPLETE_READ_LIMITS, ...overrides });
}

describe('bounded complete reader', () => {
  it('continues short capped pages until an empty probe rather than falsely declaring completion', async () => {
    const fixture = cappedTransport({ contacts: Array.from({ length: 7 }, (_, index) => contact(index + 1, { name: 'Duplicate name' })) }, 2);
    const rows = await completeContacts(fixture.client);
    expect(rows).toHaveLength(7);
    expect(fixture.trace).toHaveLength(6); // 2 + 2 + 2 + 1 + empty + HEAD.
    expect(fixture.trace.every(({ params }) => !params.has('offset') && params.get('limit') === '100')).toBe(true);
  });
  it('preserves remaining rows if a prior-page contact is deleted between requests', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => contact(index + 1));
    const fixture = cappedTransport({ contacts: rows }, 2);
    const originalFrom = fixture.client.from;
    let requests = 0;
    fixture.client.from = ((...args: Parameters<typeof originalFrom>) => {
      if (++requests === 2) rows.splice(0, 1);
      return originalFrom(...args);
    }) as typeof originalFrom;
    expect((await completeContacts(fixture.client)).map((row) => row.id)).toEqual([1, 2, 3, 4, 5].map(uuid));
  });
  it('fails explicitly on response/request budgets instead of returning a partial success', async () => {
    const rows = Array.from({ length: 7 }, (_, index) => contact(index + 1));
    await expect(completeContacts(cappedTransport({ contacts: rows }, 2).client, { rows: 5 })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('number of records') });
    await expect(completeContacts(cappedTransport({ contacts: rows }, 2).client, { requests: 3 })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('read request limit') });
  });

  it('allows the exact row limit only after an empty terminating probe', async () => {
    const fixture = cappedTransport({ contacts: [contact(1), contact(2)] }, 2);
    expect(await completeContacts(fixture.client, { rows: 2, requests: 3 })).toHaveLength(2);
    expect(fixture.trace).toHaveLength(3);
    await expect(completeContacts(cappedTransport({ contacts: [contact(1), contact(2)] }, 2).client, { rows: 2, requests: 2 }))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('read request limit') });
  });

  const request = () => new Request('https://app.example.test');
  const pages = (read: CompleteReader, values: Array<{ data: Array<{ id: string }> | null; error: null | { message: string } }>) => {
    let index = 0;
    return read(async (_after, _signal, _size, verifyEmpty) => verifyEmpty
      ? { data: null, count: 0, error: null }
      : values[index++] ?? { data: [], error: null }, (row) => row.id);
  };
  it.each([
    [{ data: [{ id: 'a' }], error: null }, { data: null, error: { message: 'Synthetic page failure' } }],
    [{ data: [{ id: 'a' }], error: null }, { data: null, error: null }],
    [{ data: [{ id: 'a' }, { id: 'a' }], error: null }],
    [{ data: [{ id: 'b' }, { id: 'a' }], error: null }],
    [{ data: [{ id: 'a' }], error: null }, { data: [{ id: 'a' }], error: null }],
    [{ data: [{ id: '' }], error: null }],
  ])('rejects failed, malformed, duplicate or backward pages without partial success: %j', async (...values) => {
    await expect(withCompleteReads(request(), (read) => pages(read, values))).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a thrown page failure after partial progress', async () => {
    let count = 0;
    await expect(withCompleteReads(request(), (read) => read(async () => {
      if (++count === 2) throw new Error('Synthetic failure');
      return { data: [{ id: 'a' }], error: null };
    }, (row) => row.id))).rejects.toMatchObject({ status: 503, message: expect.stringContaining('database page was unavailable') });
  });

  it('fails explicitly for a zero-row server cap, including changes after a nonempty page', async () => {
    state.client = cappedTransport({ contacts: [contact(1)] }, 0).client;
    const response = await contactsRoute(new Request('https://app.example.test/api/me/contacts'));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringContaining('end of the result could not be verified') });
    let step = 0;
    await expect(withCompleteReads(request(), (read) => read(async (_after, _signal, _size, verifyEmpty) => {
      if (verifyEmpty) return { data: null, count: 2, error: null };
      return { data: step++ ? [] : [{ id: 'a' }], error: null };
    }, (row) => row.id))).rejects.toMatchObject({ status: 503, message: expect.stringContaining('end of the result') });
  });

  it.each([undefined, null, 1])('requires known count zero, not %s, to verify an empty result', async (count) => {
    await expect(withCompleteReads(request(), (read) => read(async (_after, _signal, _size, verifyEmpty) => verifyEmpty
      ? { data: null, count, error: null } : { data: [], error: null }, () => 'unused')))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('end of the result') });
  });

  it('does not turn a failed HEAD verification into a complete result', async () => {
    await expect(withCompleteReads(request(), (read) => read(async (_after, _signal, _size, verifyEmpty) => verifyEmpty
      ? { data: null, error: { message: 'Synthetic count transport failure' } } : { data: [], error: null }, () => 'unused')))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('database page was unavailable') });
  });

  it('turns a malformed row key into an explicit incomplete-data error', async () => {
    await expect(withCompleteReads(request(), (read) => read(async () => ({ data: [null], error: null }),
      (row) => (row as unknown as { id: string }).id)))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('database page order was invalid') });
  });

  it('shares row/request/byte limits across concurrent collections', async () => {
    await expect(withCompleteReads(request(), (read) => Promise.all([
      pages(read, [{ data: [{ id: 'a' }, { id: 'b' }], error: null }]),
      pages(read, [{ data: [{ id: 'c' }, { id: 'd' }], error: null }]),
    ]), { ...COMPLETE_READ_LIMITS, rows: 3 })).rejects.toMatchObject({ status: 503 });
    await expect(withCompleteReads(request(), (read) => Promise.all([
      pages(read, [{ data: [{ id: 'a' }], error: null }]),
      pages(read, [{ data: [{ id: 'b' }], error: null }]),
    ]), { ...COMPLETE_READ_LIMITS, requests: 3 })).rejects.toMatchObject({ status: 503 });
    await expect(withCompleteReads(request(), (read) => Promise.all([
      pages(read, [{ data: [{ id: 'a' }], error: null }]),
      pages(read, [{ data: [{ id: 'b' }], error: null }]),
    ]), { ...COMPLETE_READ_LIMITS, bytes: 20 })).rejects.toMatchObject({ status: 503 });
  });

  it('counts UTF-8 bytes and the serialized final response, including repeated dashboard lists', async () => {
    await expect(withCompleteReads(request(), (read) => pages(read, [{ data: [{ id: '😀' }], error: null }]), {
      ...COMPLETE_READ_LIMITS, bytes: 13,
    })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('record size') });
    await expect(withCompleteReads(request(), async (read) => {
      const rows = await pages(read, [{ data: [{ id: 'a' }], error: null }]);
      return { first: rows, second: rows, third: rows };
    }, { ...COMPLETE_READ_LIMITS, bytes: 50 })).rejects.toMatchObject({ status: 503, message: expect.stringContaining('response size') });
  });

  it('aborts the actual Supabase fetch and rejects hung pages at the total deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new DOMException('Synthetic abort', 'AbortError')), { once: true });
    }));
    const client = createClient('https://synthetic.example.test', 'synthetic-test-key-not-a-real-credential', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
    });
    const pending = withCompleteReads(request(), (read) => read((_after, abort, pageRows) =>
      client.from('contacts').select('*').order('id').limit(pageRows).abortSignal(abort), (row) => row.id), {
      ...COMPLETE_READ_LIMITS, milliseconds: 10,
    });
    const outcome = expect(pending).rejects.toMatchObject({ status: 503, message: expect.stringContaining('time limit') });
    await vi.advanceTimersByTimeAsync(11);
    await outcome;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds non-cooperative transports and does not reset the deadline on each page', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    const hung = withCompleteReads(request(), (read) => read<{ id: string }>(() => new Promise(() => {}), (row) => row.id), {
      ...COMPLETE_READ_LIMITS, milliseconds: 10,
    });
    const outcome = expect(hung).rejects.toMatchObject({ status: 503, message: expect.stringContaining('time limit') });
    await vi.advanceTimersByTimeAsync(11); await outcome;
    let index = 0;
    await expect(withCompleteReads(request(), (read) => read(async () => {
      vi.advanceTimersByTime(6);
      return { data: [{ id: String(++index) }], error: null };
    }, (row) => row.id), { ...COMPLETE_READ_LIMITS, milliseconds: 10 }))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('time limit') });
    expect(index).toBe(2);
  });

  it('honors already-cancelled incoming requests before reading any data', async () => {
    const controller = new AbortController(); controller.abort();
    const load = vi.fn(async () => ({ data: [], error: null }));
    await expect(withCompleteReads(new Request('https://app.example.test', { signal: controller.signal }), (read) => read(load, () => 'a')))
      .rejects.toMatchObject({ status: 503, message: expect.stringContaining('cancelled') });
    expect(load).not.toHaveBeenCalled();
  });
});
