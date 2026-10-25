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
// Any accidental import of a live integration module fails at import time.
vi.mock('@supabase/supabase-js', () => { deps.providerAttempts++; throw new Error('Supabase SDK disabled in local harness'); });
vi.mock('@supabase/ssr', () => { deps.providerAttempts++; throw new Error('Supabase Auth SDK disabled in local harness'); });
vi.mock('@plural_pinelabs/agent-toolkit/shared', () => { deps.providerAttempts++; throw new Error('Payment SDK disabled in local harness'); });
vi.mock('@/lib/google/connector', () => { deps.providerAttempts++; throw new Error('Google connector disabled in local harness'); });
vi.mock('@/lib/google/action-provider', () => { deps.providerAttempts++; throw new Error('Google action provider disabled in local harness'); });
vi.mock('@/lib/google/sheets-provider', () => { deps.providerAttempts++; throw new Error('Google Sheets provider disabled in local harness'); });
vi.mock('@/lib/extract-llm', () => { deps.providerAttempts++; throw new Error('Extraction providers disabled in local harness'); });
vi.mock('@/lib/draft-llm', () => { deps.providerAttempts++; throw new Error('Draft providers disabled in local harness'); });
vi.mock('@/lib/assistant', () => { deps.providerAttempts++; throw new Error('Assistant provider disabled in local harness'); });
vi.mock('@/lib/agenticorg', () => { deps.providerAttempts++; throw new Error('AgenticOrg provider disabled in local harness'); });
vi.mock('@/lib/transcribe', () => { deps.providerAttempts++; throw new Error('Transcription provider disabled in local harness'); });
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

import { GET as getProfile } from '../../app/api/me/route';
import { GET as getDashboard } from '../../app/api/me/dashboard/route';
import { GET as getFollowups } from '../../app/api/me/followups/route';
import { GET as listContacts, POST as createContacts } from '../../app/api/me/contacts/route';
import { GET as getContact, PATCH as updateContact, DELETE as deleteContact } from '../../app/api/me/contacts/[id]/route';
import { GET as getGoals, PUT as saveGoals } from '../../app/api/me/goals/route';
import { GET as listInteractions, POST as recordInteraction } from '../../app/api/me/interactions/route';
import { GET as listMeetups, POST as createMeetup } from '../../app/api/me/meetups/route';
import { GET as getMeetup, PATCH as updateMeetup, DELETE as deleteMeetup } from '../../app/api/me/meetups/[id]/route';

