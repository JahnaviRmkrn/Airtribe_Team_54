import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { AUTH_ORIGIN, GUARD_CSP, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, createAuthProxy } from './proxy.mjs';

let upstream, proxy, origin;
let behavior = 'normal';
const seen = [];
const originalCsp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://analytics.example.test";
const originalCookies = ['synthetic-session=alice; Path=/; HttpOnly', 'synthetic-verifier=fixture; Path=/; SameSite=Lax'];
function send(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const req = request({ hostname: target.hostname, port: target.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headersDistinct, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (behavior === 'public-redirect') { res.writeHead(303, { Location: req.headers['x-forwarded-proto'] + '://' + req.headers['x-forwarded-host'] + '/login' }); return res.end(); }
    if (behavior === 'redirect') { res.writeHead(303, { Location: '/login?error=auth' }); return res.end(); }
    if (behavior === 'fixture-redirect') { res.writeHead(303, { Location: AUTH_ORIGIN + '/auth/v1/authorize?provider=google' }); return res.end(); }
    if (behavior === 'offsite-redirect') { res.writeHead(303, { Location: 'https://outside.example.test/auth?code=synthetic-code' }); return res.end(); }
    if (behavior === 'large-response') return res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 65));
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': [originalCsp, "frame-ancestors 'none'"],
      'Set-Cookie': originalCookies, 'X-Upstream-Test': 'retained' });
    res.end(req.method === 'HEAD' ? undefined : 'synthetic page');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  proxy = createAuthProxy({ port: 0, testUpstreamPort: upstream.address().port,
    staticPaths: ['/_next/static/chunks/fixture.js', '/_next/static/chunks/fixture.css'] });
  origin = await proxy.listen();
});
after(async () => {
  await proxy?.close();
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});
beforeEach(() => { behavior = 'normal'; seen.length = 0; });

test('forwards only exact navigation/static targets and retains public Host, Origin and opaque cookies', async () => {
  const response = await send('/login?next=%2Freset-password', { headers: {
    Origin: origin, Cookie: 'synthetic-cookie=fixture', Forwarded: 'host=outside.example.test',
    'X-Forwarded-Host': 'outside.example.test', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': 'untrusted',
    Connection: 'close, x-private-hop', 'X-Private-Hop': 'must-not-forward',
  } });
  assert.equal(response.status, 200);
  assert.equal(seen[0].headers.host, new URL(origin).host);
  assert.equal(seen[0].headers.origin, origin);
  assert.equal(seen[0].headers.cookie, 'synthetic-cookie=fixture');
  for (const name of ['forwarded', 'x-forwarded-for', 'x-private-hop']) assert.equal(seen[0].headers[name], undefined);
  assert.equal(seen[0].headers['x-forwarded-host'], new URL(origin).host);
  assert.equal(seen[0].headers['x-forwarded-proto'], 'http');
  for (const path of ['/', '/reset-password', '/auth/callback?code=synthetic-code&next=%2Flogin', '/_next/static/chunks/fixture.js']) {
    assert.equal((await send(path)).status, 200);
  }
  assert.equal((await send('/_next/static/chunks/fixture.css', { method: 'HEAD' })).body, '');
});

test('preserves every original CSP and Set-Cookie header and appends restrictive browser policy', async () => {
  const response = await send('/login');
  assert.deepEqual(response.headers['content-security-policy'], [originalCsp, "frame-ancestors 'none'", GUARD_CSP]);
  assert.deepEqual(response.headers['set-cookie'], originalCookies);
  assert.match(response.headers['permissions-policy'][0], /camera=\(\)/);
  assert.match(response.headers['permissions-policy'][0], /microphone=\(\)/);
  assert.equal(response.headers['referrer-policy'][0], 'no-referrer');
  assert.equal(response.headers['x-upstream-test'][0], 'retained');
  assert.ok(GUARD_CSP.includes("connect-src 'self' http://127.0.0.1:4318"));
  assert.ok(GUARD_CSP.includes("form-action 'self'"));
  for (const feature of ['frame', 'media', 'worker', 'object']) assert.ok(GUARD_CSP.includes(`${feature}-src 'none'`));
});

