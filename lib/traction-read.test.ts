import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLedger } from './traction';
import { allById, organizerEmails, readTractionData } from './traction-read';

const id = (n: number) => String(n).padStart(6, '0');
const rows = (count: number, start = 0) => Array.from({ length: count }, (_, n) => ({ id: id(start + n) }));

const keysetPage = (source: { id: string }[], cap = 1000) => vi.fn(async (after: string | null, limit: number, head: boolean) => {
  const remaining = source.filter((r) => after === null || r.id > after);
  return head ? { data: null, count: remaining.length, error: null } : { data: remaining.slice(0, Math.min(limit, cap)), error: null };
});

describe('allById', () => {
  it('uses ascending keysets, preserves cutoff semantics and verifies the terminal empty read', async () => {
    const source = rows(2001);
    const page = vi.fn(async (after: string | null, limit: number, head: boolean) => {
      if (after === id(999)) source.push({ id: '000500-new' }, { id: '001500-new' });
      const remaining = source.filter((r) => after === null || r.id > after).sort((a, b) => a.id.localeCompare(b.id));
      return head ? { data: null, count: remaining.length, error: null } : { data: remaining.slice(0, limit), error: null };
    });
    const result = await allById(page);
    expect(page.mock.calls.map(([after]) => after)).toEqual([null, id(999), id(1998), id(2000), id(2000)]);
    expect(page.mock.calls.at(-1)?.[2]).toBe(true);
    expect(result).toHaveLength(2002); expect(new Set(result.map((r) => r.id)).size).toBe(result.length);
    expect(result).toContainEqual({ id: '001500-new' }); expect(result).not.toContainEqual({ id: '000500-new' });
    expect(result.filter((r) => !r.id.endsWith('-new'))).toEqual(rows(2001));
  });
  it.each([2, 1000])('continues after short pages at backend cap %i', async (cap) => {
    const source = rows(cap + 1), page = keysetPage(source, cap);
    expect(await allById(page)).toEqual(source);
    expect(page.mock.calls.at(-1)).toEqual([id(cap), 1000, true, expect.any(AbortSignal)]);
  });
  it('deduplicates repeated IDs within and across advancing pages', async () => {
    const page = vi.fn().mockResolvedValueOnce({ data: [...rows(999), { id: id(998) }], error: null })
      .mockResolvedValueOnce({ data: [{ id: id(998) }, { id: id(999) }], error: null })
      .mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: null, count: 0, error: null });
    expect(await allById(page)).toEqual(rows(1000));
  });
  it('accepts only independently verified empty results; null SELECT is invalid', async () => {
    expect(await allById(keysetPage([]))).toEqual([]);
    await expect(allById(async () => ({ data: null, error: null }))).rejects.toThrow('invalid database page');
  });
  it.each([undefined, null, 1])('rejects empty SELECT with unverifiable HEAD count %s', async (count) => {
    await expect(allById(async (_after, _limit, head) => head ? { data: null, count, error: null } : { data: [], error: null })).rejects.toThrow('end of the result could not be verified');
  });
  it('rejects a failed HEAD verification', async () => {
    await expect(allById(async (_after, _limit, head) => head ? { data: null, error: { message: 'HEAD failed' } } : { data: [], error: null })).rejects.toThrow('database page was unavailable');
  });
  it('throws on a later page error rather than returning partial totals', async () => {
    const page = vi.fn().mockResolvedValueOnce({ data: rows(2), error: null }).mockResolvedValueOnce({ data: null, error: { message: 'read failed' } });
    await expect(allById(page)).rejects.toThrow('database page was unavailable');
  });
  it.each([id(999), id(998)])('rejects a non-advancing cursor %s, even on a short page', async (last) => {
    const page = vi.fn().mockResolvedValueOnce({ data: rows(1000), error: null }).mockResolvedValueOnce({ data: [{ id: last }], error: null });
    await expect(allById(page)).rejects.toThrow('ID cursor did not advance'); expect(page).toHaveBeenCalledTimes(2);
  });
  it('accepts exactly 50,000 rows with 51 data reads plus one HEAD', async () => {
    const source = rows(50_000), page = keysetPage(source);
    expect(await allById(page)).toEqual(source); expect(page).toHaveBeenCalledTimes(52);
    expect(page.mock.calls.filter(([, , head]) => !head)).toHaveLength(51);
  });
  it('rejects 50,001 rows instead of capped totals', async () => {
    const page = keysetPage(rows(50_001));
    await expect(allById(page)).rejects.toThrow('too many rows to count'); expect(page).toHaveBeenCalledTimes(51);
  });
  it('does not weaken the 51-data-request budget for low server caps', async () => {
    const page = keysetPage(rows(102), 2);
    await expect(allById(page)).rejects.toThrow('pagination safety limit exceeded'); expect(page).toHaveBeenCalledTimes(51);
  });
  it('bounds requests when advancing pages contain excessive duplicates', async () => {
    const page = vi.fn(async (after: string | null, limit: number) => ({ data: Array.from({ length: limit }, () => ({ id: id(after === null ? 0 : Number(after) + 1) })), error: null }));
    await expect(allById(page)).rejects.toThrow('pagination safety limit exceeded'); expect(page).toHaveBeenCalledTimes(51);
  });
  it('validates raw oversized, unordered and malformed pages before dedup', async () => {
    await expect(allById(async () => ({ data: Array(1001).fill({ id: 'same' }), error: null }))).rejects.toThrow('page exceeded requested row limit');
    await expect(allById(async () => ({ data: [{ id: 'b' }, { id: 'a' }], error: null }))).rejects.toThrow('invalid database page order');
    await expect(allById(async () => ({ data: [{ id: '' }], error: null }))).rejects.toThrow('invalid database page order');
  });
  it('counts raw duplicate bytes before normalization', async () => {
    await expect(allById(async () => ({ data: Array(1000).fill({ id: 'same', value: 'x'.repeat(17_000) }), error: null }))).rejects.toThrow('byte safety limit');
  });
});

