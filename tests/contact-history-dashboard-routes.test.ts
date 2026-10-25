import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: '11111111-1111-4111-8111-111111111111' as string | null,
  contacts: [] as Record<string, unknown>[],
  interactions: [] as Record<string, unknown>[],
  historyError: null as { message: string; code: string } | null,
  rpc: vi.fn(),
  draft: vi.fn(),
}));
vi.mock('@/lib/draft-llm', () => ({ draftMessage: state.draft }));
vi.mock('@/lib/ratelimit', () => ({ limitUser: async () => {} }));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.owner ? { id: state.owner } : null }, error: null }) },
  rpc: state.rpc,
  from(table: string) {
    let rows = table === 'contacts' ? state.contacts : table === 'interactions' ? state.interactions : [];
    let single = false;
    let limit: number | undefined;
    let head = false;
    const query = {
      select(_columns?: string, options?: { head?: boolean }) { head = options?.head === true; return query; },
      eq(key: string, value: unknown) { rows = rows.filter((row) => row[key] === value); return query; },
      gte(key: string, value: string) { rows = rows.filter((row) => Date.parse(String(row[key])) >= Date.parse(value)); return query; },
      lte(key: string, value: string) { rows = rows.filter((row) => Date.parse(String(row[key])) <= Date.parse(value)); return query; },
      gt(key: string, value: string) { rows = rows.filter((row) => String(row[key]) > value); return query; },
      or: () => query,
      order(key: string, opts: { ascending?: boolean } = {}) {
        rows = rows.slice().sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (opts.ascending === false ? -1 : 1));
        return query;
      },
      limit(size: number) { limit = size; return query; },
      abortSignal: () => query,
      single() { single = true; return query; },
      then(resolve: (value: unknown) => unknown) {
        const error = table === 'interactions' ? state.historyError
          : single && !rows.length ? { code: 'PGRST116', message: 'Not found' } : null;
        return Promise.resolve({ data: error || head ? null : single ? rows[0] : limit === undefined ? rows : rows.slice(0, limit), error, count: head ? rows.length : null }).then(resolve);
      },
    };
    return query;
  },
}) }));
import { GET as contactDetail } from '../app/api/me/contacts/[id]/route';
import { GET as dashboard } from '../app/api/me/dashboard/route';
import { POST as recordInteraction } from '../app/api/me/interactions/route';
import { POST as draftContact } from '../app/api/me/contacts/[id]/draft/route';

