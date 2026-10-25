import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from '../helpers/privacy-db.mjs';
import { pgliteClient } from '../helpers/pglite-client.mjs';

const deps = vi.hoisted(() => {
  const state = {
    admin: null, context: null, userClient: null, origin: null, externalFetchAttempts: 0,
    secretAccessAttempts: 0, providerAttempts: 0, errorCount: 0, migrationReads: [],
  };
  // Installed before any application imports, including their top-level code.
  vi.stubGlobal('fetch', () => { state.externalFetchAttempts++; throw new Error('External fetch forbidden in local route harness'); });
  return state;
});
vi.mock('node:http', async (importOriginal) => {
  const http = await importOriginal();
  const guard = (name) => (target, ...args) => {
    if (!(target instanceof URL) || target.origin !== deps.origin || target.hostname !== '127.0.0.1') {
      deps.externalFetchAttempts++;
      throw new Error('Only harness loopback HTTP is allowed');
    }
    return http[name](target, ...args);
  };
  return { ...http, request: guard('request'), get: guard('get') };
});
vi.mock('node:https', async (importOriginal) => {
  const https = await importOriginal();
  const deny = () => { deps.externalFetchAttempts++; throw new Error('External HTTPS forbidden in local route harness'); };
  return { ...https, request: deny, get: deny };
});
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => deps.context().cookies }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.admin }));
vi.mock('@/lib/supabase/server', () => ({ userClient: () => deps.userClient() }));
// This is not a rate-limiter test; no networked RPC is permitted.
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn(), rateLimit: vi.fn(), LIMITS: { view: 100, joinHourly: 100 } }));
vi.mock('@/lib/live-token', () => ({ mintLiveToken: () => { deps.providerAttempts++; throw new Error('Live tokens disabled in local harness'); } }));
vi.mock('@/lib/secrets', () => { deps.secretAccessAttempts++; throw new Error('Secret access disabled in local harness'); });
// Do not import the provider SDK or its credentials accessor, even for a pure helper.
vi.mock('@/lib/pinelabs', () => ({
  amountPaise: (value) => Number.isInteger(value) && value > 0 && Number.isSafeInteger(value * 100) ? value * 100 : null,
  isConfigured: () => false,
  createOrder: () => { deps.providerAttempts++; throw new Error('Payments disabled in local harness'); },
  getOrderStatus: () => { deps.providerAttempts++; throw new Error('Payments disabled in local harness'); },
  cancelOrder: () => { deps.providerAttempts++; throw new Error('Payments disabled in local harness'); },
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, readFileSync: (path, ...args) => {
    const value = String(path);
    if (/(^|[/\\])\.env(?:[./\\]|$)/.test(value) || /vault|app_secrets/i.test(value)) {
      deps.secretAccessAttempts++;
      throw new Error('Environment/Vault file access forbidden in local harness');
    }
    if (value.endsWith('.sql')) deps.migrationReads.push(value.split('/').pop());
    return fs.readFileSync(path, ...args);
  } };
});

import { GET as viewRoom } from '../../app/api/rooms/[token]/route';
import { POST as joinRoom } from '../../app/api/rooms/[token]/join/route';
import { GET as getGuest, PATCH as editGuest } from '../../app/api/rooms/[token]/me/route';
import { POST as vote, DELETE as unvote } from '../../app/api/rooms/[token]/vote/route';
import { POST as confirmRoom } from '../../app/api/rooms/[token]/confirm/route';
import { POST as closeRoom } from '../../app/api/rooms/[token]/close/route';

