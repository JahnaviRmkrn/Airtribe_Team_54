import { createBrowserClient } from '@supabase/ssr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ jar: new Map<string, string>(), writes: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({
  getAll: () => [...state.jar].map(([name, value]) => ({ name, value })),
  set: state.writes,
}) }));

import { POST } from '../app/api/me/password/route';
import { userClient } from '../lib/supabase/server';

const origin = 'https://app.example.test';
const alice = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.test' };
const bob = { id: '22222222-2222-4222-8222-222222222222', email: 'bob@example.test' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const session = (user = alice, expired = false) => ({ user, access_token: 'synthetic-access-' + user.id,
  refresh_token: 'synthetic-refresh-' + user.id, token_type: 'bearer', expires_in: expired ? -10 : 3600,
  expires_at: Math.floor(Date.now() / 1000) + (expired ? -10 : 3600) });
let transport: ReturnType<typeof vi.fn>;
let getGate: Promise<void> | undefined;
let updateGate: Promise<void> | undefined;
let onGet: (() => void) | undefined;
let onUpdate: (() => void) | undefined;
let updateError: 'network' | 'provider' | 'rejected' | undefined;
const updates: string[] = [];
const request = (headers: Record<string, string> = {}, url = origin + '/api/me/password') => new Request(url, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Contact-Owner': alice.id, ...headers },
  body: JSON.stringify({ password: 'synthetic-new-password' }),
});

