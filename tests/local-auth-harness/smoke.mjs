import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { APP_ORIGIN, FIXTURE_KEY, PASSWORD, NEW_PASSWORD, createAuthFixture } from './fixture.mjs';

const fixture = createAuthFixture({ port: 0 });
let origin;
before(async () => { origin = await fixture.listen(); });
after(async () => { await fixture.close(); });
beforeEach(async () => {
  const result = await fetch(origin + '/__fixture/reset', { method: 'POST', headers: { Origin: origin }, redirect: 'manual' });
  assert.equal(result.status, 303);
});
const authHeaders = { apikey: FIXTURE_KEY, 'Content-Type': 'application/json', Origin: APP_ORIGIN };
const post = (path, data, headers = {}) => fetch(origin + path, { method: 'POST', headers: { ...authHeaders, ...headers }, body: JSON.stringify(data), redirect: 'manual' });
const callback = APP_ORIGIN + '/auth/callback?next=%2Freset-password';
const verifier = 'v'.repeat(64);
const pkce = { code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 's256' };
const user = 'alice@auth-fixture.test';

function sdk() {
  const jar = new Map();
  const cookies = {
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (values) => values.forEach(({ name, value }) => value ? jar.set(name, value) : jar.delete(name)),
  };
  return { jar, cookies, client: createBrowserClient(origin, FIXTURE_KEY, {
    cookies, isSingleton: false, auth: { autoRefreshToken: false, detectSessionInUrl: false },
  }) };
}

test('fails closed for unknown origins, API keys, methods, paths and preflight headers', async () => {
  assert.equal((await fetch(origin + '/auth/v1/settings', { headers: { apikey: FIXTURE_KEY, Origin: 'https://outside.example' } })).status, 403);
  assert.equal((await fetch(origin + '/auth/v1/settings', { headers: { apikey: 'not-the-fixture-key' } })).status, 401);
  assert.equal((await post('/auth/v1/settings', {})).status, 405);
  for (const path of ['/rest/v1/contacts', '/auth/v1/admin/users', '/auth/v1/unknown', '/storage/v1']) {
    assert.equal((await fetch(origin + path, { headers: authHeaders })).status, 404);
  }
  const preflight = (header) => fetch(origin + '/auth/v1/token', { method: 'OPTIONS', headers: {
    Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': header,
  } });
  assert.equal((await preflight('apikey,authorization,content-type,x-client-info,x-supabase-api-version')).status, 204);
  assert.equal((await preflight('x-unapproved-header')).status, 403);
  assert.equal((await fetch(origin + '/__fixture/reset', { method: 'POST', redirect: 'manual' })).status, 403);
});

test('rejects external callbacks and non-synthetic identities without creating flows', async () => {
  for (const redirect of ['https://outside.example/auth/callback', APP_ORIGIN + '/not-auth', APP_ORIGIN + '/auth/callback#fragment']) {
    assert.equal((await post('/auth/v1/recover?redirect_to=' + encodeURIComponent(redirect), { email: user, ...pkce })).status, 400);
  }
  assert.equal((await post('/auth/v1/recover?redirect_to=' + encodeURIComponent(callback), { email: 'not-a-fixture@example.test', ...pkce })).status, 400);
  assert.deepEqual(fixture.snapshot().flows, []);
});

