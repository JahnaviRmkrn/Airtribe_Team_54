import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  goalRows: [] as Record<string, unknown>[], owner: '11111111-1111-4111-8111-111111111111' as string | null, rows: [] as Record<string, unknown>[],
  readiness: true as unknown, readinessThrows: false, receipts: new Map<string, { body: string; ids: string[] }>(), lost: false, schemaMissing: false, calls: [] as unknown[],
}));
vi.mock('../lib/supabase/server', () => ({ userClient: async () => ({
  auth: { getUser: async () => ({ data: { user: mock.owner ? { id: mock.owner } : null }, error: null }) },
  from: () => ({ upsert: async (rows: Record<string, unknown>[]) => { mock.goalRows.push(...rows); return { error: null }; }, insert: (rows: Record<string, unknown>[]) => ({ select: async () => {
    const data = rows.map((row) => ({ ...row, id: crypto.randomUUID() })); mock.rows.push(...data);
    return { data, error: null };
  } }) }),
  rpc: (name: string, args: { p_intent: string; p_contacts: Record<string, unknown>[] }) => {
    const result = (async () => {
    mock.calls.push({ name, args });
    if (name === 'contact_create_retry_ready' && mock.readinessThrows) throw new Error('Synthetic readiness timeout');
    if (mock.schemaMissing) return { data: null, error: { code: 'PGRST202', message: 'Missing function' } };
    if (name === 'contact_create_retry_ready') return { data: mock.readiness, error: null };
    const key = mock.owner + ':' + args.p_intent; const body = JSON.stringify(args.p_contacts);
    let receipt = mock.receipts.get(key);
    if (receipt && receipt.body !== body) return { data: null, error: { code: '23505', message: 'contact_intent_conflict' } };
    if (!receipt) {
      const contacts = args.p_contacts.map((row) => ({ ...row, id: crypto.randomUUID(), user_id: mock.owner }));
      mock.rows.push(...contacts); receipt = { body, ids: contacts.map((c) => c.id) }; mock.receipts.set(key, receipt);
    }
    if (mock.lost) { mock.lost = false; throw new Error('Synthetic response lost after commit'); }
    const contacts = receipt.ids.flatMap((id) => mock.rows.filter((row) => row.id === id));
    return { data: { contacts, created_ids: receipt.ids, missing_ids: receipt.ids.filter((id) => !contacts.some((c) => c.id === id)) }, error: null };
    })();
    return Object.assign(result, { abortSignal: () => result });
  },
}) }));
import { GET as getMe } from '../app/api/me/route';
import { POST } from '../app/api/me/contacts/route';
import { PUT as saveGoals } from '../app/api/me/goals/route';
const owner = '11111111-1111-4111-8111-111111111111';
const key = '33333333-3333-4333-8333-333333333333';
const candidate = { name: 'Alice', category: 'personal' };
const request = (body: unknown = candidate, token: string | null = key, expectedOwner?: string) => new Request('https://example.test/api/me/contacts', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'Idempotency-Key': token }), ...(expectedOwner ? { 'X-Contact-Owner': expectedOwner } : {}) }, body: JSON.stringify(body),
});
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { vi.stubEnv('CONTACT_CREATE_RETRY_ENABLED', 'true'); mock.readiness = true; mock.readinessThrows = false; mock.goalRows = []; mock.rows = []; mock.lost = false; mock.owner = owner; mock.receipts.clear(); mock.calls = []; mock.schemaMissing = false; });
describe('manual contact create route', () => {
  it('replays a lost committed response and repeated retries without inserting again', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.lost = true;
    expect((await POST(request())).status).toBe(500);
    const retry = await POST(request());
    expect(retry.status).toBe(201);
    const receipt = await retry.json();
    expect(await (await POST(request())).json()).toEqual(receipt);
    expect(mock.rows).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({ name: 'create_contacts_once', args: { p_contacts: [{ ...candidate, interests: [] }] } });
    log.mockRestore();
  });
  it('rejects same-key edits but permits an intentional new key with identical details', async () => {
    await POST(request());
    expect((await POST(request({ ...candidate, category: 'professional' }))).status).toBe(409);
    expect(mock.rows).toHaveLength(1);
    expect((await POST(request(candidate, '44444444-4444-4444-8444-444444444444'))).status).toBe(201);
    expect(mock.rows).toHaveLength(2);
  });
  it('normalizes one and bulk requests into the same receipt and accepts full optional fields', async () => {
    const full = { ...candidate, notes: 'Note', email: 'alice@example.test', preferred_frequency_days: 14, next_followup_at: '2026-11-01T12:00:00Z', last_interaction_at: null };
    expect((await POST(request(full))).status).toBe(201);
    expect((await POST(request({ contacts: [full] }))).status).toBe(201);
    expect(mock.rows).toHaveLength(1);
  });
  it('returns stable original IDs but no deleted contact snapshot on replay', async () => {
    const original = await (await POST(request())).json();
    mock.rows = [];
    const replay = await POST(request());
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ contacts: [], created_ids: original.created_ids, missing_ids: original.created_ids });
    expect(mock.rows).toEqual([]);
  });
  it('retains legacy unkeyed creation, including deliberately adding the same name twice', async () => {
    expect((await POST(request(candidate, null))).status).toBe(201);
    expect((await POST(request(candidate, null))).status).toBe(201);
    expect(mock.rows).toHaveLength(2); expect(mock.calls).toEqual([]);
  });
  it.each(['', 'bad', 'x'.repeat(1000)])('rejects malformed key %j without creating anything', async (token) => {
    expect((await POST(request(candidate, token))).status).toBe(400); expect(mock.rows).toEqual([]);
  });
  it.each([null, [], {}, { name: 'Alice' }, { ...candidate, user_id: owner }, { ...candidate, unknown: true }, { contacts: [] }, { contacts: Array(6).fill(candidate) }, { ...candidate, preferred_frequency_days: 1.5 }])('rejects invalid keyed body %j', async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'contact_input_rejected' });
    expect(mock.calls).toEqual([]);
  });
  it('authenticates before parsing and blocks a changed browser account', async () => {
    mock.owner = null; expect((await POST(request())).status).toBe(401);
    mock.owner = owner; expect((await POST(request(candidate, key, '22222222-2222-4222-8222-222222222222'))).status).toBe(409);
    expect(mock.calls).toEqual([]);
  });
  it('fails closed when the new migration is absent, without unsafe insert fallback', async () => {
    mock.schemaMissing = true; expect((await POST(request())).status).toBe(503); expect(mock.rows).toEqual([]);
  });
});