async function seed(user = alice, expired = false) {
  const jar = new Map<string, string>();
  const client = createBrowserClient('https://auth.example.test', 'synthetic-key', {
    isSingleton: false, auth: { autoRefreshToken: false, detectSessionInUrl: false },
    cookies: { getAll: () => [], setAll: (values) => values.forEach(({ name, value }) => jar.set(name, value)) },
    global: { fetch: async () => response(session(user, expired)) },
  });
  const result = await client.auth.signInWithPassword({ email: user.email, password: 'synthetic-password' });
  expect(result.error).toBeNull();
  return jar;
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-key');
  state.jar = await seed();
  state.writes.mockClear(); updates.length = 0; getGate = undefined; updateGate = undefined; updateError = undefined; onGet = undefined; onUpdate = undefined;
  transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const identity = headers.get('authorization')?.includes(bob.id) ? bob : alice;
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') return response(session());
    if (url.pathname !== '/auth/v1/user') throw new Error('Unexpected synthetic transport request');
    if (init?.method === 'PUT') {
      updates.push(identity.id);
      onUpdate?.();
      await updateGate;
      if (updateError === 'network') throw new Error('synthetic-private-password-cookie-do-not-log');
      if (updateError === 'provider') return response({ message: 'synthetic-private-password-cookie-do-not-log' }, 503);
      if (updateError === 'rejected') return response({ message: 'synthetic-private-password-cookie-do-not-log' }, 422);
    } else { onGet?.(); await getGate; }
    return response(identity);
  });
  vi.stubGlobal('fetch', transport);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('request-bound password updates with the actual Supabase SDK', () => {
  it('updates the expected request owner without response cookie writes', async () => {
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ updated: true });
    expect(updates).toEqual([alice.id]);
    expect(state.writes).not.toHaveBeenCalled();
    expect(result.headers.has('set-cookie')).toBe(false);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  });

  it('requires sign-in when the request has no session, without a provider call', async () => {
    state.jar.clear();
    const result = await POST(request());
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ code: 'password_session_expired' });
    expect(transport).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });

  it.each(['missing', 'different'])('rejects a %s expected owner before updating', async (kind) => {
    const result = await POST(request({ 'X-Contact-Owner': kind === 'missing' ? '' : bob.id }));
    expect(result.status).toBe(409);
    expect(updates).toEqual([]);
    expect(state.writes).not.toHaveBeenCalled();
  });

  it('binds a late update to Alice even if the browser cookies switch to Bob during verification', async () => {
    const bobCookies = await seed(bob);
    let resolve!: () => void;
    getGate = new Promise((done) => { resolve = done; });
    const started = new Promise<void>((done) => { onGet = done; });
    const pending = POST(request());
    await started;
    expect(transport).toHaveBeenCalledOnce();
    state.jar = bobCookies;
    resolve();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(updates).toEqual([alice.id]);
    expect(state.jar).toEqual(bobCookies);
    expect(state.writes).not.toHaveBeenCalled();
  });

  it('does not overwrite Bob cookies when an Alice provider response arrives later', async () => {
    const bobCookies = await seed(bob);
    let resolve!: () => void;
    updateGate = new Promise((done) => { resolve = done; });
    const started = new Promise<void>((done) => { onUpdate = done; });
    const pending = POST(request());
    await started;
    expect(updates).toEqual([alice.id]);
    state.jar = bobCookies;
    resolve();
    expect((await pending).status).toBe(200);
    expect(state.jar).toEqual(bobCookies);
    expect(state.writes).not.toHaveBeenCalled();
  });

  it('denies expired-session refresh locally without a transport request, retry, update or cookie write', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.jar = await seed(alice, true);
    const result = await POST(request());
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ code: 'password_session_expired', error: expect.stringContaining('Sign in again') });
    expect(transport).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(state.writes).not.toHaveBeenCalled();
    // This SDK logs local refresh denial. Only our fixed message reaches it,
    // never an upstream request, password, cookie, or refresh token.
    for (const [error] of log.mock.calls) expect(error.message).toBe('Session expired. Sign in again.');
  });

  it('also blocks refresh if the session expires between verification and the update', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    onGet = () => vi.setSystemTime(start + 3_700_000);
    const result = await POST(request());
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ code: 'password_session_expired' });
    expect(transport).toHaveBeenCalledOnce(); // Current-user validation only.
    expect(updates).toEqual([]);
    expect(state.writes).not.toHaveBeenCalled();
  });

  it('retains refresh transport and cookie persistence for ordinary helper callers', async () => {
    state.jar = await seed(alice, true);
    const client = await userClient();
    expect((await client.auth.getUser()).data.user?.id).toBe(alice.id);
    expect(transport.mock.calls.some(([url]) => String(url).includes('grant_type=refresh_token'))).toBe(true);
    expect(state.writes).toHaveBeenCalled();
  });

  it.each(['network', 'provider', 'rejected'] as const)('sanitizes %s failures without logging or automatic resubmission', async (kind) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    updateError = kind;
    const result = await POST(request());
    expect(result.status).toBe(kind === 'rejected' ? 400 : 502);
    expect(await result.text()).not.toContain('synthetic-private-password-cookie-do-not-log');
    expect(updates).toEqual([alice.id]);
    expect(log).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });

  it('rejects mixed bearer credentials and cross-origin requests before any auth transport', async () => {
    expect((await POST(request({ Authorization: 'Bearer synthetic-other-account' }))).status).toBe(400);
    expect((await POST(request({ Origin: 'https://outside.example' }))).status).toBe(403);
    expect((await POST(request({ Origin: '' }))).status).toBe(403);
    expect((await POST(request({ 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });

  it('supports an internal proxy request URL only through the configured canonical origin or standard Host', async () => {
    expect((await POST(request({ Host: 'app.example.test' }, 'http://localhost:3000/api/me/password'))).status).toBe(200);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect((await POST(request({ Host: 'APP.EXAMPLE.TEST:443' }, 'http://localhost:3000/api/me/password'))).status).toBe(200);
    expect((await POST(request({ Host: 'app.example.test' }, 'http://localhost:3000/api/me/password'))).status).toBe(200);
    expect((await POST(request({ Host: 'localhost:3000', 'X-Forwarded-Host': 'app.example.test', 'X-Forwarded-Proto': 'https' }, 'http://localhost:3000/api/me/password'))).status).toBe(403);
  });

  it('keeps a loopback dev origin exact and fails closed on invalid Host/configuration', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    const local = 'http://127.0.0.1:4320';
    expect((await POST(request({ Origin: local, Host: '127.0.0.1:4320' }, local + '/api/me/password'))).status).toBe(200);
    expect((await POST(request({ Host: 'app.example.test/path' }))).status).toBe(503);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'javascript:bad');
    expect((await POST(request())).status).toBe(503);
  });
});