test('blocks unmatched routes, assets, hosts, origins, raw traversal and query keys without reaching Next', async () => {
  for (const path of ['/organizer/', '/api/me/contacts', '/auth/signout', '/auth/v1/authorize', '/_vercel/insights/script.js',
    '/_next/image?url=https://outside.example.test', '/_next/static/chunks/missing.js', '/_next/data/private.json']) {
    assert.equal((await send(path)).status, 404);
  }
  assert.equal((await send('/login', { headers: { Host: 'outside.example.test' } })).status, 403);
  assert.equal((await send('/login', { headers: { Origin: 'https://outside.example.test' } })).status, 403);
  assert.equal((await send('/login', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await send('/login?unapproved=1')).status, 400);
  assert.equal((await send('/login?mode=signup&mode=signin')).status, 400);
  assert.equal((await send('/x/../login')).status, 400);
  assert.equal((await send('http://outside.example.test/login')).status, 400);
  assert.equal(seen.length, 0);
});

test('allows only owner-update JSON POST and bounds methods and body bytes', async () => {
  const body = JSON.stringify({ password: 'synthetic-password' });
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Contact-Owner': 'synthetic-owner' };
  const response = await send('/api/me/password', { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  assert.equal(seen[0].body, body);
  assert.equal(seen[0].headers['x-contact-owner'], 'synthetic-owner');
  seen.length = 0;
  assert.equal((await send('/api/me/password', { method: 'GET' })).status, 405);
  assert.equal((await send('/login', { method: 'POST', headers, body })).status, 405);
  assert.equal((await send('/api/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await send('/api/me/password', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await send('/api/me/password', { method: 'POST', headers: { ...headers, 'Content-Length': MAX_REQUEST_BYTES + 1 }, body: 'x'.repeat(MAX_REQUEST_BYTES + 1) })).status, 413);
  assert.equal((await send('/login', { headers: { 'Content-Length': '1' }, body: 'x' })).status, 400);
  assert.equal(seen.length, 0);
});

test('passes allowed redirects without following them', async () => {
  behavior = 'redirect';
  const local = await send('/auth/callback?code=synthetic-code');
  assert.equal(local.status, 303);
  assert.deepEqual(local.headers.location, ['/login?error=auth']);
  assert.equal(seen.length, 1);
  behavior = 'fixture-redirect';
  const auth = await send('/auth/callback');
  assert.equal(auth.status, 303);
  assert.equal(auth.headers.location[0], AUTH_ORIGIN + '/auth/v1/authorize?provider=google');
  assert.equal(seen.length, 2);
  behavior = 'public-redirect';
  const callback = await send('/auth/callback', { headers: { 'X-Forwarded-Host': 'outside.example.test', 'X-Forwarded-Proto': 'https' } });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location[0], origin + '/login'); // Generated upstream, never rewritten.
  assert.equal(seen.length, 3);
});

test('blocks external Location before Chrome sees it and marks acceptance as failed', async () => {
  behavior = 'offsite-redirect';
  const before = proxy.snapshot().blockedRedirects;
  const response = await send('/auth/callback?code=synthetic-code');
  assert.equal(response.status, 502);
  assert.equal(response.headers.location, undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['x-auth-fixture-error'][0], 'AUTH_PROXY_BLOCKED_REDIRECT');
  assert.deepEqual(JSON.parse(response.body), { error: 'AUTH_PROXY_BLOCKED_REDIRECT', acceptance_failed: true, blocked_redirects: before + 1 });
  assert.equal(response.body.includes('outside.example.test'), false);
  assert.equal(response.body.includes('synthetic-code'), false);
  assert.equal(proxy.snapshot().acceptance_failed, true);
  assert.equal(seen.length, 1);
});

test('bounds upstream response size instead of sending an unbounded page', async () => {
  behavior = 'large-response';
  const response = await send('/login');
  assert.equal(response.status, 502);
  assert.match(response.body, /AUTH_PROXY_RESPONSE_TOO_LARGE/);
});

test('never permits arbitrary public ports or upstream overrides in browser-serving mode', () => {
  assert.throws(() => createAuthProxy({ port: 9999 }), /fixed public port/);
  assert.throws(() => createAuthProxy({ testUpstreamPort: 9999 }), /ephemeral smoke test/);
  assert.throws(() => createAuthProxy({ port: 0, testUpstreamPort: -1 }), /ephemeral smoke test/);
  assert.throws(() => createAuthProxy({ staticPaths: ['/private-file'] }), /asset allowlist/);
});