const id = '22222222-2222-4222-8222-222222222222';
const now = '2026-10-25T06:00:00.000Z';
const contact = { id, name: 'Synthetic Alice', category: 'personal', next_followup_at: null, last_interaction_at: null };
const detail = () => contactDetail(new Request('https://example.test/api/me/contacts/' + id), { params: Promise.resolve({ id }) });
const draft = () => draftContact(new Request('https://example.test/api/me/contacts/' + id + '/draft', { method: 'POST' }), { params: Promise.resolve({ id }) });
const log = (occurred_at?: string) => recordInteraction(new Request('https://example.test/api/me/interactions', {
  method: 'POST', body: JSON.stringify({ contact_id: id, ...(occurred_at ? { occurred_at } : {}) }),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  state.owner = '11111111-1111-4111-8111-111111111111';
  state.contacts = [contact]; state.interactions = []; state.historyError = null;
  state.rpc.mockReset().mockResolvedValue({ data: { interaction: { contact_id: id } }, error: null });
  state.draft.mockReset().mockResolvedValue({ message: 'Synthetic draft', source: 'template', basis: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('contact interaction history', () => {
  it('does not disguise an unavailable history query as a successful empty history', async () => {
    state.historyError = { code: '57014', message: 'Synthetic history query timeout' };
    const response = await detail();
    expect(response.ok).toBe(false);
    expect(await response.json()).toEqual({ error: 'Synthetic history query timeout' });
  });
  it('returns a genuinely empty history and newest-first populated history', async () => {
    expect(await (await detail()).json()).toEqual({ contact, interactions: [] });
    state.interactions = ['2026-10-20T12:00:00Z', '2026-10-24T12:00:00Z'].map((occurred_at) => ({ contact_id: id, occurred_at }));
    expect((await (await detail()).json()).interactions.map((row: { occurred_at: string }) => row.occurred_at))
      .toEqual(['2026-10-24T12:00:00Z', '2026-10-20T12:00:00Z']);
  });
  it('still authenticates and returns not found before querying history', async () => {
    state.owner = null; expect((await detail()).status).toBe(401);
    state.owner = '11111111-1111-4111-8111-111111111111'; state.contacts = [];
    state.historyError = { code: '57014', message: 'Must not be returned' };
    expect((await detail()).status).toBe(404);
  });
});

describe('draft history integrity', () => {
  it('does not generate a draft from silently missing history after a database failure', async () => {
    state.historyError = { code: '57014', message: 'Synthetic history query timeout' };
    const response = await draft();
    expect(state.draft).not.toHaveBeenCalled();
    expect(response.ok).toBe(false);
    expect(await response.json()).toEqual({ error: 'Synthetic history query timeout' });
  });
  it('passes a genuinely empty history or the three latest interactions to the draft provider', async () => {
    expect((await draft()).status).toBe(200);
    expect(state.draft).toHaveBeenLastCalledWith(contact, []);
    state.interactions = [1, 2, 3, 4].map((day) => ({ contact_id: id, occurred_at: `2026-10-0${day}T12:00:00Z`, notes: `Synthetic note ${day}` }));
    expect((await draft()).status).toBe(200);
    expect(state.draft).toHaveBeenLastCalledWith(contact, state.interactions.slice(1).reverse());
  });
  it('never generates a draft for unauthenticated or missing contacts', async () => {
    state.owner = null; expect((await draft()).status).toBe(401);
    state.owner = '11111111-1111-4111-8111-111111111111'; state.contacts = [];
    expect((await draft()).status).toBe(404);
    expect(state.draft).not.toHaveBeenCalled();
  });
});

describe('dashboard completed activity window', () => {
  it.each(['Z', '+05:30'])('counts only the inclusive last 30 days through now with %s offsets, not future or older rows', async (offset) => {
    const stamp = (value: string) => offset === 'Z' ? value : new Date(Date.parse(value) + 5.5 * 3600_000).toISOString().replace('Z', offset);
    state.interactions = [
      ['older', '2026-09-25T05:59:59.999Z'], ['start', '2026-09-25T06:00:00.000Z'],
      ['now', now], ['future', '2026-10-25T06:00:00.001Z'], ['far-future', '2030-01-01T00:00:00Z'],
    ].map(([id, occurred_at]) => ({ id, occurred_at: stamp(occurred_at), contact: { category: 'personal' } }));
    const response = await dashboard(new Request('https://example.test/api/me/dashboard'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recorded_activity).toMatchObject({ total: 2, by_category: { personal: 2 }, sufficient_data: false });
    expect(body.recent_activity.map((row: { id: string }) => row.id)).toEqual(['now', 'start']);
  });
});

describe('interaction occurrence validation', () => {
  it.each(['2026-10-25T06:00:00.001Z', '2030-01-01T00:00:00Z', '2026-10-25T12:00:01+05:30'])(
    'rejects future occurrence %s before it can advance follow-ups', async (timestamp) => {
      const response = await log(timestamp);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/future/i);
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, now, '2026-10-25T11:30:00+05:30', '2026-09-01T12:00:00Z'])(
    'preserves default, current and backdated occurrences: %s', async (timestamp) => {
      expect((await log(timestamp)).status).toBe(201);
      expect(state.rpc).toHaveBeenCalledWith('record_interaction', expect.objectContaining({ p_occurred_at: timestamp ?? now, p_set_next: false }));
    },
  );
});
