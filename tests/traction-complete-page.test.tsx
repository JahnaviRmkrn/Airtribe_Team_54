import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: null as unknown as SupabaseClient }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => state.db }));
// Only Next cache plumbing and admin-client construction are substituted. The
// checked-in page, reader, shared completeness helper and ledger all execute.
vi.mock('next/cache', () => ({ unstable_cache: (load: () => unknown) => load }));
import TractionPage from '../app/traction/page';

type Row = { id: string; [key: string]: unknown };
type Trace = { table: string; method: string; params: URLSearchParams };
const uid = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const data = (count = 5): Record<string, Row[]> => ({
  meetup_attendees: Array.from({ length: count }, (_, n) => ({ id: uid(n + 1), meetup_id: uid(n + 1001), guest_name: `Private Synthetic Guest ${n}`,
    preferences: { food: ['veg'] }, availability: [], joined_at: new Date(Date.UTC(2026, 9, 24, 1, 0, n)).toISOString(), updated_at: '2026-10-24T02:00:00Z' })),
  venue_votes: Array.from({ length: count }, (_, n) => ({ id: uid(n + 2001), attendee_id: uid(n + 1), created_at: '2026-10-24T02:00:00Z' })),
  meetups: Array.from({ length: count }, (_, n) => ({ id: uid(n + 1001), organizer_id: uid(n + 3001) })),
});
function transport(tables: Record<string, Row[]>, options: { cap?: number; failTable?: string; zeroAfter?: string; missingHead?: string; unknownOwner?: boolean } = {}) {
  const trace: Trace[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://traction.synthetic.invalid' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected transport destination');
    const table = url.pathname.slice('/rest/v1/'.length), method = init?.method ?? 'GET';
    if (!Object.hasOwn(tables, table) || !['GET', 'HEAD'].includes(method)) throw new Error('Only fixed synthetic reads permitted');
    trace.push({ table, method, params: url.searchParams });
    const cursor = url.searchParams.getAll('id').some((value) => value.startsWith('gt.'));
    if (options.failTable === table && cursor) return new Response(JSON.stringify({ code: '57014', message: 'Synthetic later page failure' }), { status: 400 });
    let rows = tables[table].slice();
    for (const [column, value] of url.searchParams) {
      if (['select', 'limit', 'order'].includes(column)) continue;
      if (value.startsWith('in.(')) {
        const ids = value.slice(4, -1).split(','); rows = rows.filter((row) => ids.includes(String(row[column])));
      } else if (value.startsWith('gte.')) rows = rows.filter((row) => String(row[column]) >= value.slice(4));
      else if (value.startsWith('lte.')) rows = rows.filter((row) => String(row[column]) <= value.slice(4));
      else if (value.startsWith('gt.')) rows = rows.filter((row) => String(row[column]) > value.slice(3));
      else throw new Error('Unexpected synthetic filter');
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const total = rows.length, cap = options.zeroAfter === table && cursor ? 0 : options.cap ?? 2;
    rows = rows.slice(0, Math.min(cap, Number(url.searchParams.get('limit') ?? cap)));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (!(method === 'HEAD' && options.missingHead === table)) headers['content-range'] = `${rows.length ? `0-${rows.length - 1}` : '*'}/${total}`;
    return new Response(method === 'HEAD' ? null : JSON.stringify(rows), { status: 200, headers });
  });
  const db = createClient('https://traction.synthetic.invalid', 'synthetic-not-a-real-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch },
  });
  state.db = { from: db.from.bind(db), auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: options.unknownOwner ? null : { email: 'synthetic@people.example.test' } }, error: null })) } } } as unknown as SupabaseClient;
  vi.stubGlobal('fetch', () => { throw new Error('External fetch forbidden'); });
  return { trace, fetch };
}
afterEach(() => vi.unstubAllGlobals());

describe('actual Traction page + complete reader + ledger', () => {
  it('renders all five completions with all three actual Supabase query streams capped at two', async () => {
    const fixture = transport(data());
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('5 people planned a meetup with muop');
    expect(html).toContain('<strong>5</strong><span>joined a room</span>');
    expect(html).toContain('<strong>5</strong><span>shared preferences</span>');
    expect(html).not.toContain('could not be verified');
    expect(html).not.toContain('Private Synthetic Guest'); expect(html).not.toContain('synthetic@'); expect(html).not.toContain(uid(1));
    for (const table of ['meetup_attendees', 'venue_votes', 'meetups']) {
      const queries = fixture.trace.filter((q) => q.table === table);
      expect(queries).toHaveLength(5); expect(queries.at(-1)?.method).toBe('HEAD');
      expect(queries.every((q) => q.params.get('order') === 'id.asc' && q.params.get('limit') === '1000' && !q.params.has('offset'))).toBe(true);
    }
  });
  it.each(['meetup_attendees', 'venue_votes', 'meetups'])('shows no totals after a later %s page fails', async (failTable) => {
    transport(data(), { failTable });
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('load the numbers right now'); expect(html).not.toContain('planned a meetup'); expect(html).not.toContain('tr-funnel');
    expect(html).not.toContain('visits are excluded');
  });
  it.each(['meetup_attendees', 'venue_votes', 'meetups'])('rejects a %s backend cap changing from2 to0 midscan', async (zeroAfter) => {
    transport(data(), { zeroAfter });
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('load the numbers right now'); expect(html).not.toContain('planned a meetup');
  });
  it.each(['meetup_attendees', 'venue_votes', 'meetups'])('shows no totals without an independent %s HEAD count', async (missingHead) => {
    transport(data(), { missingHead });
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('load the numbers right now'); expect(html).not.toContain('planned a meetup');
  });
  it('shows the error state rather than partial totals when the finite low-cap request budget is exhausted', async () => {
    const fixture = transport(data(102));
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('load the numbers right now'); expect(html).not.toContain('planned a meetup');
    expect(fixture.trace.filter((q) => q.table === 'meetup_attendees')).toHaveLength(51);
  });
  it('retains the distinct disclosure for genuinely missing organizer identity', async () => {
    transport(data(), { unknownOwner: true });
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('5 visits are excluded because the room or organizer could not be verified');
    expect(html).toContain('0 people planned a meetup'); expect(html).not.toContain('load the numbers right now');
  });
});