const MODE = process.env.TEAM54_LOCAL_HARNESS_MODE;
const PORT = MODE === 'serve' ? 4318 : 0;
const LIFETIME_MS = 30 * 60 * 1000;
const tokens = { alice: 'local_harness_room_alice_0001', bob: 'local_harness_room_bob_000001' };
const root = new URL('../../', import.meta.url);
const storage = new AsyncLocalStorage();
const assets = new Map([
  ['/room/index.html', ['public/room/index.html', 'text/html; charset=utf-8']],
  ['/room/room.css', ['public/room/room.css', 'text/css; charset=utf-8']],
  ['/room/room.js', ['public/room/room.js', 'text/javascript; charset=utf-8']],
  ['/room/meet.js', ['public/room/meet.js', 'text/javascript; charset=utf-8']],
  ['/room/room-voice.js', ['public/room/room-voice.js', 'text/javascript; charset=utf-8']],
  ['/organizer/live.js', ['public/organizer/live.js', 'text/javascript; charset=utf-8']],
  ['/product-analytics.js', ['public/product-analytics.js', 'text/javascript; charset=utf-8']],
  ['/muop-mark.svg', ['public/muop-mark.svg', 'image/svg+xml']],
  ['/__harness/', ['tests/local-room-harness/controls.html', 'text/html; charset=utf-8']],
  ['/__harness/controls.js', ['tests/local-room-harness/controls.js', 'text/javascript; charset=utf-8']],
]);
const securityHeaders = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'x-dns-prefetch-control': 'off',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};
const handlers = new Map([
  ['GET ', viewRoom], ['POST /join', joinRoom], ['GET /me', getGuest],
  ['PATCH /me', editGuest], ['POST /vote', vote], ['DELETE /vote', unvote],
  ['POST /confirm', confirmRoom], ['POST /close', closeRoom],
]);
let db, server, origin, tenants, timeout, stopResolve, stopPromise, queue = Promise.resolve();
let stopped = false, servedRequests = 0, resets = 0;
const cookieHeader = (name, value, options = {}) => [
  `${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
  options.expires ? `Expires=${new Date(options.expires).toUTCString()}` : '',
  options.maxAge === 0 ? 'Max-Age=0' : '',
  options.secure ? 'Secure' : '',
].filter(Boolean).join('; ');
function requestContext(req) {
  const values = new Map();
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    try { values.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))); } catch { /* Ignore malformed cookie values. */ }
  }
  const role = ['owner', 'other'].includes(values.get('__harness_role')) ? values.get('__harness_role') : 'observer';
  const writes = [];
  return { role, values, writes, cookies: {
    get: (name) => values.has(name) ? { value: values.get(name) } : undefined,
    set: (name, value, options) => { values.set(name, value); writes.push(cookieHeader(name, value, options)); },
  } };
}
function clearBrowserGuests(context) {
  for (const name of context.values.keys()) if (/^guest_[0-9a-f-]+$/.test(name)) {
    context.cookies.set(name, '', { maxAge: 0 });
  }
}
async function resetFixture() {
  tenants = await seedPrivateData(db);
  for (const name of ['alice', 'bob']) {
    await asRole(db, 'service_role', null, (tx) => tx.query('update meetups set room_token = $1 where id = $2', [tokens[name], tenants[name].meetup.id]));
  }
  resets++;
}
async function status(context) {
  const counts = await asRole(db, 'service_role', null, async (tx) => (await tx.query(`select
    (select count(*)::int from meetup_attendees) as guests,
    (select count(*)::int from venue_votes) as votes,
    (select count(*)::int from meetups where status = 'closed') as closed_rooms,
    (select count(*)::int from meetups where final_venue_id is not null) as confirmed_rooms`)).rows[0]);
  return { mode: 'local-real-handler-fixture', role: context.role, ...counts, served_requests: servedRequests, resets,
    external_fetch_attempts: deps.externalFetchAttempts, provider_attempts: deps.providerAttempts,
    secret_access_attempts: deps.secretAccessAttempts, internal_errors: deps.errorCount,
    live_auth: false, live_postgrest: false, payments: 'disabled', voice: 'disabled' };
}
function respond(res, code, body, context, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { ...securityHeaders, 'content-type': type, ...(context?.writes.length ? { 'set-cookie': context.writes } : {}) });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function bodyBytes(req) {
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 16_384) throw new Error('Body too large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function dispatch(req, res) {
  servedRequests++;
  const context = requestContext(req);
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return respond(res, 403, { error: 'Loopback host required' });
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return respond(res, 403, { error: 'Same-origin request required' });
  if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return respond(res, 404, { error: 'Not allowed' });
  const path = new URL(req.url, origin).pathname;
  const mutating = !['GET', 'HEAD'].includes(req.method);
  if (mutating && req.headers.origin !== origin) return respond(res, 403, { error: 'Same-origin mutation required' });
  if (req.method === 'GET' && (path === '/' || path === '/__harness')) {
    res.writeHead(302, { ...securityHeaders, location: '/__harness/' }); return res.end();
  }
  const asset = /^\/m\/[A-Za-z0-9_-]{20,100}\/?$/.test(path) ? assets.get('/room/index.html') : assets.get(path);
  if (asset) {
    if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
    return respond(res, 200, readFileSync(new URL(asset[0], root)), context, asset[1]);
  }
  if (path === '/__harness/status' && req.method === 'GET') return respond(res, 200, await status(context), context);
  if (['/__harness/role', '/__harness/reset', '/__harness/stop'].includes(path) && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await bodyBytes(req)); } catch { return respond(res, 400, { error: 'Invalid local control body' }); }
    if (path.endsWith('/role')) {
      if (!['observer', 'owner', 'other'].includes(payload.role)) return respond(res, 400, { error: 'Invalid fixture role' });
      clearBrowserGuests(context);
      context.role = payload.role;
      context.cookies.set('__harness_role', payload.role);
    } else if (path.endsWith('/reset')) {
      if (payload.confirm !== 'reset-local-fixture') return respond(res, 400, { error: 'Explicit fixture reset required' });
      await resetFixture(); clearBrowserGuests(context);
    } else {
      if (payload.confirm !== 'stop-local-fixture') return respond(res, 400, { error: 'Explicit fixture stop required' });
      respond(res, 200, { stopped: true }, context); setImmediate(stop); return;
    }
    return respond(res, 200, await status(context), context);
  }
  const match = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,100})(\/(?:join|me|vote|confirm|close|pay|voice-token))?$/);
  if (!match) return respond(res, 404, { error: 'Not allowed by local harness' });
  const suffix = match[2] || '';
  if (suffix === '/pay' || suffix === '/voice-token') return respond(res, 503, { error: 'Provider disabled in local harness' });
  const handler = handlers.get(`${req.method} ${suffix}`);
  if (!handler) return respond(res, 405, { error: 'Method not allowed' });
  let body;
  try { body = mutating ? await bodyBytes(req) : undefined; } catch { return respond(res, 413, { error: 'Body too large' }); }
  const headers = new Headers();
  // Deliberately do not forward Authorization or x-test-user. The fixture role
  // comes only from the separate local harness cookie, not from production auth.
  for (const name of ['content-type', 'x-guest-secret']) if (req.headers[name]) headers.set(name, req.headers[name]);
  const request = new Request(new URL(path, origin), { method: req.method, headers, ...(body?.length ? { body } : {}) });
  const response = await storage.run(context, () => handler(request, { params: Promise.resolve({ token: match[1] }) }));
  return respond(res, response.status, Buffer.from(await response.arrayBuffer()), context, response.headers.get('content-type') || 'application/json');
}
function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(timeout);
  server?.close(() => stopResolve?.());
  server?.closeAllConnections();
}

// A separate HTTP client with explicit, in-memory cookie jars. No fetch is used
// here, so application fetch remains a throwing guard throughout the smoke.
function client() {
  const jar = new Map();
  return async (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(new URL(path, origin), { method, agent: false, headers: {
      ...(jar.size ? { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      ...(method !== 'GET' ? { origin } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers,
    } }, (res) => {
      for (const header of res.headers['set-cookie'] || []) {
        const [pair] = header.split(';'); const index = pair.indexOf('=');
        if (/max-age=0/i.test(header)) jar.delete(pair.slice(0, index));
        else jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data; try { data = JSON.parse(text); } catch { /* Static asset. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.once('error', reject); req.setTimeout(5_000, () => req.destroy(new Error('Local request timed out')));
    req.end(payload);
  });
}

beforeAll(async () => {
  if (!['smoke', 'serve'].includes(MODE)) throw new Error('Run this harness only with tests/local-room-harness/run.sh');
  // Fail closed if a caller bypassed the clean launcher with provider variables.
  const forbiddenEnv = Object.keys(process.env).filter((key) => /SUPABASE|PINE_|GEMINI|ELEVENLABS|OPENAI|DEEPSEEK|GOOGLE|TOKEN|SECRET|PASSWORD|CREDENTIAL|VAULT|DATABASE_URL/i.test(key));
  expect(forbiddenEnv.length, 'Credential-like environment variables must be absent').toBe(0);
  // Suppress exception objects from app error handling; they could include input.
  vi.spyOn(console, 'error').mockImplementation(() => { deps.errorCount++; });
  db = await privacyDatabase();
  expect(deps.migrationReads.length).toBeGreaterThan(0);
  expect(deps.migrationReads.some((name) => /vault|app_secrets/i.test(name))).toBe(false);
  deps.admin = pgliteClient(db, 'service_role');
  deps.context = () => storage.getStore();
  deps.userClient = () => {
    const role = storage.getStore()?.role;
    const uid = role === 'owner' ? identities.alice : role === 'other' ? identities.bob : null;
    return pgliteClient(db, uid ? 'authenticated' : 'anon', uid);
  };
  await resetFixture();
  stopPromise = new Promise((resolve) => { stopResolve = resolve; });
  server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    // Serialize resets with route requests; no request sees half-reset fixtures.
    queue = queue.then(() => dispatch(req, res)).catch(() => {
      deps.errorCount++;
      if (!res.headersSent) respond(res, 500, { error: 'Local harness internal error' }); else res.end();
    });
  });
  server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  deps.origin = origin;
  timeout = setTimeout(stop, LIFETIME_MS);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}, 30_000);

afterAll(async () => {
  stop();
  if (server) await stopPromise;
  await queue;
  await db?.close();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('serves unchanged room assets and real routes with safe HTTP cookie isolation, RLS ownership, and bounded controls', async () => {
  const observer = client(), guestA = client(), guestB = client(), owner = client(), other = client();
  const room = `/api/rooms/${tokens.alice}`;
  const mutate = (method, body) => ({ method, body });
  const statusIs = (response, code) => expect(response.status).toBe(code);
  // These checks call only the throwing guard, never a transport.
  expect(() => globalThis.fetch('https://forbidden.invalid')).toThrow('External fetch forbidden');
  expect(deps.externalFetchAttempts).toBe(1);
  expect(() => httpRequest(new URL('https://forbidden.invalid'))).toThrow('Only harness loopback HTTP');
  const https = await import('node:https');
  expect(() => https.request(new URL('https://forbidden.invalid'))).toThrow('External HTTPS forbidden');
  expect(deps.externalFetchAttempts).toBe(3); deps.externalFetchAttempts = 0;
  expect(() => readFileSync(new URL('.env.harness-blocked-probe', root))).toThrow('Environment/Vault file access forbidden');
  expect(() => readFileSync(new URL('supabase/migrations/20261025090000_app_secrets_vault.sql', root))).toThrow('Environment/Vault file access forbidden');
  expect(deps.secretAccessAttempts).toBe(2); deps.secretAccessAttempts = 0;
  const page = await observer(`/m/${tokens.alice}`);
  statusIs(page, 200);
  expect(page.text === readFileSync(new URL('public/room/index.html', root), 'utf8')).toBe(true);
  expect(page.headers['content-security-policy']).toContain("connect-src 'self'");
  expect(page.headers['permissions-policy']).toContain('microphone=()');
  for (const [url, [file]] of assets) {
    const result = await observer(url); statusIs(result, 200);
    expect(result.text === readFileSync(new URL(file, root), 'utf8')).toBe(true);
  }
  for (const path of ['/api/me/contacts', '/.env', '/supabase/migrations/20261025090000_app_secrets_vault.sql', '/__harness/../package.json']) statusIs(await observer(path), 404);
  statusIs(await observer('/__harness/status', { headers: { host: 'external.invalid' } }), 403);
  statusIs(await observer('/__harness/status', { headers: { 'sec-fetch-site': 'cross-site' } }), 403);
  statusIs(await observer('/__harness/reset', { method: 'POST', headers: { origin: 'https://external.invalid' }, body: { confirm: 'reset-local-fixture' } }), 403);
  statusIs(await observer('/__harness/reset', mutate('POST', {})), 400);
  const initial = await observer(room); statusIs(initial, 200);
  expect(initial.data.me).toBeNull(); expect(initial.data.is_organizer).toBe(false);
  statusIs(await observer(room + '/me'), 401);
  statusIs(await observer(room + '/vote', mutate('POST', { venue_id: identities.venue })), 401);
  const [joinedA, joinedB] = await Promise.all([
    guestA(room + '/join', mutate('POST', { guest_name: 'Local Guest A' })),
    guestB(room + '/join', mutate('POST', { guest_name: 'Local Guest B' })),
  ]);
  for (const response of [joinedA, joinedB]) {
    statusIs(response, 201);
    expect(Boolean(response.headers['set-cookie']?.every((header) => /HttpOnly/.test(header) && /SameSite=Lax/.test(header) && /Path=\//.test(header)))).toBe(true);
  }
  // Boolean assertions intentionally never print guest secrets or cookie values.
  expect(joinedA.data.attendee_id !== joinedB.data.attendee_id).toBe(true);
  expect(joinedA.data.guest_secret !== joinedB.data.guest_secret).toBe(true);
  expect((await guestA(room + '/me')).data.attendee.id === joinedA.data.attendee_id).toBe(true);
  expect((await guestB(room + '/me')).data.attendee.id === joinedB.data.attendee_id).toBe(true);
  expect((await observer(room)).data.me).toBeNull();
  statusIs(await guestA(room + '/join', mutate('POST', { guest_name: 'Duplicate' })), 409);
  statusIs(await guestA(room + '/me', mutate('PATCH', { guest_name: 'Local Guest A edited', preferences: { area: 'Indiranagar', budget_max: 800, food: ['veg'] }, availability: ['Sat evening'] })), 200);
  expect((await guestB(room + '/me')).data.attendee.guest_name).toBe('Local Guest B');
  statusIs(await guestA(room + '/me', mutate('PATCH', { preferences: { budget_min: 900, budget_max: 800 } })), 400);
  statusIs(await guestA(`/api/rooms/${tokens.bob}/me`), 401);
  statusIs(await guestA(room + '/me', { headers: { 'x-guest-secret': 'invalid-synthetic-guest-header' } }), 401);
  for (const session of [guestA, guestB]) statusIs(await session(room + '/vote', mutate('POST', { venue_id: identities.venue })), 200);
  statusIs(await guestA(room + '/vote', mutate('DELETE')), 200);
  expect((await guestA(room)).data.me.voted_venue_id).toBeNull();
  expect((await guestB(room)).data.me.voted_venue_id).toBe(identities.venue);
  expect((await observer(room)).data.votes[identities.venue]).toBe(1);
  for (const suffix of ['/confirm', '/close']) {
    statusIs(await observer(room + suffix, mutate('POST', { venue_id: identities.venue })), 401);
    statusIs(await observer(room + suffix, { ...mutate('POST', { venue_id: identities.venue }), headers: { 'x-test-user': identities.alice } }), 401);
  }
  statusIs(await owner('/__harness/role', mutate('POST', { role: 'owner' })), 200);
  statusIs(await other('/__harness/role', mutate('POST', { role: 'other' })), 200);
  expect((await owner(room)).data.is_organizer).toBe(true);
  expect((await other(room)).data.is_organizer).toBe(false);
  for (const suffix of ['/confirm', '/close']) statusIs(await other(room + suffix, mutate('POST', { venue_id: identities.venue })), 403);
  statusIs(await owner(room + '/confirm', mutate('POST', { venue_id: identities.venue })), 200);
  statusIs(await guestB(room + '/vote', mutate('DELETE')), 409);
  statusIs(await guestA(room + '/pay'), 503);
  statusIs(await guestA(room + '/voice-token'), 503);
  statusIs(await owner(room + '/close', mutate('POST')), 200);
  statusIs(await guestB(room + '/me', mutate('PATCH', { guest_name: 'Closed edit' })), 410);
  statusIs(await observer(room + '/join', mutate('POST', { guest_name: 'Too late' })), 410);
  expect((await observer(room)).data.meetup.status).toBe('closed');
  // Exercise actual PostgreSQL RLS independently of the route owner check.
  const forbidden = await asRole(db, 'authenticated', identities.bob, (tx) => tx.query('update meetups set title = $1 where id = $2 returning id', ['Forbidden edit', tenants.alice.meetup.id]));
  expect(forbidden.rows.length).toBe(0);
  const anonymousGuests = await asRole(db, 'anon', null, (tx) => tx.query('select id from meetup_attendees'));
  expect(anonymousGuests.rows.length).toBe(0);
  const summary = (await observer('/__harness/status')).data;
  expect(summary.guests).toBe(2); expect(summary.votes).toBe(1); expect(summary.closed_rooms).toBe(1);
  expect(summary.external_fetch_attempts).toBe(0); expect(summary.provider_attempts).toBe(0);
  expect(summary.secret_access_attempts).toBe(0); expect(summary.internal_errors).toBe(0);
  // Leave a clean fixture for a browser operator, never the smoke's credentials.
  statusIs(await owner('/__harness/reset', mutate('POST', { confirm: 'reset-local-fixture' })), 200);
  statusIs(await guestA(room + '/me'), 401);
  expect((await observer('/__harness/status')).data.guests).toBe(0);
  if (MODE === 'serve') {
    console.log(`LOCAL_ROUTE_HARNESS_READY ${origin}/__harness/ (30 minute maximum lifetime; synthetic auth; no live providers)`);
    await stopPromise;
    expect(deps.externalFetchAttempts).toBe(0); expect(deps.providerAttempts).toBe(0); expect(deps.secretAccessAttempts).toBe(0);
  } else {
    statusIs(await owner('/__harness/stop', mutate('POST', { confirm: 'stop-local-fixture' })), 200);
    await stopPromise;
    console.log('LOCAL_ROUTE_HARNESS_SMOKE_OK: real route HTTP flow, independent cookies, ownership/RLS, controls, provider/network guards; listener stopped.');
  }
});
