import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), setCookie: vi.fn(), update: vi.fn(), eq: vi.fn(), gt: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../supabase/admin', () => ({ adminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.setCookie }) }));
import { checkpointGoogleSession, consumeGoogleAuthorization, createGoogleSession, saveGoogleSession, type GoogleConfig, type Session, unseal } from './connector';
const config: GoogleConfig = { purpose: 'sheets-export', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', origin: 'https://example.test', redirectUri: 'https://example.test/callback', key: Buffer.alloc(32, 3), scope: 'https://www.googleapis.com/auth/drive.file' };
const owner = '11111111-1111-4111-8111-111111111111';
const session = (): Session<unknown> => ({ id: 'a'.repeat(64), owner, lease: '33333333-3333-4333-8333-333333333333', expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: { exportRun: { state: 'creating' } } });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  const query = { update: mocks.update, eq: mocks.eq, gt: mocks.gt, select: vi.fn(async () => ({ data: [{ id: 'synthetic' }], error: null })) };
  mocks.from.mockReturnValue(query); mocks.update.mockReturnValue(query); mocks.eq.mockReturnValue(query); mocks.gt.mockReturnValue(query);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No provider access'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('shared connector replacement wiring', () => {
  it('always uses atomic owner/purpose RPC, never a preemptive delete or upsert', async () => {
    await createGoogleSession(config, owner, { phase: 'oauth', state: 'synthetic-state' });
    expect(mocks.from).not.toHaveBeenCalled();
    const [name, args] = mocks.rpc.mock.calls[0];
    expect(name).toBe('replace_google_connector_session'); expect(args).toMatchObject({ p_owner: owner, p_purpose: 'sheets-export', p_id: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(unseal(args.p_payload, config, args.p_id, owner)).toEqual({ phase: 'oauth', state: 'synthetic-state' });
    expect(mocks.setCookie).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['connector_busy', 'connector_action_pending'])('preserves cookie when database rejects %s', async message => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message } });
    await expect(createGoogleSession(config, owner, { phase: 'oauth' })).rejects.toMatchObject({ status: 409 });
    expect(mocks.setCookie).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed when replacement migration is missing', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Function not found' } });
    await expect(createGoogleSession(config, owner, { phase: 'oauth' })).rejects.toMatchObject({ status: 503 });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.setCookie).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('sets protection only with an action checkpoint, not OAuth consumption or ordinary saves', async () => {
    const s = session();
    await consumeGoogleAuthorization(config, s);
    expect(mocks.update.mock.calls[0][0]).not.toHaveProperty('protected_action');
    await checkpointGoogleSession(config, s);
    expect(mocks.update.mock.calls[1][0]).toMatchObject({ protected_action: true });
    expect(mocks.eq.mock.calls).toContainEqual(['lease', s.lease]);
    expect(mocks.gt.mock.calls.some(([key]) => key === 'locked_until')).toBe(true);
    await saveGoogleSession(config, s);
    expect(mocks.update.mock.calls[2][0]).not.toHaveProperty('protected_action');
  });
  it('fails before any provider write if protected-action column is unavailable', async () => {
    const query = { update: mocks.update, eq: mocks.eq, gt: mocks.gt, select: vi.fn(async () => ({ data: null, error: { message: 'Column not found' } })) };
    mocks.update.mockReturnValue(query); mocks.eq.mockReturnValue(query); mocks.gt.mockReturnValue(query);
    await expect(checkpointGoogleSession(config, session())).rejects.toMatchObject({ status: 503 }); expect(fetch).not.toHaveBeenCalled();
  });
});
