import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), requireUser: vi.fn(), cookie: vi.fn(), setCookie: vi.fn(), from: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../supabase/admin', () => ({ adminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie, set: mocks.setCookie }) }));
vi.mock('../http', async original => ({ ...await original<typeof import('../http')>(), requireUser: mocks.requireUser }));
vi.mock('./action-store', async original => ({ ...await original<typeof import('./action-store')>(), recentActions: async () => [] }));
import { HttpError } from '../http';
import { googleConnectorSchemaReady, type GooglePurpose } from './connector';
import { callback, start, status } from './contacts-routes';
import { sheetsCallback, sheetsConnect, sheetsStatus } from './sheets-routes';
import { actionRoutes } from './action-routes';
const purposes: GooglePurpose[] = ['contacts', 'sheets-import', 'sheets-export', 'gmail', 'calendar'];
const origin = 'https://localhost:3000';
const request = (purpose: GooglePurpose, start = false) => new Request(`${origin}/api/me/integrations/google/${purpose}`, {
  method: start ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json' },
  ...(start ? { body: JSON.stringify(['gmail', 'calendar'].includes(purpose) ? { operation: 'start' } : {}) } : {}),
});
function routes(purpose: GooglePurpose) {
  if (purpose === 'contacts') return { GET: status, start, callback };
  if (purpose === 'sheets-import' || purpose === 'sheets-export') {
    const mode = purpose === 'sheets-import' ? 'import' : 'export';
    return { GET: sheetsStatus(mode), start: sheetsConnect(mode), callback: sheetsCallback(mode) };
  }
  const actions = actionRoutes(purpose); return { ...actions, start: actions.POST };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUser.mockResolvedValue({ user: { id: '11111111-1111-4111-8111-111111111111' }, supabase: { from: () => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: [], error: null }) }; return chain;
  } } });
  for (const prefix of ['GOOGLE_CONTACTS', 'GOOGLE_SHEETS', 'GOOGLE_GMAIL', 'GOOGLE_CALENDAR']) {
    vi.stubEnv(`${prefix}_CLIENT_ID`, 'synthetic-client'); vi.stubEnv(`${prefix}_CLIENT_SECRET`, 'synthetic-secret'); vi.stubEnv(`${prefix}_ENABLED`, 'true');
  }
  vi.stubEnv('GOOGLE_CONNECTOR_ORIGIN', origin); vi.stubEnv('GOOGLE_CONNECTOR_ENCRYPTION_KEY', Buffer.alloc(32, 42).toString('base64'));
  mocks.rpc.mockImplementation(async (name: string) => ({ data: ['google_connector_purpose_ready', 'google_connector_session_ready', 'hit_rate_limit'].includes(name) ? true : null, error: null }));
  mocks.from.mockImplementation(() => { throw new Error('Unexpected storage mutation/read'); });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external network permitted'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('purpose-aware Google readiness boundary', () => {
  it.each(purposes)('checks the exact %s purpose and starts only after a successful probe', async purpose => {
    expect(await googleConnectorSchemaReady(purpose)).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('google_connector_purpose_ready', { p_purpose: purpose });
    const response = await routes(purpose).start(request(purpose, true));
    expect(response.status).toBe(200); expect(mocks.setCookie).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    const calls = mocks.rpc.mock.calls.map(([name]) => name);
    expect(calls.indexOf('google_connector_purpose_ready')).toBeLessThan(calls.indexOf('replace_google_connector_session'));
  });
  it.each(purposes)('disables %s before consent, cookie/session changes, or provider calls when its schema is partial', async purpose => {
    // The old replacement-only probe succeeds on this exact partial installation.
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'google_connector_purpose_ready' ? false : true, error: null }));
    const response = await routes(purpose).GET(request(purpose));
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body.configured ?? body.enabled).toBe(false);
    const denied = await routes(purpose).start(request(purpose, true));
    expect(denied.status).toBe(503); expect(await denied.text()).not.toMatch(/reconnect|send again|resend automatically/i);
    expect(mocks.rpc.mock.calls.every(([name]) => name === 'google_connector_purpose_ready')).toBe(true);
    expect(mocks.cookie).not.toHaveBeenCalled(); expect(mocks.setCookie).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(purposes)('refuses %s callback exchange if readiness disappears after consent', async purpose => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const response = await routes(purpose).callback(request(purpose));
    expect(response.status).toBe(503);
    expect(mocks.cookie).not.toHaveBeenCalled(); expect(mocks.setCookie).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(purposes)('authenticates %s callbacks before privileged readiness, session state or provider access', async purpose => {
    mocks.requireUser.mockRejectedValue(new HttpError(401, 'Not signed in'));
    const response = await routes(purpose).callback(request(purpose));
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.cookie).not.toHaveBeenCalled(); expect(mocks.setCookie).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(purposes)('bounds stalled %s probes without retrying or opening consent', async purpose => {
    vi.useFakeTimers(); mocks.rpc.mockImplementation(() => new Promise(() => {}));
    const status = routes(purpose).GET(request(purpose));
    await vi.advanceTimersByTimeAsync(1500);
    const response = await status; expect(response.status).toBe(200);
    const body = await response.json(); expect(body.configured ?? body.enabled).toBe(false);
    const start = routes(purpose).start(request(purpose, true));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await start).status).toBe(503); expect(mocks.rpc).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    expect(mocks.cookie).not.toHaveBeenCalled(); expect(mocks.setCookie).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, 'true', 1, {}, false])('does not treat non-true readiness %j as permission to connect', async data => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect(await googleConnectorSchemaReady('gmail')).toBe(false);
  });
  it.each(['', 'unknown', 'toString', '__proto__'])('rejects unknown purpose %s without database access', async purpose => {
    expect(await googleConnectorSchemaReady(purpose as GooglePurpose)).toBe(false); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(['PGRST202', '42501'])('fails closed on RPC %s without asserting that schema is absent', async code => {
    mocks.rpc.mockResolvedValue({ data: true, error: { code, message: 'SECRET storage diagnostic' } });
    expect(await googleConnectorSchemaReady('gmail')).toBe(false);
    const response = await routes('gmail').start(request('gmail', true));
    expect(response.status).toBe(503); expect(await response.text()).toMatch(/could not be verified/i);
    expect(mocks.setCookie).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(purposes)('fails closed with a friendly %s status on thrown readiness/transport failure', async purpose => {
    mocks.rpc.mockRejectedValue(new Error('SECRET transport diagnostic'));
    expect(await googleConnectorSchemaReady(purpose)).toBe(false);
    const response = await routes(purpose).GET(request(purpose));
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('SECRET');
    expect((await routes(purpose).start(request(purpose, true))).status).toBe(503);
    expect(mocks.setCookie).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