const goals = { personal: 80, professional: 10, community: 10 };
const goalRequest = (expectedOwner: string | null = owner) => new Request('https://example.test/api/me/goals', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...(expectedOwner === null ? {} : { 'X-Contact-Owner': expectedOwner }) }, body: JSON.stringify(goals),
});
describe('onboarding goals owner binding', () => {
  it('rejects a switched account before the first goals mutation, not just before contacts', async () => {
    mock.owner = '22222222-2222-4222-8222-222222222222';
    expect((await saveGoals(goalRequest())).status).toBe(409);
    expect(mock.goalRows).toEqual([]); expect(mock.rows).toEqual([]);
  });
  it('allows the intended account, but rejects contacts if the account changes after the goals commit', async () => {
    expect((await saveGoals(goalRequest())).status).toBe(200);
    expect(mock.goalRows).toHaveLength(3); expect(mock.goalRows.every((row) => row.user_id === owner)).toBe(true);
    mock.owner = '22222222-2222-4222-8222-222222222222';
    expect((await POST(request(candidate, key, owner))).status).toBe(409);
    expect(mock.rows).toEqual([]); expect(mock.goalRows.some((row) => row.user_id === mock.owner)).toBe(false);
  });
  it('keeps legacy unbound goal clients compatible and still authenticates them', async () => {
    expect((await saveGoals(goalRequest(null))).status).toBe(200);
    expect(mock.goalRows).toHaveLength(3);
    mock.owner = null; expect((await saveGoals(goalRequest(null))).status).toBe(401);
    expect(mock.goalRows).toHaveLength(3);
  });
});


describe('manual contact retry opt-in rollout', () => {
  it.each([undefined, '', 'false', '1', 'TRUE'])('keeps Add and onboarding usable without RPCs when the flag is %j', async (value) => {
    vi.stubEnv('CONTACT_CREATE_RETRY_ENABLED', value); mock.schemaMissing = true;
    const me = await getMe(new Request('https://example.test/api/me'));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { id: owner }, capabilities: { contact_create_retry: false } });
    expect((await POST(request(candidate, null, owner))).status).toBe(201);
    expect((await saveGoals(goalRequest())).status).toBe(200);
    expect((await POST(request({ contacts: [candidate] }, null, owner))).status).toBe(201);
    expect(mock.rows).toHaveLength(2); expect(mock.goalRows).toHaveLength(3); expect(mock.calls).toEqual([]);
  });
  it('rejects keyed requests while disabled without RPCs or unsafe insert fallback', async () => {
    vi.stubEnv('CONTACT_CREATE_RETRY_ENABLED', undefined);
    const result = await POST(request());
    expect(result.status).toBe(503); expect(mock.calls).toEqual([]); expect(mock.rows).toEqual([]);
  });
  it('advertises enabled only after the authenticated read-only readiness check', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const me = await getMe(new Request('https://example.test/api/me'));
    expect(await me.json()).toMatchObject({ capabilities: { contact_create_retry: true } });
    expect(me.headers.get('Cache-Control')).toContain('no-store');
    expect(mock.calls).toEqual([{ name: 'contact_create_retry_ready', args: undefined }]);
    expect(mock.rows).toEqual([]); expect(mock.receipts.size).toBe(0);
    expect(timeout).toHaveBeenCalledWith(1500); timeout.mockRestore();
  });
  it.each([false, null, 'true', {}])('does not advertise enabled for readiness result %j', async (value) => {
    mock.readiness = value;
    const me = await getMe(new Request('https://example.test/api/me'));
    expect(me.status).toBe(200); expect(await me.json()).toMatchObject({ capabilities: { contact_create_retry: false } });
    expect(mock.rows).toEqual([]);
  });
  it.each(['missing', 'timeout'])('keeps profile and legacy creation usable if readiness is %s', async (failure) => {
    mock.schemaMissing = failure === 'missing'; mock.readinessThrows = failure === 'timeout';
    const me = await getMe(new Request('https://example.test/api/me'));
    expect(me.status).toBe(200); expect(await me.json()).toMatchObject({ capabilities: { contact_create_retry: false } });
    expect((await POST(request(candidate, null))).status).toBe(201);
    expect(mock.calls).toHaveLength(1); expect(mock.rows).toHaveLength(1);
  });
  it('authenticates capability reads before probing database readiness', async () => {
    mock.owner = null;
    expect((await getMe(new Request('https://example.test/api/me'))).status).toBe(401);
    expect(mock.calls).toEqual([]);
  });
});