describe('organizerEmails', () => {
  it('deduplicates relevant IDs and bounds concurrency to four without a user-list cap', async () => {
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 23 }, (_, i) => `organizer-${i}`);
    const lookup = vi.fn(async (userId: string) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return { data: { user: { email: `${userId}@muop.win` } }, error: null };
    });
    const result = await organizerEmails([...ids, ...ids, null, ''], lookup);
    expect(peak).toBe(4);
    expect(lookup.mock.calls.map(([userId]) => userId)).toEqual(ids);
    expect(result.size).toBe(ids.length);
    expect(result.get('organizer-22')).toBe('organizer-22@muop.win');
  });

  it('returns null for lookup errors, throws, missing users and missing emails', async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce({ data: { user: { email: 'do-not-trust@example.com' } }, error: { message: 'failed' } })
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce({ data: { user: null }, error: null })
      .mockResolvedValueOnce({ data: { user: {} }, error: null })
      .mockResolvedValueOnce({ data: { user: { email: '  ' } }, error: null })
      .mockResolvedValueOnce({ data: { user: { email: ' valid@muop.win ' } }, error: null });
    const result = await organizerEmails(['error', 'throw', 'missing', 'no-email', 'blank', 'valid'], lookup);
    expect([...result.entries()].sort()).toEqual([
      ['blank', null], ['error', null], ['missing', null], ['no-email', null], ['throw', null], ['valid', 'valid@muop.win'],
    ]);
  });

  it('makes no auth requests for no relevant organizer IDs', async () => {
    const lookup = vi.fn();
    expect(await organizerEmails([null, ''], lookup)).toEqual(new Map());
    expect(lookup).not.toHaveBeenCalled();
  });
});

type Row = { id: string; [key: string]: unknown };
type Filter = { op: 'gt' | 'gte' | 'lte' | 'in'; column: string; value: string | string[] };
type QueryCall = { table: string; columns?: string; filters: Filter[]; ascending?: boolean; limit?: number; head?: boolean; signal?: AbortSignal };
type QueryResult = { data: Row[] | null; error: { message: string } | null; count?: number | null };

