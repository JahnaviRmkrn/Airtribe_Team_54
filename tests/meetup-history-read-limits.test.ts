import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => state.client }));
import { GET as getMeetups } from '../app/api/me/meetups/route';
import { GET as getContact } from '../app/api/me/contacts/[id]/route';
import { GET as getRecentActivity } from '../app/api/me/interactions/route';

type Row = Record<string, unknown> & { id: string };
type Trace = { table: string; params: URLSearchParams; method: string; signal?: AbortSignal | null };
const owner = identities.alice, other = identities.bob;
const id = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const person = (n: number, user_id = owner): Row => ({ id: id(n), user_id, name: `Synthetic person ${n}`, category: 'personal' });
const interaction = (n: number, contact_id = id(1), user_id = owner): Row => ({
  id: id(10000 + n), user_id, contact_id, occurred_at: new Date(Date.UTC(2026, 9, 24) - n * 1000).toISOString(), type: 'check_in', notes: `Synthetic interaction ${n}`,
});
const meetup = (n: number, organizer_id = owner): Row => ({
  id: id(20000 + n), organizer_id, created_at: new Date(Date.UTC(2026, 9, 24) - n * 1000).toISOString(),
  title: `Synthetic meetup ${n}`, room_token: `synthetic_meetup_room_${String(n).padStart(8, '0')}`, status: 'open',
});

function cappedTransport(tables: Record<string, Row[]>, cap: number, beforeRead?: (trace: Trace) => Response | Promise<Response> | void) {
  const trace: Trace[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://synthetic.example.test' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Only synthetic transport is permitted');
    const table = url.pathname.slice('/rest/v1/'.length), method = init?.method ?? 'GET';
    if (!Object.hasOwn(tables, table) || !['GET', 'HEAD'].includes(method)) throw new Error('Unexpected read');
    const entry = { table, method, params: url.searchParams, signal: init?.signal }; trace.push(entry);
    const overridden = await beforeRead?.(entry);
    if (overridden) return overridden;
    let rows = tables[table].filter((row) => row[table === 'meetups' ? 'organizer_id' : 'user_id'] === owner);
    for (const [column, value] of url.searchParams) {
      if (['select', 'order', 'limit'].includes(column)) continue;
      if (value.startsWith('eq.')) rows = rows.filter((row) => row[column] === value.slice(3));
      else if (value.startsWith('gt.')) rows = rows.filter((row) => String(row[column]) > value.slice(3));
      else throw new Error('Unexpected synthetic filter');
    }
    const order = (url.searchParams.get('order') ?? '').split(',').filter(Boolean).map((part) => part.split('.'));
    rows = rows.slice().sort((a, b) => {
      for (const [column, direction] of order) {
        const value = String(a[column]).localeCompare(String(b[column]));
        if (value) return value * (direction === 'desc' ? -1 : 1);
      }
      return 0;
    });
    const headers = new Headers(init?.headers), count = headers.get('prefer')?.includes('count=exact') ? rows.length : '*';
    const single = headers.get('accept')?.includes('application/vnd.pgrst.object+json');
    if (single && rows.length !== 1) return new Response(JSON.stringify({ code: 'PGRST116', message: 'Expected one row' }), { status: 406 });
    const page = rows.slice(0, Math.min(cap, Number(url.searchParams.get('limit') ?? cap)));
    return new Response(method === 'HEAD' ? null : JSON.stringify(single ? page[0] : page), {
      status: 200, headers: { 'content-type': 'application/json', 'content-range': `${page.length ? `0-${page.length - 1}` : '*'}/${count}` },
    });
  });
  const db = createClient('https://synthetic.example.test', 'synthetic-test-key-not-a-real-credential', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  return { trace, fetch, client: { from: db.from.bind(db), auth: { getUser: async () => ({ data: { user: { id: owner } }, error: null }) } } };
}

