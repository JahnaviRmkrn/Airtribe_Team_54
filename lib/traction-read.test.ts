import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allById, organizerEmails, readTractionData } from './traction-read';

const id = (n: number) => String(n).padStart(6, '0');
const rows = (count: number, start = 0) => Array.from({ length: count }, (_, n) => ({ id: id(start + n) }));

describe('allById', () => {
  it('uses ascending keysets across pages without offset duplicates during insertions', async () => {
    const source = rows(2001);
    const page = vi.fn(async (after: string | null, limit: number) => {
      if (after === id(999)) {
        source.push({ id: '000500-new' }, { id: '001500-new' });
      }
      return { data: source.filter((r) => after === null || r.id > after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit), error: null };
    });
    const result = await allById(page);
    expect(page.mock.calls.map(([after]) => after)).toEqual([null, id(999), id(1998)]);
    expect(result).toHaveLength(2002);
    expect(new Set(result.map((r) => r.id)).size).toBe(result.length);
    expect(result).toContainEqual({ id: '001500-new' });
    // Backdated IDs inserted behind the cursor can be missed: not a snapshot.
    expect(result).not.toContainEqual({ id: '000500-new' });
    expect(result.filter((r) => !r.id.endsWith('-new'))).toEqual(rows(2001));
  });

  it('deduplicates repeated IDs within and across pages', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ data: [...rows(999), { id: id(998) }], error: null })
      .mockResolvedValueOnce({ data: [{ id: id(998) }, { id: id(999) }], error: null });
    expect(await allById(page)).toEqual(rows(1000));
  });

  it('returns empty results for null or empty pages', async () => {
    expect(await allById(async () => ({ data: null, error: null }))).toEqual([]);
    expect(await allById(async () => ({ data: [], error: null }))).toEqual([]);
  });

  it('throws on a page error rather than returning partial totals', async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ data: rows(1000), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'read failed' } });
    await expect(allById(page)).rejects.toThrow('read failed');
  });

  it.each([id(999), id(998)])('rejects a non-advancing cursor %s, even on a short page', async (last) => {
    const page = vi.fn()
      .mockResolvedValueOnce({ data: rows(1000), error: null })
      .mockResolvedValueOnce({ data: [{ id: last }], error: null });
    await expect(allById(page)).rejects.toThrow('ID cursor did not advance');
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('accepts exactly 50,000 unique rows after a terminating empty read', async () => {
    const source = rows(50_000);
    const page = vi.fn(async (after: string | null, limit: number) => ({
      data: source.slice(after === null ? 0 : Number(after) + 1, (after === null ? 0 : Number(after) + 1) + limit), error: null,
    }));
    expect(await allById(page)).toEqual(source);
    expect(page).toHaveBeenCalledTimes(51);
  });

  it('rejects 50,001 unique rows instead of returning capped totals', async () => {
    const source = rows(50_001);
    const page = vi.fn(async (after: string | null, limit: number) => ({
      data: source.slice(after === null ? 0 : Number(after) + 1, (after === null ? 0 : Number(after) + 1) + limit), error: null,
    }));
    await expect(allById(page)).rejects.toThrow('too many rows to count');
    expect(page).toHaveBeenCalledTimes(51);
  });

  it('bounds requests separately when advancing pages contain excessive duplicates', async () => {
    const page = vi.fn(async (after: string | null, limit: number) => ({
      data: Array.from({ length: limit }, () => ({ id: id(after === null ? 0 : Number(after) + 1) })), error: null,
    }));
    await expect(allById(page)).rejects.toThrow('pagination safety limit exceeded');
    expect(page).toHaveBeenCalledTimes(51);
  });

  it('rejects an oversized response that ignores the requested row limit', async () => {
    await expect(allById(async () => ({ data: rows(1001), error: null }))).rejects.toThrow('page exceeded requested row limit');
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
type QueryCall = { table: string; columns?: string; filters: Filter[]; ascending?: boolean; limit?: number };
type QueryResult = { data: Row[] | null; error: { message: string } | null };

// In-memory PostgREST-shaped mock. No client construction or remote reads.
function fakeDb(tables: Record<string, Row[]>, onRead?: (call: QueryCall) => void, failTable?: string) {
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
      select: (columns: string) => { call.columns = columns; return query; },
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
        if (call.limit) data = data.slice(0, call.limit);
        return Promise.resolve(table === failTable ? { data: null, error: { message: `${table} failed` } } : { data, error: null }).then(resolve, reject);
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
      expect(queries).toHaveLength(2);
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
    const chunks = mock.calls.filter((c) => c.table === 'meetups').map((c) => c.filters[0]);
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
    expect(mock.calls.map((c) => c.table)).toEqual(['meetup_attendees', 'venue_votes']);
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
    await expect(readTractionData(mock.db, '2026-10-24T00:00:00.000Z')).rejects.toThrow('meetups failed');
  });
});