// In-memory PostgREST-shaped mock. No client construction or remote reads.
function fakeDb(tables: Record<string, Row[]>, onRead?: (call: QueryCall) => void, failTable?: string, options: { cap?: Record<string, number>; headCount?: number | null; omitHeadCount?: boolean; failHead?: boolean; headTarget?: string; failCursor?: string } = {}) {
  const calls: QueryCall[] = [];
  const getUserById = vi.fn(async (userId: string) => ({ data: { user: { email: `${userId}@muop.win` } }, error: null }));
  const listUsers = vi.fn(() => { throw new Error('must not enumerate auth users'); });
  const from = (table: string) => {
    const call: QueryCall = { table, filters: [] };
    calls.push(call);
    const filter = (op: Filter['op'], column: string, value: string | string[]) => {
      call.filters.push({ op, column, value });
      return query;
    };
    const query = {
      select: (columns: string, opts?: { head?: boolean; count?: string }) => { call.columns = columns; call.head = opts?.head; if (opts?.head) expect(opts.count).toBe('exact'); return query; },
      abortSignal: (signal: AbortSignal) => { call.signal = signal; return query; },
      gte: (column: string, value: string) => filter('gte', column, value),
      lte: (column: string, value: string) => filter('lte', column, value),
      gt: (column: string, value: string) => filter('gt', column, value),
      in: (column: string, value: string[]) => filter('in', column, value),
      order: (column: string, options: { ascending: boolean }) => { expect(column).toBe('id'); call.ascending = options.ascending; return query; },
      limit: (limit: number) => { call.limit = limit; return query; },
      then: (resolve: (result: QueryResult) => unknown, reject: (reason: unknown) => unknown) => {
        onRead?.(call);
        let data = [...(tables[table] ?? [])];
        for (const f of call.filters) {
          data = data.filter((r) => {
            const value = String(r[f.column]);
            if (f.op === 'in') return (f.value as string[]).includes(value);
            if (f.op === 'gt') return value > f.value;
            if (f.op === 'gte') return value >= f.value;
            return value <= f.value;
          });
        }
        if (call.ascending) data.sort((a, b) => a.id.localeCompare(b.id));
        const count = data.length;
        if (!call.head) data = data.slice(0, Math.min(call.limit ?? Infinity, options.cap?.[table] ?? Infinity));
        const headApplies = !options.headTarget || options.headTarget === table;
        const failure = table === failTable || (call.head && headApplies && options.failHead) || (options.failCursor === table && call.filters.some((f) => f.op === 'gt'));
        return Promise.resolve(failure ? { data: null, error: { message: `${table} failed` } }
          : call.head ? { data: null, error: null, count: headApplies && options.omitHeadCount ? undefined : headApplies && Object.hasOwn(options, 'headCount') ? options.headCount : count }
          : { data, error: null }).then(resolve, reject);
      },
    };
    return query;
  };
  return { db: { from, auth: { admin: { getUserById, listUsers } } } as unknown as SupabaseClient, calls, getUserById, listUsers };
}

