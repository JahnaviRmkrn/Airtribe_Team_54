import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { APP_ORIGIN, FIXTURE_KEY, PASSWORD, createAuthFixture } from './local-auth-harness/fixture.mjs';

const { userClient } = vi.hoisted(() => ({ userClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ userClient }));
import { GET } from '../app/auth/callback/route';

// Real app callback + real installed Supabase SDK + synthetic-only loopback Auth.
// No Next process, browser, real email, credentials, provider, or data APIs.
const fixture = createAuthFixture({ port: 0 });
const alice = 'alice@auth-fixture.test';
const bob = 'bob@auth-fixture.test';
const callback = APP_ORIGIN + '/auth/callback?next=%2Flogin';
let origin;
let current;

function browser(jar = new Map()) {
  const cookies = {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (values) => values.forEach(({ name, value }) => value ? jar.set(name, value) : jar.delete(name)),
  };
  const client = createBrowserClient(origin, FIXTURE_KEY, {
    cookies, isSingleton: false, auth: { autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { jar, cookies, client };
}
const server = () => createServerClient(origin, FIXTURE_KEY, { cookies: current.cookies });
const signedInEmail = async () => (await server().auth.getUser()).data.user?.email ?? null;
const exchange = async (flow) => (await GET(new Request(flow.callback))).headers.get('location');
async function requestLink(email = alice, shouldCreateUser = false) {
  const requested = await current.client.auth.signInWithOtp({ email, options: {
    shouldCreateUser, emailRedirectTo: callback,
  } });
  expect(requested.error).toBeNull();
  expect(requested.data.session).toBeNull();
  return fixture.snapshot().flows.at(-1);
}

beforeAll(async () => { origin = await fixture.listen(); });
afterAll(async () => { await fixture.close(); });
beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', APP_ORIGIN);
  expect((await fetch(origin + '/__fixture/reset', { method: 'POST', headers: { Origin: origin }, redirect: 'manual' })).status).toBe(303);
  current = browser();
  userClient.mockReset().mockImplementation(async () => server());
});
afterEach(() => vi.unstubAllEnvs());

describe('magic-link callback and actual SDK cookies', () => {
  it('creates no session until a requested link is exchanged and the next server request reads its cookie', async () => {
    const flow = await requestLink();
    expect(flow.kind).toBe('magic-link');
    expect(await signedInEmail()).toBeNull();
    expect(await exchange(flow)).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(alice);
    expect(fixture.snapshot().requests).toEqual(['magic-link:false', 'pkce-exchanged:magic-link']);
    expect(fixture.snapshot().flows[0].state).toBe('used');
  });

  it('rejects one-time replay even if the original synthetic verifier cookies are restored', async () => {
    const flow = await requestLink();
    const originalCookies = new Map(current.jar);
    expect(await exchange(flow)).toBe(APP_ORIGIN + '/login');
    current = browser(originalCookies);
    expect(await exchange(flow)).toBe(APP_ORIGIN + '/login?error=auth');
    expect(await signedInEmail()).toBeNull();
    expect(fixture.snapshot().requests.filter((kind) => kind.startsWith('pkce-exchanged:'))).toHaveLength(1);
  });

  it('rejects an expired link, then accepts a newly requested link', async () => {
    const expired = await requestLink();
    expect((await fetch(origin + '/__fixture/expire', { method: 'POST', headers: { Origin: origin }, redirect: 'manual' })).status).toBe(303);
    expect(await exchange(expired)).toBe(APP_ORIGIN + '/login?error=auth');
    expect(await signedInEmail()).toBeNull();
    expect(fixture.snapshot().flows[0].state).toBe('expired');
    const retry = await requestLink();
    expect(await exchange(retry)).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(alice);
  });

  it('does not exchange or sign in when the callback is abandoned without a code', async () => {
    const pending = await requestLink();
    const result = await GET(new Request(callback));
    expect(result.headers.get('location')).toBe(APP_ORIGIN + '/login?error=auth');
    expect(userClient).not.toHaveBeenCalled();
    expect(await signedInEmail()).toBeNull();
    expect(fixture.snapshot().flows[0].state).toBe('pending');
    // Leaving the page is not server-side link revocation.
    expect(await exchange(pending)).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(alice);
  });

  it('rejects a link in another cookie jar without consuming the original browser flow', async () => {
    const flow = await requestLink();
    const requestingBrowser = current;
    current = browser();
    expect(await exchange(flow)).toBe(APP_ORIGIN + '/login?error=auth');
    expect(await signedInEmail()).toBeNull();
    expect(fixture.snapshot().flows[0].state).toBe('pending');
    current = requestingBrowser;
    expect(await exchange(flow)).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(alice);
  });

  it('uses the latest requested link with the shipped legacy verifier configuration', async () => {
    await requestLink(alice);
    const latest = await requestLink(bob);
    expect(await exchange(latest)).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(bob);
    expect(fixture.snapshot().flows.map((flow) => flow.state)).toEqual(['pending', 'used']);
  });

  it('rejects an older link without switching accounts or invalidating the latest link', async () => {
    const older = await requestLink(alice);
    const latest = await requestLink(bob);
    expect(await exchange(older)).toBe(APP_ORIGIN + '/login?error=auth');
    expect(await signedInEmail()).toBeNull();
    expect(fixture.snapshot().requests.some((kind) => kind.startsWith('pkce-exchanged:'))).toBe(false);
    // Real SSR cookie writes are flushed on successful auth events; the failed
    // exchange must not be modeled as blanket deletion of every browser cookie.
    expect(await exchange(latest)).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(bob);
    expect(await exchange(older)).toBe(APP_ORIGIN + '/login?error=auth');
    expect(await signedInEmail()).toBe(bob);
  });

  it('keeps the current account while a different account link is pending or expired, then switches only on successful exchange', async () => {
    const login = await current.client.auth.signInWithPassword({ email: alice, password: PASSWORD });
    expect(login.error).toBeNull();
    const expiredBob = await requestLink(bob);
    expect(await signedInEmail()).toBe(alice);
    await fetch(origin + '/__fixture/expire', { method: 'POST', headers: { Origin: origin }, redirect: 'manual' });
    expect(await exchange(expiredBob)).toBe(APP_ORIGIN + '/login?error=auth');
    expect(await signedInEmail()).toBe(alice);
    expect(await exchange(await requestLink(bob))).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(bob);
  });

  it('does not create a new user in login mode but completes explicit magic-link signup', async () => {
    const email = 'new-user@auth-fixture.test';
    const denied = await current.client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: callback } });
    expect(denied.error).not.toBeNull();
    expect(fixture.snapshot().flows).toEqual([]);
    const confirmation = await requestLink(email, true);
    expect(await signedInEmail()).toBeNull();
    expect(await exchange(confirmation)).toBe(APP_ORIGIN + '/login');
    expect(await signedInEmail()).toBe(email);
    expect(fixture.snapshot().requests).toEqual(['magic-link:true', 'pkce-exchanged:magic-link']);
  });
});