const MODE = process.env.TEAM54_ORGANIZER_HARNESS_MODE;
const RECEIPTS = process.env.CONTACT_CREATE_RETRY_ENABLED === 'true';
const organizerAdapter = {
  organizerQueries: true,
  jsonRows: true,
  allowedTables: ['contacts', 'balance_goals', 'interactions', 'meetups', 'meetup_attendees', 'venue_votes', 'venues'],
  allowedRpcs: ['record_interaction', ...(RECEIPTS ? ['contact_create_retry_ready', 'create_contacts_once'] : [])],
  defaultConflicts: { balance_goals: 'user_id,category' },
};
const roomAdapter = {
  jsonRows: true,
  allowedTables: ['meetups', 'meetup_attendees', 'venue_votes', 'venues', 'meetup_payments'],
  allowedRpcs: ['payment_checkout_ready'],
};
const PORT = MODE === 'serve' ? 4319 : 0;
const LIFETIME_MS = 30 * 60 * 1000;
const tokens = { alice: 'local_harness_room_alice_0001', bob: 'local_harness_room_bob_000001' };
const root = new URL('../../', import.meta.url);
const storage = new AsyncLocalStorage();
const assets = new Map([
  ...['index.html', 'styles.css', 'voice.css', 'google-actions.css', 'assistant.js', 'live.js', 'plan-voice.js', 'voice.js', 'google-contacts.js', 'google-actions.js', 'app.js', 'desktop.js'].map((file) => [
    '/organizer/' + file, ['public/organizer/' + file, file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'],
  ]),
  ['/organizer/', ['public/organizer/index.html', 'text/html; charset=utf-8']],
  ['/room/index.html', ['public/room/index.html', 'text/html; charset=utf-8']],
  ['/room/room.css', ['public/room/room.css', 'text/css; charset=utf-8']],
  ['/room/room.js', ['public/room/room.js', 'text/javascript; charset=utf-8']],
  ['/room/meet.js', ['public/room/meet.js', 'text/javascript; charset=utf-8']],
  ['/room/room-voice.js', ['public/room/room-voice.js', 'text/javascript; charset=utf-8']],
  ['/product-analytics.js', ['public/product-analytics.js', 'text/javascript; charset=utf-8']],
  ['/muop-mark.svg', ['public/muop-mark.svg', 'image/svg+xml']],
  ['/__harness/', ['tests/local-organizer-harness/controls.html', 'text/html; charset=utf-8']],
  ['/__harness/controls.js', ['tests/local-organizer-harness/controls.js', 'text/javascript; charset=utf-8']],
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
const organizerHandlers = new Map([
  ['GET /api/me', getProfile], ['GET /api/me/dashboard', getDashboard], ['GET /api/me/followups', getFollowups],
  ['GET /api/me/contacts', listContacts], ['POST /api/me/contacts', createContacts],
  ['GET /api/me/contacts/:id', getContact], ['PATCH /api/me/contacts/:id', updateContact], ['DELETE /api/me/contacts/:id', deleteContact],
  ['GET /api/me/goals', getGoals], ['PUT /api/me/goals', saveGoals],
  ['GET /api/me/interactions', listInteractions], ['POST /api/me/interactions', recordInteraction],
  ['GET /api/me/meetups', listMeetups], ['POST /api/me/meetups', createMeetup],
  ['GET /api/me/meetups/:id', getMeetup], ['PATCH /api/me/meetups/:id', updateMeetup], ['DELETE /api/me/meetups/:id', deleteMeetup],
]);
const providerPath = (path) => ['/api/extract', '/api/assistant', '/api/voice/live-token', '/api/voice/signed-url', '/api/voice/transcribe'].includes(path)
  || /^\/api\/me\/contacts\/[0-9a-f-]+\/draft$/.test(path)
  || /^\/api\/me\/integrations\/google\/(?:contacts|gmail|calendar|sheets-import|sheets-export)(?:\/(?:start|callback|preview|import|cancel))?$/.test(path);
let db, server, origin, tenants, timeout, stopResolve, stopPromise, queue = Promise.resolve();
let stopped = false, servedRequests = 0, resets = 0, scenario = 'seeded';
let bulkExpectations = null;
const contactReadFailure = { pending_target: null, armed_count: 0, consumed_count: 0, last_failure: null };
const contactReadTargets = { contacts: '/api/me/contacts', dashboard: '/api/me/dashboard' };
const issuedGuestCookies = new Set();
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
  const role = ['owner', 'other'].includes(values.get('__organizer_harness_role')) ? values.get('__organizer_harness_role') : 'observer';
  const writes = [];
  return { role, values, writes, cookies: {
    get: (name) => values.has(name) ? { value: values.get(name) } : undefined,
    set: (name, value, options) => {
      if (/^guest_[0-9a-f-]+$/.test(name)) issuedGuestCookies.add(name);
      values.set(name, value); writes.push(cookieHeader(name, value, options));
    },
  } };
}
function clearBrowserGuests(context) {
  for (const name of context.values.keys()) if (issuedGuestCookies.has(name)) {
    context.cookies.set(name, '', { maxAge: 0 });
  }
}
async function resetFixture(nextScenario = 'seeded') {
  if (!['seeded', 'empty', 'bulk1001'].includes(nextScenario)) throw new Error('Invalid fixture scenario');
  tenants = await seedPrivateData(db);
  scenario = nextScenario;
  bulkExpectations = null;
  Object.assign(contactReadFailure, { pending_target: null, armed_count: 0, consumed_count: 0, last_failure: null });
  if (scenario === 'empty') await asRole(db, 'authenticated', identities.alice, async (tx) => {
    await tx.query('delete from contacts');
    await tx.query('delete from balance_goals');
    await tx.query('delete from meetups');
  });
  if (scenario === 'bulk1001') {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const midnight = Date.parse(`${day}T00:00:00+05:30`);
    const due = [-3, -1, 2, 7].map((days) => new Date(midnight + days * 86_400_000).toISOString());
    // Fixed SQL and exactly 1,001 synthetic rows. No control accepts a count,
    // SQL, name, UUID, timestamp or other arbitrary fixture input.
    await asRole(db, 'authenticated', identities.alice, async (tx) => {
      await tx.query('delete from contacts');
      await tx.query(`insert into contacts (id, name, category, next_followup_at)
        select ('44444444-4444-4444-8444-' || lpad(n::text, 12, '0'))::uuid,
          case when n = 1001 then 'ZZZ Synthetic Alice 1001' else 'Alice Bulk ' || lpad(n::text, 4, '0') end,
          (case mod(n - 1, 3) when 0 then 'personal' when 1 then 'professional' else 'community' end)::life_category,
          case n when 1 then $1::timestamptz when 2 then $2::timestamptz when 3 then $3::timestamptz when 1001 then $4::timestamptz else null end
        from generate_series(1, 1001) as series(n)`, due);
    });
    bulkExpectations = {
      alice_contacts: 1001, bob_contacts: 1,
      contact_counts: { personal: 334, professional: 334, community: 333 },
      followups: { overdue: 2, upcoming: 2, due_today: 0 },
      alice_recorded_activity: 0,
      final_contact: { id: '44444444-4444-4444-8444-000000001001', name: 'ZZZ Synthetic Alice 1001', category: 'professional', next_followup_at: due[3] },
      reset_day_ist: day,
      due_contacts: [1, 2, 3, 1001].map((number, index) => ({
        id: `44444444-4444-4444-8444-${String(number).padStart(12, '0')}`, next_followup_at: due[index],
      })),
    };
  }
  for (const name of ['alice', 'bob']) {
    await asRole(db, 'service_role', null, (tx) => tx.query('update meetups set room_token = $1 where id = $2', [tokens[name], tenants[name].meetup.id]));
  }
  resets++;
}

function withContactReadFailure(client, context) {
  if (context?.role !== 'owner' || context.requestMethod !== 'GET'
    || context.requestPath !== contactReadTargets[contactReadFailure.pending_target]) return client;
  let successfulPages = 0, firstPageRows = 0;
  return { ...client, from(table) {
    const query = client.from(table);
    if (table !== 'contacts') return query;
    let isHead = false, hasIdCursor = false, executed;
    const select = query.select.bind(query), gt = query.gt.bind(query), then = query.then.bind(query);
    query.select = (columns, options) => { isHead = options?.head === true; return select(columns, options); };
    query.gt = (column, value) => { if (column === 'id') hasIdCursor = true; return gt(column, value); };
    const execute = async () => {
      if (!isHead && hasIdCursor && successfulPages === 1 && firstPageRows > 0
        && context.requestPath === contactReadTargets[contactReadFailure.pending_target]) {
        const target = contactReadFailure.pending_target;
        contactReadFailure.pending_target = null;
        contactReadFailure.consumed_count++;
        contactReadFailure.last_failure = { target, path: context.requestPath, page: 2, first_page_rows: firstPageRows };
        return { data: null, error: { code: 'XX000', message: 'Synthetic second contact page read failure' } };
      }
      const result = await new Promise((resolve, reject) => then(resolve, reject));
      if (!isHead && !result.error && Array.isArray(result.data) && result.data.length) {
        successfulPages++;
        if (successfulPages === 1) firstPageRows = result.data.length;
      }
      return result;
    };
    query.then = (resolve, reject) => { executed ??= execute(); return executed.then(resolve, reject); };
    return query;
  } };
}
async function status(context) {
  const counts = await asRole(db, 'service_role', null, async (tx) => (await tx.query(`select
    (select count(*)::int from contacts) as contacts,
    (select count(*)::int from interactions) as interactions,
    (select count(*)::int from balance_goals) as goals,
    (select count(*)::int from meetup_attendees) as guests,
    (select count(*)::int from venue_votes) as votes,
    (select count(*)::int from meetups where status = 'closed') as closed_rooms,
    (select count(*)::int from meetups where final_venue_id is not null) as confirmed_rooms`)).rows[0]);
  return { mode: 'local-organizer-real-handler-fixture', role: context.role, scenario, contact_receipts: RECEIPTS ? 'real-local-rpc' : 'disabled-legacy', ...counts, served_requests: servedRequests, resets,
    bulk_expectations: bulkExpectations, contact_read_failure: { ...contactReadFailure },
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
  if (req.method === 'GET' && path === '/organizer') {
    res.writeHead(302, { ...securityHeaders, location: '/organizer/' }); return res.end();
  }
  const asset = /^\/m\/[A-Za-z0-9_-]{20,100}\/?$/.test(path) ? assets.get('/room/index.html') : assets.get(path);
  if (asset) {
    if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
    return respond(res, 200, readFileSync(new URL(asset[0], root)), context, asset[1]);
  }
  if (path === '/__harness/status' && req.method === 'GET') return respond(res, 200, await status(context), context);
  if (['/__harness/role', '/__harness/reset', '/__harness/stop', '/__harness/read-failure'].includes(path) && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse(await bodyBytes(req)); } catch { return respond(res, 400, { error: 'Invalid local control body' }); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return respond(res, 400, { error: 'Invalid local control body' });
    if (path.endsWith('/role')) {
      if (!['observer', 'owner', 'other'].includes(payload.role)) return respond(res, 400, { error: 'Invalid fixture role' });
      clearBrowserGuests(context);
      context.role = payload.role;
      context.cookies.set('__organizer_harness_role', payload.role);
    } else if (path.endsWith('/reset')) {
      if (payload.confirm !== 'reset-local-fixture') return respond(res, 400, { error: 'Explicit fixture reset required' });
      if (payload.scenario !== undefined && !['seeded', 'empty', 'bulk1001'].includes(payload.scenario)) return respond(res, 400, { error: 'Invalid fixture scenario' });
      if (payload.scenario === 'bulk1001' && Object.keys(payload).some((key) => !['confirm', 'scenario'].includes(key))) return respond(res, 400, { error: 'The bulk fixture is fixed; extra inputs are not allowed' });
      await resetFixture(payload.scenario); clearBrowserGuests(context);
    } else if (path.endsWith('/read-failure')) {
      if (payload.confirm !== 'fail-next-contact-page2' || typeof payload.target !== 'string' || !Object.hasOwn(contactReadTargets, payload.target)
        || Object.keys(payload).some((key) => !['confirm', 'target'].includes(key))) return respond(res, 400, { error: 'Explicit fixed contact-read failure target required' });
      if (scenario !== 'bulk1001') return respond(res, 409, { error: 'Load the bulk1001 fixture before arming a second-page failure' });
      if (contactReadFailure.pending_target !== null) return respond(res, 409, { error: 'A contact-read failure is already armed; consume it or reset the fixture' });
      contactReadFailure.pending_target = payload.target;
      contactReadFailure.armed_count++;
    } else {
      if (payload.confirm !== 'stop-local-fixture') return respond(res, 400, { error: 'Explicit fixture stop required' });
      respond(res, 200, { stopped: true }, context); setImmediate(stop); return;
    }
    return respond(res, 200, await status(context), context);
  }
  // No production login, signout, LLM, Google, voice, or payment handler is
  // imported or dispatched. These denials are fixture boundaries, not mocks
  // purporting to be successful provider responses.
  if (providerPath(path) || ['/login', '/auth/signout'].includes(path)) return respond(res, 503, { error: 'Provider or production Auth disabled in local harness. Use /__harness/ synthetic role controls.' });
  const match = path.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,100})(\/(?:join|me|vote|confirm|close|pay|voice-token))?$/);
  let handler, params;
  if (match) {
    const suffix = match[2] || '';
    if (suffix === '/pay' || suffix === '/voice-token') return respond(res, 503, { error: 'Provider disabled in local harness' });
    handler = handlers.get(`${req.method} ${suffix}`);
    params = { token: match[1] };
  } else {
    const entity = path.match(/^\/api\/me\/(contacts|meetups)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    const route = entity ? `/api/me/${entity[1]}/:id` : path;
    if (![...organizerHandlers.keys()].some((key) => key.endsWith(' ' + route))) return respond(res, 404, { error: 'Not allowed by local harness' });
    handler = organizerHandlers.get(`${req.method} ${route}`);
    params = entity ? { id: entity[2] } : {};
  }
  if (!handler) return respond(res, 405, { error: 'Method not allowed' });
  let body;
  try { body = mutating ? await bodyBytes(req) : undefined; } catch { return respond(res, 413, { error: 'Body too large' }); }
  const headers = new Headers();
  // Deliberately do not forward Authorization or x-test-user. The fixture role
  // comes only from the separate local harness cookie, not from production auth.
  for (const name of ['content-type', 'x-guest-secret', 'idempotency-key', 'x-contact-owner']) if (req.headers[name]) headers.set(name, req.headers[name]);
  const request = new Request(new URL(req.url, origin), { method: req.method, headers, ...(body?.length ? { body } : {}) });
  context.requestPath = path; context.requestMethod = req.method;
  const response = await storage.run(context, () => handler(request, { params: Promise.resolve(params) }));
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
  if (!['smoke', 'serve'].includes(MODE)) throw new Error('Run this harness only with tests/local-organizer-harness/run.sh');
  // Fail closed if a caller bypassed the clean launcher with provider variables.
  const forbiddenEnv = Object.keys(process.env).filter((key) => /SUPABASE|PINE_|GEMINI|ELEVENLABS|OPENAI|DEEPSEEK|GOOGLE|TOKEN|SECRET|PASSWORD|CREDENTIAL|VAULT|DATABASE_URL/i.test(key));
  expect(forbiddenEnv.length, 'Credential-like environment variables must be absent').toBe(0);
  // Suppress exception objects from app error handling; they could include input.
  vi.spyOn(console, 'error').mockImplementation(() => { deps.errorCount++; });
  db = await privacyDatabase();
  await db.exec("set timezone = 'UTC'");
  expect(deps.migrationReads.length).toBeGreaterThan(0);
  expect(deps.migrationReads.some((name) => /vault|app_secrets/i.test(name))).toBe(false);
  deps.admin = pgliteClient(db, 'service_role', null, roomAdapter);
  deps.context = () => storage.getStore();
  deps.userClient = () => {
    const context = storage.getStore(), role = context?.role;
    const uid = role === 'owner' ? identities.alice : role === 'other' ? identities.bob : null;
    return withContactReadFailure(pgliteClient(db, uid ? 'authenticated' : 'anon', uid, organizerAdapter), context);
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

it('serves unchanged organizer/room assets and real routes with safe HTTP cookie isolation, RLS ownership, and bounded controls', async () => {
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
  for (const path of ['/api/me/not-implemented', '/.env', '/supabase/migrations/20261025090000_app_secrets_vault.sql', '/__harness/../package.json']) statusIs(await observer(path), 404);
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
  await organizerSmoke({ owner, other, observer, statusIs, mutate });
  await bulkReadSmoke({ owner, other, observer, statusIs, mutate });
  // Leave a clean fixture for a browser operator, never the smoke's credentials.
  statusIs(await owner('/__harness/reset', mutate('POST', { confirm: 'reset-local-fixture' })), 200);
  statusIs(await guestA(room + '/me'), 401);
  expect((await observer('/__harness/status')).data.guests).toBe(0);
  if (MODE === 'serve') {
    console.log(`LOCAL_ORGANIZER_HARNESS_READY ${origin}/__harness/ (30 minute maximum lifetime; synthetic auth; no live providers)`);
    await stopPromise;
    expect(deps.externalFetchAttempts).toBe(0); expect(deps.providerAttempts).toBe(0); expect(deps.secretAccessAttempts).toBe(0);
  } else {
    statusIs(await owner('/__harness/stop', mutate('POST', { confirm: 'stop-local-fixture' })), 200);
    await stopPromise;
    console.log('LOCAL_ORGANIZER_HARNESS_SMOKE_OK: real organizer CRUD/goals/interaction/meetup routes, exact timestamp locks, independent cookies, ownership/RLS, controls, provider/network guards; listener stopped.');
  }
});

async function organizerSmoke({ owner, other, observer, statusIs, mutate }) {
  const ownerHeaders = { 'x-contact-owner': identities.alice };
  const contactsPath = '/api/me/contacts';
  const goalsPath = '/api/me/goals';
  const meetupsPath = '/api/me/meetups';
  for (const path of ['/api/me', '/api/me/dashboard', contactsPath, goalsPath, '/api/me/interactions', meetupsPath, '/api/me/followups']) {
    statusIs(await observer(path), 401);
    statusIs(await observer(path, { headers: { authorization: 'Bearer synthetic-not-a-session', 'x-test-user': identities.alice } }), 401);
  }
  statusIs(await observer('/api/me', { headers: { cookie: '__harness_role=owner' } }), 401);
  const profile = await owner('/api/me'); statusIs(profile, 200);
  expect(profile.data.user.id).toBe(identities.alice);
  expect(profile.data.capabilities.contact_create_retry).toBe(RECEIPTS);
  expect((await other('/api/me')).data.user.id).toBe(identities.bob);
  const aliceContacts = (await owner(contactsPath)).data.contacts;
  const bobContacts = (await other(contactsPath)).data.contacts;
  expect(aliceContacts.map((c) => c.user_id)).toEqual([identities.alice]);
  expect(bobContacts.map((c) => c.user_id)).toEqual([identities.bob]);
  expect((await owner(contactsPath + '?category=professional')).data.contacts).toEqual([]);
  statusIs(await owner(contactsPath + '?category=invalid'), 400);
  const beforeGoals = (await owner(goalsPath)).data.goals;
  statusIs(await owner(goalsPath, mutate('PUT', { personal: 80, professional: 80, community: 0 })), 400);
  statusIs(await owner(goalsPath, { ...mutate('PUT', { personal: 30, professional: 40, community: 30 }), headers: { 'x-contact-owner': identities.bob } }), 409);
  expect((await owner(goalsPath)).data.goals).toEqual(beforeGoals);
  const goalBody = { personal: 20, professional: 30, community: 50 };
  for (let i = 0; i < 2; i++) statusIs(await owner(goalsPath, { ...mutate('PUT', goalBody), headers: ownerHeaders }), 200);
  expect((await owner(goalsPath)).data.goals).toEqual(goalBody);
  expect((await other(goalsPath)).data.goals).toEqual({ personal: 30, professional: 50, community: 20 });
  const invalidContact = await owner(contactsPath, mutate('POST', { name: '', category: 'personal' }));
  statusIs(invalidContact, 400); expect(invalidContact.data.code).toBe('contact_input_rejected');
  statusIs(await owner(contactsPath, { ...mutate('POST', { name: 'Not saved', category: 'personal' }), headers: { 'x-contact-owner': identities.bob } }), 409);
  const batch = await owner(contactsPath, { ...mutate('POST', { contacts: [
    { name: 'Synthetic Organizer Person', category: 'personal', preferred_frequency_days: 14, interests: ['coffee'] },
    { name: 'Synthetic Community Person', category: 'community', notes: 'Private synthetic note', email: 'fixture@example.test' },
  ] }), headers: ownerHeaders });
  statusIs(batch, 201); expect(batch.data.contacts).toHaveLength(2);
  const created = batch.data.contacts[0], second = batch.data.contacts[1];
  expect(second.email).toBe('fixture@example.test'); expect(second.notes).toBe('Private synthetic note');
  expect(second.interests).toEqual([]); expect(created.user_id).toBe(identities.alice);
  const contactPath = contactsPath + '/' + created.id;
  const foreignPath = contactsPath + '/' + bobContacts[0].id;
  for (const request of [{}, mutate('PATCH', { notes: 'Forbidden' }), mutate('DELETE')]) statusIs(await owner(foreignPath, request), 404);
  statusIs(await other(contactPath), 404);
  statusIs(await owner(contactPath, mutate('PATCH', { notes: 'Changed synthetic note', preferred_frequency_days: 7 })), 200);
  expect((await owner(contactPath)).data.contact).toMatchObject({ name: created.name, category: 'personal', notes: 'Changed synthetic note', preferred_frequency_days: 7, interests: ['coffee'] });
  statusIs(await owner(contactPath, mutate('PATCH', { preferred_frequency_days: 0 })), 400);

  const occurred = new Date(Date.now() - 60_000).toISOString();
  const log = await owner('/api/me/interactions', mutate('POST', { contact_id: created.id, occurred_at: occurred, type: 'call', notes: 'Synthetic call' }));
  statusIs(log, 201);
  expect(log.data.interaction.contact_id).toBe(created.id);
  expect(Date.parse(log.data.contact.last_interaction_at)).toBe(Date.parse(occurred));
  const expectedNext = Date.parse(occurred) + 7 * 86_400_000;
  expect(Date.parse(log.data.contact.next_followup_at)).toBe(expectedNext);
  statusIs(await owner('/api/me/interactions', mutate('POST', { contact_id: created.id, occurred_at: new Date(Date.parse(occurred) - 86_400_000).toISOString(), type: 'message' })), 201);
  const contactWithHistory = await owner(contactPath);
  expect(contactWithHistory.data.interactions).toHaveLength(2);
  expect(Date.parse(contactWithHistory.data.contact.next_followup_at)).toBe(expectedNext);
  statusIs(await owner('/api/me/interactions', mutate('POST', { contact_id: bobContacts[0].id, type: 'call' })), 404);
  statusIs(await owner('/api/me/interactions', mutate('POST', { contact_id: created.id, type: 'invalid' })), 400);
  const recent = await owner('/api/me/interactions?limit=1'); statusIs(recent, 200);
  expect(recent.data.interactions).toHaveLength(1);
  expect(recent.data.interactions[0].contact).toMatchObject({ id: expect.any(String), category: 'personal' });
  statusIs(await owner('/api/me/interactions?limit=0'), 400);
  expect((await owner('/api/me/followups?days=14')).data.upcoming.some((c) => c.id === created.id)).toBe(true);
  statusIs(await owner('/api/me/followups?days=-1'), 400);
  const dashboard = await owner('/api/me/dashboard'); statusIs(dashboard, 200);
  expect(dashboard.data.contact_counts).toEqual({ personal: 2, professional: 0, community: 1 });
  expect(dashboard.data.goals).toEqual(goalBody);
  expect(dashboard.data.recent_activity.every((i) => i.contact?.id !== bobContacts[0].id)).toBe(true);

  // Legacy saves remain ordinary inserts, including deliberately same-name
  // people. A keyed request is never silently downgraded when receipts are off.
  const sameBody = { name: 'Synthetic Same Name', category: 'professional' };
  const legacyA = await owner(contactsPath, mutate('POST', sameBody));
  const legacyB = await owner(contactsPath, mutate('POST', sameBody));
  statusIs(legacyA, 201); statusIs(legacyB, 201);
  expect(legacyA.data.contacts[0].id !== legacyB.data.contacts[0].id).toBe(true);
  const receiptKey = '77777777-7777-4777-8777-777777777777';
  const keyed = (body) => ({ ...mutate('POST', body), headers: { ...ownerHeaders, 'idempotency-key': receiptKey } });
  const keyedA = await owner(contactsPath, keyed(sameBody));
  statusIs(keyedA, RECEIPTS ? 201 : 503);
  if (RECEIPTS) {
    const keyedB = await owner(contactsPath, keyed(sameBody)); statusIs(keyedB, 201);
    expect(keyedB.data.created_ids).toEqual(keyedA.data.created_ids);
    statusIs(await owner(contactsPath, keyed({ ...sameBody, name: 'Changed receipt intent' })), 409);
    const keyedId = keyedA.data.created_ids[0];
    statusIs(await owner(contactsPath + '/' + keyedId, mutate('DELETE')), 200);
    const replay = await owner(contactsPath, keyed(sameBody)); statusIs(replay, 201);
    expect(replay.data.contacts).toEqual([]); expect(replay.data.missing_ids).toEqual([keyedId]);
    const bobReceipt = await other(contactsPath, { ...mutate('POST', sameBody), headers: { 'idempotency-key': receiptKey, 'x-contact-owner': identities.bob } });
    statusIs(bobReceipt, 201);
    expect(bobReceipt.data.created_ids[0] !== keyedId).toBe(true);
    expect(bobReceipt.data.contacts[0].user_id).toBe(identities.bob);
  } else expect((await owner(contactsPath)).data.contacts.filter((c) => c.name === sameBody.name)).toHaveLength(2);

  statusIs(await owner(meetupsPath, mutate('POST', { title: ' ' })), 400);
  const start = new Date(Date.now() + 35 * 86_400_000).toISOString();
  const meeting = await owner(meetupsPath, mutate('POST', { title: 'Synthetic Organizer Meetup', activity: 'coffee', area: 'Fixture Area', starts_at: start, budget: 0, notes: 'Private meetup detail' }));
  statusIs(meeting, 201);
  const m = meeting.data.meetup, meetupPath = meetupsPath + '/' + m.id;
  expect(m.organizer_id).toBe(identities.alice);
  expect(new URL(m.room_url).origin).toBe(origin);
  expect(Date.parse(m.expires_at)).toBe(Date.parse(start) + 2 * 86_400_000);
  expect((await owner(meetupsPath)).data.meetups.some((row) => row.id === m.id)).toBe(true);
  expect((await other(meetupsPath)).data.meetups.some((row) => row.id === m.id)).toBe(false);
  statusIs(await other(meetupPath), 404);
  statusIs(await other(meetupPath, mutate('PATCH', { title: 'Foreign edit' })), 404);
  statusIs(await other(meetupPath, mutate('DELETE')), 404);
  const sqlVersion = async (id) => (await asRole(db, 'authenticated', identities.alice, (tx) => tx.query("select to_jsonb(m)->>'updated_at' as value from meetups m where id = $1", [id]))).rows[0].value;
  expect(m.updated_at).toBe(await sqlVersion(m.id));
  const edit = await owner(meetupPath, mutate('PATCH', { title: 'Synthetic Meetup Edited', expected_updated_at: m.updated_at }));
  statusIs(edit, 200); expect(edit.data.meetup.updated_at).toBe(await sqlVersion(m.id));
  statusIs(await owner(meetupPath, mutate('PATCH', { title: 'Stale overwrite', expected_updated_at: m.updated_at })), 409);
  const reschedule = await owner(meetupPath, mutate('PATCH', { starts_at: null, expected_updated_at: edit.data.meetup.updated_at }));
  statusIs(reschedule, 200); expect(reschedule.data.meetup.starts_at).toBeNull();
  expect(Math.abs(Date.parse(reschedule.data.meetup.expires_at) - Date.now() - 14 * 86_400_000)).toBeLessThan(5_000);
  const room = await observer('/api/rooms/' + m.room_token); statusIs(room, 200);
  expect(room.data.meetup.title).toBe('Synthetic Meetup Edited');
  expect(room.data.meetup.notes).toBeUndefined();
  statusIs(await owner(meetupPath, mutate('PATCH', { status: 'closed' })), 200);
  statusIs(await owner(meetupPath, mutate('PATCH', { title: 'Closed edit' })), 410);
  expect((await owner('/api/me/dashboard')).data.upcoming_meetups.some((row) => row.id === m.id)).toBe(false);
  statusIs(await owner(meetupPath, mutate('DELETE')), 200);
  statusIs(await owner(meetupPath), 404);

  // Deterministic six-digit precision fixture: a GET token must be reusable
  // verbatim through HTTP. No alternate SQL version is supplied to the PATCH.
  const preciseId = (await asRole(db, 'authenticated', identities.alice, (tx) => tx.query(
    "insert into meetups(title, updated_at) values ('Synthetic precision fixture', '2026-10-25T01:02:03.123456Z') returning id"))).rows[0].id;
  const precisePath = meetupsPath + '/' + preciseId;
  const precise = (await owner(precisePath)).data.meetup;
  expect(precise.updated_at).toBe('2026-10-25T01:02:03.123456+00:00');
  statusIs(await owner(precisePath, mutate('PATCH', { title: 'Precision preserved', expected_updated_at: precise.updated_at })), 200);
  statusIs(await owner(precisePath, mutate('PATCH', { title: 'Precision stale', expected_updated_at: precise.updated_at })), 409);

  statusIs(await owner(contactPath, mutate('DELETE')), 200);
  statusIs(await owner(contactPath), 404);
  expect((await owner('/api/me/interactions?limit=100')).data.interactions.some((i) => i.contact_id === created.id)).toBe(false);
  expect((await other(foreignPath)).data.contact.notes).toBe('bob private contact note');
  for (const table of ['contacts', 'balance_goals', 'interactions']) {
    expect((await asRole(db, 'anon', null, (tx) => tx.query(`select * from ${table}`))).rows).toEqual([]);
  }
  const foreignMutation = await asRole(db, 'authenticated', identities.bob, (tx) => tx.query('update contacts set notes = $1 where id = $2 returning id', ['Forbidden', second.id]));
  expect(foreignMutation.rows).toEqual([]);
  for (const path of ['/api/extract', '/api/assistant', '/api/voice/live-token', '/api/voice/signed-url', '/api/voice/transcribe', '/api/me/integrations/google/contacts', '/api/me/integrations/google/contacts/start', '/api/me/integrations/google/gmail', '/api/me/integrations/google/calendar', contactsPath + '/' + second.id + '/draft']) {
    statusIs(await owner(path), 503);
    statusIs(await owner(path, mutate('POST', {})), 503);
  }
  statusIs(await owner('/__harness/reset', mutate('POST', { confirm: 'reset-local-fixture', scenario: 'empty' })), 200);
  expect((await owner('/api/me/dashboard')).data.is_empty).toBe(true);
  expect((await owner(goalsPath)).data.goals).toBeNull();
  expect((await other(contactsPath)).data.contacts).toHaveLength(1);
  statusIs(await owner(goalsPath, { ...mutate('PUT', goalBody), headers: ownerHeaders }), 200);
  statusIs(await owner(contactsPath, { ...mutate('POST', { contacts: [{ name: 'Synthetic Onboarding Person', category: 'community', interests: ['games'], preferred_frequency_days: 14 }] }), headers: ownerHeaders }), 201);
  expect((await owner('/api/me/dashboard')).data).toMatchObject({ is_empty: false, goals: goalBody, contact_counts: { personal: 0, professional: 0, community: 1 } });
  const summary = (await observer('/__harness/status')).data;
  expect(summary.external_fetch_attempts).toBe(0); expect(summary.provider_attempts).toBe(0);
  expect(summary.secret_access_attempts).toBe(0); expect(summary.internal_errors).toBe(0);
}

async function bulkReadSmoke({ owner, other, observer, statusIs, mutate }) {
  const reset = (scenario, extra = {}) => owner('/__harness/reset', mutate('POST', { confirm: 'reset-local-fixture', scenario, ...extra }));
  const arm = (target, extra = {}) => owner('/__harness/read-failure', mutate('POST', { confirm: 'fail-next-contact-page2', target, ...extra }));
  const fixtureStatus = async () => (await observer('/__harness/status')).data;
  statusIs(await arm('contacts'), 409);
  statusIs(await reset('bulk1001', { count: 1002 }), 400);
  statusIs(await reset('bulk1002'), 400);
  const seeded = await reset('bulk1001'); statusIs(seeded, 200);
  const expected = seeded.data.bulk_expectations;
  expect(seeded.data).toMatchObject({ scenario: 'bulk1001', contacts: 1002, interactions: 1, goals: 6 });
  expect(expected).toMatchObject({ alice_contacts: 1001, bob_contacts: 1,
    contact_counts: { personal: 334, professional: 334, community: 333 }, followups: { overdue: 2, upcoming: 2, due_today: 0 } });
  expect(seeded.data.contact_read_failure).toEqual({ pending_target: null, armed_count: 0, consumed_count: 0, last_failure: null });

  const alice = await owner('/api/me/contacts'); statusIs(alice, 200);
  expect(alice.data.contacts).toHaveLength(1001);
  expect(new Set(alice.data.contacts.map((row) => row.id)).size).toBe(1001);
  expect(alice.data.contacts.every((row) => row.user_id === identities.alice)).toBe(true);
  expect(alice.data.contacts.at(-1)).toMatchObject({ id: expected.final_contact.id, name: expected.final_contact.name, category: 'professional' });
  for (const [category, count] of Object.entries(expected.contact_counts)) {
    const filtered = await owner('/api/me/contacts?category=' + category); statusIs(filtered, 200);
    expect(filtered.data.contacts).toHaveLength(count);
    expect(filtered.data.contacts.every((row) => row.category === category)).toBe(true);
  }
  const bob = await other('/api/me/contacts'); statusIs(bob, 200);
  expect(bob.data.contacts).toHaveLength(1);
  expect(bob.data.contacts[0]).toMatchObject({ user_id: identities.bob, name: 'bob contact', notes: 'bob private contact note' });
  statusIs(await owner('/api/me/contacts/' + bob.data.contacts[0].id), 404);
  statusIs(await other('/api/me/contacts/' + expected.final_contact.id), 404);

  const dashboard = await owner('/api/me/dashboard'); statusIs(dashboard, 200);
  expect(dashboard.data).toMatchObject({ contact_counts: expected.contact_counts, is_empty: false, recorded_activity: { total: 0 } });
  expect(dashboard.data.followups.overdue).toHaveLength(2);
  expect(dashboard.data.followups.upcoming).toHaveLength(2);
  expect(dashboard.data.followups.upcoming.some((row) => row.id === expected.final_contact.id)).toBe(true);
  const followups = await owner('/api/me/followups'); statusIs(followups, 200);
  expect(followups.data.overdue).toHaveLength(2); expect(followups.data.upcoming).toHaveLength(2);
  expect([...followups.data.overdue, ...followups.data.upcoming].map((row) => row.id).sort())
    .toEqual(expected.due_contacts.map((row) => row.id).sort());

  for (const target of ['contacts', 'dashboard']) {
    const armed = await arm(target); statusIs(armed, 200);
    const before = armed.data.contact_read_failure.consumed_count;
    expect(armed.data.contact_read_failure.pending_target).toBe(target);
    statusIs(await arm(target), 409);
    // Neither the other API, another owner, nor an unauthenticated request
    // may consume the fault intended for Alice's selected route.
    statusIs(await owner(contactReadTargets[target === 'contacts' ? 'dashboard' : 'contacts']), 200);
    statusIs(await other(contactReadTargets[target]), 200);
    statusIs(await observer(contactReadTargets[target]), 401);
    expect((await fixtureStatus()).contact_read_failure).toMatchObject({ pending_target: target, consumed_count: before });
    const failed = await owner(contactReadTargets[target]); statusIs(failed, 503);
    expect(Object.keys(failed.data)).toEqual(['error']);
    expect(failed.data.error).toMatch(/Complete data could not be loaded/);
    expect((await fixtureStatus()).contact_read_failure).toMatchObject({
      pending_target: null, consumed_count: before + 1,
      last_failure: { target, path: contactReadTargets[target], page: 2, first_page_rows: 100 },
    });
    const retried = await owner(contactReadTargets[target]); statusIs(retried, 200);
    if (target === 'contacts') expect(retried.data.contacts).toHaveLength(1001);
    else expect(retried.data.contact_counts).toEqual(expected.contact_counts);
    expect((await fixtureStatus()).contact_read_failure.consumed_count).toBe(before + 1);
  }
  for (const target of ['followups', '/api/me/contacts', {}, null]) statusIs(await arm(target), 400);
  statusIs(await arm('contacts', { page: 3 }), 400);
  statusIs(await arm('contacts', { sql: 'not accepted' }), 400);
  statusIs(await owner('/__harness/read-failure', mutate('POST', {})), 400);
  statusIs(await owner('/__harness/read-failure', mutate('POST', null)), 400);
  statusIs(await arm('contacts'), 200);
  const empty = await reset('empty'); statusIs(empty, 200);
  expect(empty.data.bulk_expectations).toBeNull();
  expect(empty.data.contact_read_failure).toEqual({ pending_target: null, armed_count: 0, consumed_count: 0, last_failure: null });
  expect((await owner('/api/me/contacts')).data.contacts).toEqual([]);
  expect((await other('/api/me/contacts')).data.contacts).toHaveLength(1);
  const summary = await fixtureStatus();
  expect(summary.external_fetch_attempts).toBe(0); expect(summary.provider_attempts).toBe(0);
  expect(summary.secret_access_attempts).toBe(0); expect(summary.internal_errors).toBe(0);
}