describe('readTractionData', () => {
  afterEach(() => vi.useRealTimers());

  it('applies one fixed cutoff to every attendee and vote keyset query', async () => {
    vi.useFakeTimers();
    const cutoff = '2026-10-25T04:00:00.000Z';
    const since = '2026-10-24T00:00:00.000Z';
    vi.setSystemTime(new Date(cutoff));
    const mock = fakeDb({
      meetup_attendees: [
        ...rows(1001).map((r) => ({ ...r, meetup_id: 'room', joined_at: cutoff })),
        { id: 'late', meetup_id: 'room', joined_at: '2026-10-25T04:00:01.000Z' },
        { id: 'old', meetup_id: 'room', joined_at: '2026-10-23T00:00:00.000Z' },
      ],
      venue_votes: [
        ...rows(1001).map((r) => ({ ...r, attendee_id: r.id, created_at: cutoff })),
        { id: 'late', attendee_id: 'late', created_at: '2026-10-25T04:00:01.000Z' },
        { id: 'old', attendee_id: 'old', created_at: '2026-10-23T00:00:00.000Z' },
      ],
      meetups: [{ id: 'room', organizer_id: 'owner' }],
    }, () => vi.setSystemTime(Date.now() + 60_000));
    const result = await readTractionData(mock.db, since);
    expect(result.attendees).toHaveLength(1001);
    expect(result.votes).toHaveLength(1001);
    for (const table of ['meetup_attendees', 'venue_votes']) {
      const queries = mock.calls.filter((c) => c.table === table);
      const column = table === 'meetup_attendees' ? 'joined_at' : 'created_at';
      expect(queries).toHaveLength(4);
      for (const query of queries) {
        expect(query.filters).toContainEqual({ op: 'gte', column, value: since });
        expect(query.filters).toContainEqual({ op: 'lte', column, value: cutoff });
        expect(query).toMatchObject({ ascending: true, limit: 1000 });
      }
      expect(queries[1].filters).toContainEqual({ op: 'gt', column: 'id', value: id(999) });
    }
    expect(mock.calls.find((c) => c.table === 'venue_votes')?.columns?.split(', ')).toContain('id');
  });

  it('reads only distinct referenced meetups in chunks of at most 100 and targets their organizers', async () => {
    const meetupIds = rows(205).map((r) => `room-${r.id}`);
    const mock = fakeDb({
      meetup_attendees: [...meetupIds, meetupIds[0]].map((meetup_id, n) => ({ id: id(n), meetup_id, joined_at: '2026-10-24T01:00:00.000Z' })),
      meetups: [...meetupIds.map((room, n) => ({ id: room, organizer_id: `owner-${n % 2}` })), { id: 'unused', organizer_id: 'unrelated' }],
    });
    const result = await readTractionData(mock.db, '2026-10-24T00:00:00.000Z');
    const chunks = mock.calls.filter((c) => c.table === 'meetups' && !c.head && !c.filters.some((f) => f.op === 'gt')).map((c) => c.filters[0]);
    expect(chunks.map((c) => c.value.length)).toEqual([100, 100, 5]);
    expect(chunks.flatMap((c) => c.value)).toEqual(meetupIds);
    expect(chunks.every((c) => c.op === 'in' && c.column === 'id')).toBe(true);
    expect(result.meetups).toHaveLength(205);
    expect(mock.getUserById.mock.calls.map(([userId]) => userId).sort()).toEqual(['owner-0', 'owner-1']);
    expect(mock.listUsers).not.toHaveBeenCalled();
  });

  it('skips meetups and auth entirely when there are no attendees', async () => {
    const mock = fakeDb({});
    expect(await readTractionData(mock.db, '2026-10-24T00:00:00.000Z')).toEqual({ attendees: [], votes: [], meetups: [] });
    expect(mock.calls.map((c) => c.table).sort()).toEqual(['meetup_attendees', 'meetup_attendees', 'venue_votes', 'venue_votes']);
    expect(mock.getUserById).not.toHaveBeenCalled();
    expect(mock.listUsers).not.toHaveBeenCalled();
  });

  it('preserves an unknown organizer as null', async () => {
    const mock = fakeDb({
      meetup_attendees: [{ id: 'a', meetup_id: 'room', joined_at: '2026-10-24T01:00:00.000Z' }],
      meetups: [{ id: 'room', organizer_id: null }],
    });
    expect((await readTractionData(mock.db, '2026-10-24T00:00:00.000Z')).meetups).toEqual([{ id: 'room', organizer_email: null }]);
    expect(mock.getUserById).not.toHaveBeenCalled();
  });

  it('rejects a meetup read error rather than silently dropping rooms', async () => {
    const mock = fakeDb({ meetup_attendees: [{ id: 'a', meetup_id: 'room', joined_at: '2026-10-24T01:00:00.000Z' }] }, undefined, 'meetups');
    await expect(readTractionData(mock.db, '2026-10-24T00:00:00.000Z')).rejects.toThrow('database page was unavailable');
  });
});


const tractionRows = (count = 5) => ({
  meetup_attendees: rows(count).map((r, n) => ({ ...r, meetup_id: 'room-' + r.id, guest_name: 'Synthetic ' + n,
    preferences: { food: ['veg'] }, availability: [], joined_at: new Date(Date.UTC(2026, 9, 24, 1, 0, n)).toISOString(), updated_at: '2026-10-24T02:00:00Z' })),
  venue_votes: rows(count).map((r) => ({ ...r, attendee_id: r.id, created_at: '2026-10-24T02:00:00Z' })),
  meetups: rows(count).map((r) => ({ id: 'room-' + r.id, organizer_id: 'owner-' + r.id })),
});
const since = '2026-10-24T00:00:00Z';
const streams = ['meetup_attendees', 'venue_votes', 'meetups'];