test('supports synthetic password login, current-user lookup, password update and logout only', async () => {
  assert.equal((await post('/auth/v1/token?grant_type=password', { email: user, password: 'wrong-fixture-password' })).status, 400);
  const response = await post('/auth/v1/token?grant_type=password', { email: user, password: PASSWORD });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.match(session.access_token, /^fixture-access-/);
  assert.equal(session.access_token.includes('.'), false); // No JWT claims.
  const headers = { ...authHeaders, authorization: 'Bearer ' + session.access_token };
  assert.equal((await (await fetch(origin + '/auth/v1/user', { headers })).json()).email, user);
  const update = await fetch(origin + '/auth/v1/user', { method: 'PUT', headers, body: JSON.stringify({ password: NEW_PASSWORD }) });
  assert.equal(update.status, 200);
  assert.equal((await post('/auth/v1/token?grant_type=password', { email: user, password: PASSWORD })).status, 400);
  assert.equal((await post('/auth/v1/token?grant_type=password', { email: user, password: NEW_PASSWORD })).status, 200);
  assert.equal((await post('/auth/v1/logout', {}, headers)).status, 200);
  assert.equal((await fetch(origin + '/auth/v1/user', { headers })).status, 401);
  assert.equal((await post('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })).status, 400);
});

test('uses real Supabase SDK cookie adapters for PKCE recovery exchange and current user', async () => {
  const { client, cookies, jar } = sdk();
  const requested = await client.auth.resetPasswordForEmail(user, { redirectTo: callback });
  assert.equal(requested.error, null);
  assert.ok(jar.size > 0, 'SDK wrote a PKCE verifier cookie');
  const flow = fixture.snapshot().flows[0];
  assert.equal(flow.kind, 'recovery');
  const server = createServerClient(origin, FIXTURE_KEY, { cookies });
  // Match the shipped callback: it passes code only. Do not fabricate cookies.
  const exchanged = await server.auth.exchangeCodeForSession(new URL(flow.callback).searchParams.get('code'));
  assert.equal(exchanged.error, null);
  assert.equal(exchanged.data.user.email, user);
  assert.ok([...jar.keys()].some((key) => key.startsWith('sb-127-auth-token')));
  const nextRequest = createServerClient(origin, FIXTURE_KEY, { cookies });
  assert.equal((await nextRequest.auth.getUser()).data.user.email, user);
  const replay = await post('/auth/v1/token?grant_type=pkce', { auth_code: flow.code, code_verifier: verifier });
  assert.equal(replay.status, 400);
});

test('keeps signup confirmation and magic-link creation distinct with the actual SDK', async () => {
  const { client } = sdk();
  const email = 'new-user@auth-fixture.test';
  const login = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: callback } });
  assert.notEqual(login.error, null);
  assert.equal(fixture.snapshot().flows.length, 0);
  const signup = await client.auth.signUp({ email, password: PASSWORD, options: { emailRedirectTo: callback } });
  assert.equal(signup.error, null);
  assert.equal(signup.data.session, null);
  assert.equal(fixture.snapshot().flows[0].kind, 'signup');
  const magic = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: callback } });
  assert.equal(magic.error, null);
  assert.equal(fixture.snapshot().flows[1].kind, 'magic-link');
});

test('rejects expired links, wrong verifiers and missing codes without issuing sessions', async () => {
  assert.equal((await post('/auth/v1/recover?redirect_to=' + encodeURIComponent(callback), { email: user, ...pkce })).status, 200);
  const flow = fixture.snapshot().flows[0];
  assert.equal((await post('/auth/v1/token?grant_type=pkce', { auth_code: flow.code, code_verifier: 'x'.repeat(64) })).status, 400);
  assert.equal((await post('/auth/v1/token?grant_type=pkce', { code_verifier: verifier })).status, 400);
  await fetch(origin + '/__fixture/expire', { method: 'POST', headers: { Origin: origin }, redirect: 'manual' });
  assert.equal((await post('/auth/v1/token?grant_type=pkce', { auth_code: flow.code, code_verifier: verifier })).status, 400);
  assert.equal(fixture.snapshot().flows[0].state, 'expired');
  assert.equal(fixture.snapshot().requests.includes('pkce-exchanged:recovery'), false);
});

test('OAuth navigation remains loopback-only and always denies provider authentication', async () => {
  const { client } = sdk();
  const requested = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: callback, skipBrowserRedirect: true } });
  assert.equal(requested.error, null);
  assert.equal(new URL(requested.data.url).origin, origin);
  const result = await fetch(requested.data.url, { redirect: 'manual' });
  assert.equal(result.status, 303);
  const target = new URL(result.headers.get('location'));
  assert.equal(target.origin, APP_ORIGIN);
  assert.equal(target.searchParams.get('error'), 'access_denied');
  assert.deepEqual(fixture.snapshot().flows, []);
});
