import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({ userClient: vi.fn(), draftMessage: vi.fn(), limitUser: vi.fn() }));
vi.mock('server-only', () => ({}));
// Secret, database and provider modules are intercepted before any route import.
vi.mock('@/lib/supabase/server', () => ({ userClient: deps.userClient }));
vi.mock('@/lib/secrets', () => ({ loadVaultSecrets: () => { throw new Error('Vault is forbidden in these tests'); } }));
vi.mock('@/lib/ratelimit', () => ({ limitUser: deps.limitUser }));
vi.mock('@/lib/draft-llm', () => ({ draftMessage: deps.draftMessage }));
import { POST as assistant } from '../app/api/assistant/route';
import { POST as draft } from '../app/api/me/contacts/[id]/draft/route';

const contact = { name: 'Synthetic Alice', category: 'personal', notes: 'Synthetic private note', interests: ['books'], last_interaction_at: null };
const makeClient = ({ signedIn = true, missing = false, historyFailed = false } = {}) => {
  const queries: { table: string; filters: [string, string][] }[] = [];
  return { queries, auth: { getUser: vi.fn(async () => ({ data: { user: signedIn ? { id: 'owner-a' } : null }, error: null })) },
    from: vi.fn((table: string) => {
      const query = { table, filters: [] as [string, string][] }; queries.push(query);
      const chain = { select: vi.fn(() => chain), eq: vi.fn((column, value) => { query.filters.push([column, value]); return chain; }), order: vi.fn(() => chain),
        single: vi.fn(async () => missing || query.filters.some(([, value]) => value !== 'owned-contact') ? { data: null, error: { code: 'PGRST116', message: 'No rows' } } : { data: contact, error: null }),
        limit: vi.fn(async () => ({ data: historyFailed ? null : [{ occurred_at: '2026-10-01', type: 'call', notes: 'Synthetic history' }], error: historyFailed ? { message: 'History unavailable' } : null })),
      }; return chain;
    }),
  };
};
const request = (body: unknown) => new Request('https://example.test/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const body = { messages: [{ role: 'user', content: 'Find Alice' }], tools: [{ name: 'find_contacts', description: 'Read contacts' }], context: '', instructions: '' };
beforeEach(() => { vi.resetAllMocks(); deps.userClient.mockResolvedValue(makeClient()); deps.draftMessage.mockResolvedValue({ message: 'Hi Alice!', source: 'template', basis: ['Written from a template (no AI)'] }); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unmocked provider access forbidden'); })); vi.stubEnv('DEEPSEEK_API_KEY', ''); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const invokeDraft = (id = 'owned-contact') => draft(new Request('https://example.test/api/me/contacts/' + id + '/draft', { method: 'POST' }), { params: Promise.resolve({ id }) });
describe('assistant and draft API boundaries using synthetic dependencies only', () => {
  it('requires authentication before requesting any model or private data', async () => {
    const client = makeClient({ signedIn: false }); deps.userClient.mockResolvedValue(client);
    expect((await assistant(request(body))).status).toBe(401); expect((await invokeDraft()).status).toBe(401);
    expect(client.from).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(deps.draftMessage).not.toHaveBeenCalled();
  });
  it('returns configured-unavailable without contacting a provider', async () => {
    const response = await assistant(request(body)); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'Assistant is not configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not use another contact or its history when the owned lookup is missing', async () => {
    const client = makeClient(); deps.userClient.mockResolvedValue(client);
    expect((await invokeDraft('foreign-contact')).status).toBe(404);
    expect(client.queries).toEqual([{ table: 'contacts', filters: [['id', 'foreign-contact']] }]); expect(deps.draftMessage).not.toHaveBeenCalled();
  });
  it('preserves source/basis provenance and uses only the authenticated contact lookup and bounded history', async () => {
    const client = makeClient(); deps.userClient.mockResolvedValue(client);
    const response = await invokeDraft(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Hi Alice!', source: 'template', basis: ['Written from a template (no AI)'] });
    expect(deps.draftMessage).toHaveBeenCalledWith(contact, [{ occurred_at: '2026-10-01', type: 'call', notes: 'Synthetic history' }]);
    expect(client.queries).toEqual([{ table: 'contacts', filters: [['id', 'owned-contact']] }, { table: 'interactions', filters: [['contact_id', 'owned-contact']] }]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not claim successful history-based drafting when its history lookup failed', async () => {
    deps.userClient.mockResolvedValue(makeClient({ historyFailed: true })); expect((await invokeDraft()).status).toBe(400); expect(deps.draftMessage).not.toHaveBeenCalled();
  });
  it.each([null, {}, { choices: [{ message: {} }] }, { choices: [{ message: { content: { fake: true } } }] }])('returns a truthful provider error for unusable assistant output %#', async (data) => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-key'); vi.stubEnv('DEEPSEEK_BASE_URL', 'https://synthetic.example.test');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    const response = await assistant(request(body)); expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: 'Assistant model returned an invalid response' });
  });
});