describe('complete service-role traction streams', () => {
  afterEach(() => vi.useRealTimers());
  it.each(streams)('does not silently truncate %s at cap2 or turn missing pages into unverified exclusions', async (table) => {
    const mock = fakeDb(tractionRows(), undefined, undefined, { cap: { [table]: 2 } });
    const data = await readTractionData(mock.db, since);
    expect(data.attendees).toHaveLength(5); expect(data.votes).toHaveLength(5); expect(data.meetups).toHaveLength(5);
    expect(buildLedger(data.meetups, data.attendees, data.votes, { since, testDomains: ['example.test'], teamNames: [] }))
      .toMatchObject({ joined: 5, shared: 5, completed: 5, rooms: 5, excluded: { unverified: 0 } });
    const queries = mock.calls.filter((c) => c.table === table);
    expect(queries).toHaveLength(5); expect(queries.at(-1)?.head).toBe(true);
    expect(queries.every((q) => q.ascending && q.limit === 1000 && q.signal instanceof AbortSignal)).toBe(true);
    const scope = queries[0].filters;
    expect(queries.every((q) => scope.every((f) => q.filters.some((actual) => JSON.stringify(actual) === JSON.stringify(f))))).toBe(true);
  });
  it.each(streams)('rejects zero-row cap for nonempty %s, rather than returning misleading empty data', async (table) => {
    const mock = fakeDb(tractionRows(), undefined, undefined, { cap: { [table]: 0 } });
    await expect(readTractionData(mock.db, since)).rejects.toThrow('end of the result could not be verified');
    expect(mock.getUserById).not.toHaveBeenCalled();
  });
  it.each(streams)('fails closed on second-page %s errors without looking up organizers', async (table) => {
    const mock = fakeDb(tractionRows(), undefined, undefined, { cap: { [table]: 2 }, failCursor: table });
    await expect(readTractionData(mock.db, since)).rejects.toThrow('database page was unavailable');
    expect(mock.getUserById).not.toHaveBeenCalled();
  });
  it.each(streams.flatMap((table) => ['missing', 'null', 'error'].map((mode) => [table, mode])))('rejects %s HEAD %s independently', async (table, mode) => {
    const options = { headTarget: table, ...(mode === 'missing' ? { omitHeadCount: true } : mode === 'null' ? { headCount: null } : { failHead: true }) };
    const mock = fakeDb(tractionRows(), undefined, undefined, options);
    await expect(readTractionData(mock.db, since)).rejects.toThrow(/end of the result could not be verified|database page was unavailable/);
    expect(mock.getUserById).not.toHaveBeenCalled();
  });
  it('keeps ordinary identity failures separate from incomplete collection reads', async () => {
    const mock = fakeDb(tractionRows(), undefined, undefined, { cap: { meetups: 2 } });
    mock.getUserById.mockResolvedValue({ data: { user: { email: '' } }, error: null });
    const data = await readTractionData(mock.db, since);
    expect(data.meetups).toHaveLength(5);
    expect(buildLedger(data.meetups, data.attendees, data.votes, { since, testDomains: [], teamNames: [] }).excluded.unverified).toBe(5);
  });
  it('shares a finite request budget across many capped meetup chunks', async () => {
    const mock = fakeDb(tractionRows(3100), undefined, undefined, { cap: { meetups: 2 } });
    await expect(readTractionData(mock.db, since)).rejects.toThrow('read request limit');
    expect(mock.calls).toHaveLength(1604); expect(mock.getUserById).not.toHaveBeenCalled();
  });
  it('bounds an unresolved organizer lookup by the same load deadline, not unverified fallback', async () => {
    vi.useFakeTimers();
    const mock = fakeDb(tractionRows());
    mock.getUserById.mockImplementation(() => new Promise(() => {}));
    const pending = readTractionData(mock.db, since);
    const rejected = expect(pending).rejects.toThrow('complete load deadline exceeded');
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(mock.getUserById).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20_000); expect(mock.getUserById).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