const meetups = (signal?: AbortSignal) => getMeetups(new Request('https://app.example.test/api/me/meetups', { signal }));
const detail = (contactId = id(1), signal?: AbortSignal) => getContact(new Request('https://app.example.test/api/me/contacts/' + contactId, { signal }), { params: Promise.resolve({ id: contactId }) });
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden'); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('complete bounded Meetup lists and contact history', () => {
  it.each([2, 1000])('returns the full Meetups list at a backend cap of %i', async (cap) => {
    const rows = Array.from({ length: cap + 1 }, (_, i) => meetup(i + 1));
    const fixture = cappedTransport({ meetups: [...rows, meetup(9999, other)] }, cap); state.client = fixture.client;
    const response = await meetups(); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meetups).toHaveLength(cap + 1);
    expect(body.meetups.map((row: Row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(body.meetups.every((row: Row) => row.room_url === `https://app.example.test/m/${row.room_token}`)).toBe(true);
    expect(fixture.trace.every(({ params }) => params.get('limit') === '100' && !params.has('offset'))).toBe(true);
    expect(fixture.trace.at(-1)!.method).toBe('HEAD');
    expect(Object.keys(body)).toEqual(['meetups']);
  });
  it.each([2, 1000])('returns the full contact history at a backend cap of %i', async (cap) => {
    const rows = Array.from({ length: cap + 1 }, (_, i) => interaction(i + 1));
    const fixture = cappedTransport({ contacts: [person(1)], interactions: [...rows, interaction(9999, id(2), other), interaction(8888, id(3))] }, cap);
    state.client = fixture.client;
    const response = await detail(); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.interactions).toHaveLength(cap + 1);
    expect(body.interactions.map((row: Row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(fixture.trace.filter(({ table }) => table === 'interactions').every(({ params }) => params.get('contact_id') === `eq.${id(1)}` && params.get('limit') === '100' && !params.has('offset'))).toBe(true);
    expect(fixture.trace.at(-1)!.method).toBe('HEAD');
    expect(Object.keys(body).sort()).toEqual(['contact', 'interactions']);
  });

  it('restores newest-first microsecond ordering, normalizes offsets and stabilizes equal instants by id', async () => {
    const stamps = ['2026-10-24T00:00:00.000001Z', '2026-10-24T00:00:00.000003Z',
      '2026-10-24T05:30:00.000002+05:30', '2026-10-24T00:00:00.000002Z'];
    const meetings = stamps.map((created_at, index) => ({ ...meetup(index + 1), created_at }));
    const history = stamps.map((occurred_at, index) => ({ ...interaction(index + 1), occurred_at }));
    state.client = cappedTransport({ contacts: [person(1)], meetups: meetings, interactions: history }, 2).client;
    const listed = await meetups(); expect(listed.status).toBe(200);
    expect((await listed.json()).meetups.map((row: Row) => row.id)).toEqual([2, 3, 4, 1].map((n) => id(20000 + n)));
    const detailed = await detail(); expect(detailed.status).toBe(200);
    expect((await detailed.json()).interactions.map((row: Row) => row.id)).toEqual([2, 3, 4, 1].map((n) => id(10000 + n)));
  });

  it.each(['meetups', 'interactions'])('never returns partial data when a later %s page fails', async (table) => {
    const fixture = cappedTransport({ contacts: [person(1)], meetups: [1, 2, 3].map((n) => meetup(n)), interactions: [1, 2, 3].map((n) => interaction(n)) }, 2,
      (entry) => entry.table === table && entry.params.get('id')?.startsWith('gt.')
        ? new Response(JSON.stringify({ code: '57014', message: 'Synthetic late page failure' }), { status: 400 }) : undefined);
    state.client = fixture.client;
    const response = await (table === 'meetups' ? meetups() : detail());
    expect(response.status).toBe(503);
    const body = await response.json(); expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatch(/Complete data could not be loaded/);
    expect(fixture.trace.filter((entry) => entry.table === table)).toHaveLength(2);
  });

  it.each(['meetups', 'interactions'])('aborts a later %s page when its incoming request is cancelled', async (table) => {
    const controller = new AbortController(); let pageSignal: AbortSignal | null | undefined;
    const fixture = cappedTransport({ contacts: [person(1)], meetups: [1, 2, 3].map((n) => meetup(n)), interactions: [1, 2, 3].map((n) => interaction(n)) }, 2,
      (entry) => {
        if (entry.table === table && entry.params.get('id')?.startsWith('gt.')) {
          pageSignal = entry.signal; controller.abort(); throw new DOMException('Synthetic cancellation', 'AbortError');
        }
      });
    state.client = fixture.client;
    const response = await (table === 'meetups' ? meetups(controller.signal) : detail(id(1), controller.signal));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringContaining('cancelled') });
    expect(pageSignal?.aborted).toBe(true);
  });

  it('authenticates before collections and returns foreign/missing-contact404 before querying history', async () => {
    const fixture = cappedTransport({ contacts: [person(1), person(2, other)], interactions: [interaction(1, id(2))], meetups: [] }, 2);
    state.client = { ...fixture.client, auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
    expect((await meetups()).status).toBe(401); expect((await detail()).status).toBe(401);
    expect(fixture.trace).toEqual([]);
    state.client = fixture.client;
    expect((await detail(id(2))).status).toBe(404); expect((await detail(id(999))).status).toBe(404);
    expect(fixture.trace.map((entry) => entry.table)).toEqual(['contacts', 'contacts']);
  });

  it('preserves genuine empty successful payloads', async () => {
    state.client = cappedTransport({ contacts: [person(1)], interactions: [], meetups: [] }, 2).client;
    expect(await (await meetups()).json()).toEqual({ meetups: [] });
    expect(await (await detail()).json()).toEqual({ contact: person(1), interactions: [] });
  });

  it('leaves the intentionally bounded recent-activity max100 contract unchanged', async () => {
    const fixture = cappedTransport({ interactions: Array.from({ length: 101 }, (_, index) => interaction(index + 1)) }, 1000);
    state.client = fixture.client;
    const response = await getRecentActivity(new Request('https://app.example.test/api/me/interactions?limit=10000'));
    expect(response.status).toBe(200);
    expect((await response.json()).interactions).toHaveLength(100);
    expect(fixture.trace).toHaveLength(1);
    expect(fixture.trace[0].params.get('limit')).toBe('100');
  });

  it('loads both complete collections with real PostgreSQL owner RLS, without Bob data leakage', async () => {
    const db = await privacyDatabase();
    try {
      const tenants = await seedPrivateData(db) as Record<'alice' | 'bob', { contact: { id: string } }>;
      await asRole(db, 'authenticated', owner, async (tx: { query: (sql: string, args?: unknown[]) => Promise<unknown> }) => {
        await tx.query("insert into interactions (contact_id, notes) values ($1, 'Synthetic extra one'), ($1, 'Synthetic extra two')", [tenants.alice.contact.id]);
        await tx.query("insert into meetups (title) values ('Synthetic extra one'), ('Synthetic extra two')");
      });
      const base = pgliteClient(db, 'authenticated', owner, { organizerQueries: true, jsonRows: true, allowedTables: ['contacts', 'interactions', 'meetups'] });
      const tables: string[] = [];
      state.client = { ...base, from(table: string) {
        tables.push(table); const query = base.from(table), then = query.then.bind(query);
        query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => then((result: { data: unknown }) =>
          resolve({ ...result, data: Array.isArray(result.data) ? result.data.slice(0, 2) : result.data }), reject);
        return query;
      } };
      const history = await detail(tenants.alice.contact.id); expect(history.status).toBe(200);
      const historyBody = await history.json();
      expect(historyBody.interactions).toHaveLength(3);
      expect(historyBody.interactions.every((row: Row) => row.user_id === owner)).toBe(true);
      const listed = await meetups(); expect(listed.status).toBe(200);
      const listedBody = await listed.json();
      expect(listedBody.meetups).toHaveLength(3);
      expect(listedBody.meetups.every((row: Row) => row.organizer_id === owner)).toBe(true);
      tables.length = 0;
      expect((await detail(tenants.bob.contact.id)).status).toBe(404);
      expect(tables).toEqual(['contacts']);
    } finally { await db.close(); }
  }, 30_000);
});
