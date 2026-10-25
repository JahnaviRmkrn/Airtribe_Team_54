import { beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ userClient: vi.fn(), mintLiveToken: vi.fn(), limitUser: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ userClient: deps.userClient }));
vi.mock('@/lib/secrets', () => ({ loadVaultSecrets: () => { throw new Error('Vault forbidden'); } }));
vi.mock('@/lib/live-token', () => ({ mintLiveToken: deps.mintLiveToken }));
vi.mock('@/lib/ratelimit', () => ({ limitUser: deps.limitUser }));
import { GET as voiceToken } from '../app/api/voice/live-token/route';
import { POST as assistant } from '../app/api/assistant/route';
import { requireUser } from '../lib/http';
import { POST as createMeetup } from '../app/api/me/meetups/route';
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const request = (owner) => new Request('https://example.test/api/me/meetups', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'X-Contact-Owner': owner } : {}) }, body: JSON.stringify({ title: 'Synthetic brunch' }),
});
let client;
beforeEach(() => {
  vi.clearAllMocks();
  client = { auth: { getUser: vi.fn(async () => ({ data: { user: { id: alice } }, error: null })) }, from: vi.fn(() => {
    const chain = { insert: vi.fn(() => chain), select: vi.fn(() => chain), single: vi.fn(async () => ({ data: { title: 'Synthetic brunch', room_token: 'synthetic-token' }, error: null })) }; return chain;
  }) };
  deps.userClient.mockResolvedValue(client);
});
describe('optional expected organizer identity for assistant operations', () => {
  it('retains ordinary unbound API clients and accepts the same captured owner', async () => {
    for (const owner of [undefined, alice]) expect((await requireUser(request(owner))).user.id).toBe(alice);
  });
  it('rejects another-tab identity changes instead of authorizing the new account', async () => {
    await expect(requireUser(request(bob))).rejects.toMatchObject({ status: 409 });
    expect(client.from).not.toHaveBeenCalled();
  });
  it('rejects a changed account before creating voice credentials or calling the model', async () => {
    expect((await voiceToken(request(bob))).status).toBe(409);
    expect((await assistant(request(bob))).status).toBe(409);
    expect(deps.mintLiveToken).not.toHaveBeenCalled(); expect(deps.limitUser).not.toHaveBeenCalled(); expect(client.from).not.toHaveBeenCalled();
  });
  it('returns 401 for a signed-out session even when the request carries an old owner', async () => {
    client.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireUser(request(alice))).rejects.toMatchObject({ status: 401 });
  });
  it.each([undefined, alice])('preserves authorized meetup creation with owner header %s', async (owner) => {
    const res = await createMeetup(request(owner)); expect(res.status).toBe(201);
    expect(client.from).toHaveBeenCalledWith('meetups');
  });
  it('rejects stale voice meetup creation before any DB insertion', async () => {
    const res = await createMeetup(request(bob)); expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: 'Your signed-in account changed. Reload before saving.' });
    expect(client.from).not.toHaveBeenCalled();
  });
});
