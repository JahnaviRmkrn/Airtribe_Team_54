import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase } from '../helpers/privacy-db.mjs';
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
vi.mock('next/cache', () => ({ unstable_cache: (load) => load }));
vi.mock('next/headers', () => ({ cookies: () => { throw new Error('No Auth in this fixture'); } }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.admin }));
vi.mock('@/lib/supabase/server', () => ({ userClient: () => { throw new Error('No user client in Traction fixture'); } }));
vi.mock('@/lib/secrets', () => { deps.secretAccessAttempts++; throw new Error('Secret access forbidden'); });
vi.mock('@/lib/pinelabs', () => { deps.providerAttempts++; throw new Error('Payments forbidden'); });
vi.mock('@/lib/live-token', () => { deps.providerAttempts++; throw new Error('Voice forbidden'); });
vi.mock('@supabase/supabase-js', () => { deps.providerAttempts++; throw new Error('Live Supabase SDK forbidden'); });
vi.mock('@supabase/ssr', () => { deps.providerAttempts++; throw new Error('Live Auth forbidden'); });
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

import TractionPage from '../../app/traction/page';

const MODE = process.env.TEAM54_TRACTION_HARNESS_MODE;
const root = new URL('../../', import.meta.url);
const scenarios = ['complete', 'mixed', 'empty', 'zero-cap', 'lookup-error'];
const targets = { attendees: 'meetup_attendees', votes: 'venue_votes', meetups: 'meetups' };
const expected = {
  complete: { joined: 5, shared: 5, completed: 5, rooms: 5, test: 0, seeded: 0, team: 0, unverified: 0 },
  mixed: { joined: 5, shared: 5, completed: 5, rooms: 5, test: 1, seeded: 2, team: 1, unverified: 1 },
  empty: { joined: 0, shared: 0, completed: 0, rooms: 0, test: 0, seeded: 0, team: 0, unverified: 0 },
  'zero-cap': { page: 'load-error', nonempty: true },
  'lookup-error': { joined: 0, shared: 0, completed: 0, rooms: 0, test: 0, seeded: 0, team: 0, unverified: 5 },
};
const sourcePaths = ['app/traction/page.tsx', 'lib/traction-read.ts', 'lib/traction.ts', 'lib/complete-read.ts', 'app/traction/traction.css', 'app/globals.css'];
const assets = new Map([
  ['/traction.css', ['app/traction/traction.css', 'text/css; charset=utf-8']],
  ['/globals.css', ['app/globals.css', 'text/css; charset=utf-8']],
  ['/__harness/', ['tests/local-traction-harness/controls.html', 'text/html; charset=utf-8']],
  ['/__harness/controls.js', ['tests/local-traction-harness/controls.js', 'text/javascript; charset=utf-8']],
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
let db, server, origin, timer, stopResolve, stopPromise, queue = Promise.resolve(), stopped = false;
let scenario = 'complete', resets = 0, renders = 0, sourceHashes = {}, trace = [], lookupCalls = 0;
const failure = { pending_target: null, consumed_count: 0, last_failure: null };
const syntheticUnknown = '99999999-9999-4999-8999-999999999999';
const fixedId = (group, n) => `${group.repeat(8)}-${group.repeat(4)}-4${group.repeat(3)}-8${group.repeat(3)}-${String(n).padStart(12, '0')}`;
const hashes = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')]));

async function reset(nextScenario) {
  if (!scenarios.includes(nextScenario)) throw new Error('Unknown fixed scenario');
  scenario = nextScenario;
  Object.assign(failure, { pending_target: null, consumed_count: 0, last_failure: null });
  trace = []; lookupCalls = 0;
  await db.exec('truncate auth.users cascade; truncate public.venues cascade;');
  await db.query('insert into auth.users (id) values ($1), ($2), ($3)', [identities.alice, identities.bob, syntheticUnknown]);
  await asRole(db, 'service_role', null, async (tx) => {
    await tx.query("insert into venues (id, name, area, activity_types, price_per_person) values ($1, 'Private Synthetic Venue', 'Private Synthetic Area', '{coffee}', 500)", [identities.venue]);
    if (scenario === 'empty') return;
    const rooms = scenario === 'mixed' ? 9 : 5;
    for (let n = 1; n <= rooms; n++) {
      const owner = n === 6 ? identities.bob : n === 9 ? syntheticUnknown : identities.alice;
      await tx.query("insert into meetups (id, organizer_id, title, room_token) values ($1, $2, $3, $4)",
        [fixedId('4', n), owner, 'Private Synthetic Room ' + n, 'private_synthetic_room_token_' + String(n).padStart(3, '0')]);
    }
    const count = scenario === 'mixed' ? 10 : 5;
    for (let n = 1; n <= count; n++) {
      const roomNumber = n <= 7 ? n : n - 1;
      const joined = n === 7 || n === 8 ? '2026-10-24T01:07:15.000Z' : new Date(Date.UTC(2026, 9, 24, 1, n)).toISOString();
      await tx.query(`insert into meetup_attendees (id, meetup_id, guest_name, preferences, availability, secret_hash, joined_at, updated_at)
        values ($1, $2, $3, '{"food":["veg"]}'::jsonb, '[]', 'synthetic-not-a-real-guest-secret', $4, $4)`,
      [fixedId('5', n), fixedId('4', roomNumber), n === 9 ? 'FixtureTeam PrivateName' : 'Private Synthetic Guest ' + n, joined]);
      await tx.query('insert into venue_votes (id, attendee_id, venue_id, created_at, meetup_id) values ($1, $2, $3, $4, $5)',
        [fixedId('6', n), fixedId('5', n), identities.venue, new Date(Date.parse(joined) + 30_000).toISOString(), fixedId('4', roomNumber)]);
    }
  });
  resets++;
}

function fixtureClient() {
  const client = pgliteClient(db, 'service_role', null, { organizerQueries: true, jsonRows: true, maxLimit: 1000,
    allowedTables: Object.values(targets), allowedRpcs: [] });
  const firstPages = new Map();
  return { ...client, auth: { admin: { getUserById: async (id) => {
    lookupCalls++;
    if (![identities.alice, identities.bob, syntheticUnknown].includes(id)) throw new Error('Unexpected synthetic identity lookup');
    if (scenario === 'lookup-error') return { data: null, error: { message: 'Synthetic identity unavailable' } };
    return { data: { user: id === syntheticUnknown ? null : { email: id === identities.bob ? 'private-fixture-test@example.com' : 'private-fixture-owner@people.example.test' } }, error: null };
  } } }, from(table) {
    const query = client.from(table), cap = scenario === 'zero-cap' ? 0 : 2;
    const select = query.select.bind(query), limit = query.limit.bind(query), gt = query.gt.bind(query), then = query.then.bind(query);
    let head = false, cursor = false, executed;
    // Default cap must apply even if a pre-fix caller never requested .limit().
    // For cap0, execute one real SQL row then truncate at the transport boundary.
    limit(Math.max(1, cap));
    query.select = (columns, options) => { head = options?.head === true; return select(columns, options); };
    query.limit = (value) => limit(Math.max(1, Math.min(value, cap)));
    query.gt = (column, value) => { if (column === 'id') cursor = true; return gt(column, value); };
    const execute = async () => {
      if (!head && cursor && targets[failure.pending_target] === table && firstPages.get(table) > 0) {
        failure.last_failure = { target: failure.pending_target, page: 2, first_page_rows: firstPages.get(table) };
        failure.pending_target = null; failure.consumed_count++;
        trace.push({ table, head, cursor, cap, error: true });
        return { data: null, error: { code: 'XX000', message: 'Synthetic later-page failure' } };
      }
      const result = await new Promise((resolve, reject) => then(resolve, reject));
      const output = !head && !result.error && Array.isArray(result.data) ? { ...result, data: result.data.slice(0, cap) } : result;
      if (!head && !cursor && !output.error && Array.isArray(output.data)) firstPages.set(table, output.data.length);
      if (trace.length >= 128) throw new Error('Fixture trace budget exceeded');
      trace.push({ table, head, cursor, cap, rows: Array.isArray(output.data) ? output.data.length : null, count: output.count ?? null, error: !!output.error });
      return output;
    };
    query.then = (resolve, reject) => { executed ??= execute(); return executed.then(resolve, reject); };
    return query;
  } };
}

async function status() {
  const counts = (await asRole(db, 'service_role', null, (tx) => tx.query(`select
    (select count(*)::int from meetup_attendees) as attendees,
    (select count(*)::int from venue_votes) as votes,
    (select count(*)::int from meetups) as meetups`))).rows[0];
  return { mode: 'local-traction-server-component-sql', scenario, expected: expected[scenario], counts, resets, renders,
    cap: scenario === 'zero-cap' ? 0 : 2, read_failure: { ...failure }, last_queries: trace, lookup_calls: lookupCalls,
    source_hashes: sourceHashes, external_fetch_attempts: deps.externalFetchAttempts, provider_attempts: deps.providerAttempts,
    secret_access_attempts: deps.secretAccessAttempts, internal_errors: deps.errorCount,
    live_auth: false, live_postgrest: false, next_cache: false, hydration: false };
}
function respond(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { ...securityHeaders, 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function bodyJSON(req) {
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > 1024) throw new Error('Body too large'); parts.push(part); }
  const value = JSON.parse(Buffer.concat(parts).toString());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
  return value;
}
async function dispatch(req, res) {
  if (stopped) return respond(res, 503, { error: 'Fixture stopped' });
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return respond(res, 403, { error: 'Exact loopback host required' });
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return respond(res, 403, { error: 'Same-origin request required' });
  // Exact raw paths: no query inputs, encoded aliases, traversal or arbitrary URL.
  const path = req.url;
  if (!path?.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('?')) return respond(res, 404, { error: 'Path not allowed' });
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) return respond(res, 403, { error: 'Same-origin mutation required' });
  if (path === '/' && req.method === 'GET') { res.writeHead(302, { ...securityHeaders, location: '/__harness/' }); return res.end(); }
  if (assets.has(path)) {
    if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed' });
    const [file, type] = assets.get(path); return respond(res, 200, readFileSync(new URL(file, root)), type);
  }
  if (path === '/__harness/status' && req.method === 'GET') return respond(res, 200, await status());
  if (['/__harness/reset', '/__harness/read-failure', '/__harness/stop'].includes(path) && req.method === 'POST') {
    let payload; try { payload = await bodyJSON(req); } catch { return respond(res, 400, { error: 'Invalid fixed control body' }); }
    if (path.endsWith('/reset')) {
      if (payload.confirm !== 'reset-traction-fixture' || !scenarios.includes(payload.scenario) || Object.keys(payload).some((key) => !['confirm', 'scenario'].includes(key))) return respond(res, 400, { error: 'Fixed scenario required' });
      await reset(payload.scenario);
    } else if (path.endsWith('/read-failure')) {
      if (payload.confirm !== 'fail-next-traction-page2' || typeof payload.target !== 'string' || !Object.hasOwn(targets, payload.target) || Object.keys(payload).some((key) => !['confirm', 'target'].includes(key))) return respond(res, 400, { error: 'Fixed failure target required' });
      if (!['complete', 'mixed'].includes(scenario) || failure.pending_target) return respond(res, 409, { error: 'Use a capped nonempty scenario and consume/reset any pending fault' });
      failure.pending_target = payload.target;
    } else {
      if (payload.confirm !== 'stop-traction-fixture' || Object.keys(payload).some((key) => key !== 'confirm')) return respond(res, 400, { error: 'Explicit stop required' });
      respond(res, 200, { stopped: true }); setImmediate(stop); return;
    }
    return respond(res, 200, await status());
  }
  if (path !== '/traction' || req.method !== 'GET') return respond(res, 404, { error: 'Not allowed by fixture' });
  trace = []; lookupCalls = 0; deps.admin = fixtureClient(); renders++;
  expect(hashes()).toEqual(sourceHashes);
  const markup = renderToStaticMarkup(await TractionPage());
  // No successful page body is mocked: only a labelled static shell surrounds
  // the actual checked-in server-component output. Errors retain page semantics.
  return respond(res, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local Traction SQL fixture</title><link rel="stylesheet" href="/globals.css"><link rel="stylesheet" href="/traction.css"></head><body><aside><a href="/__harness/">Synthetic fixture controls</a> · Actual server-component SSR; no live Auth, Next cache or hydration.</aside>${markup}</body></html>`, 'text/html; charset=utf-8');
}
function stop() {
  if (stopped) return; stopped = true; clearTimeout(timer);
  server?.close(() => stopResolve?.()); server?.closeAllConnections();
}
function request(path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest(new URL(path, origin), { method, agent: false, headers: {
      ...(method !== 'GET' ? { origin } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers,
    } }, (res) => {
      const parts = []; res.on('data', (part) => parts.push(part)); res.on('end', () => {
        const text = Buffer.concat(parts).toString(); let data; try { data = JSON.parse(text); } catch { /* HTML/CSS. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.once('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Bounded fixture request timeout'))); req.end(payload);
  });
}

beforeAll(async () => {
  if (!['smoke', 'serve'].includes(MODE)) throw new Error('Use the sanitized fixture launcher');
  const forbidden = Object.keys(process.env).filter((key) => /SUPABASE|PINE_|GEMINI|ELEVENLABS|OPENAI|DEEPSEEK|GOOGLE|TOKEN|SECRET|PASSWORD|CREDENTIAL|VAULT|DATABASE_URL/i.test(key));
  expect(forbidden).toEqual([]);
  expect(process.env.TRACTION_SINCE).toBe('2026-10-24T00:00:00Z');
  expect(process.env.TRACTION_TEST_DOMAINS).toBe('example.com'); expect(process.env.TRACTION_TEAM_NAMES).toBe('FixtureTeam');
  expect(process.env.TRACTION_EXCLUDE_ATTENDEES).toBeUndefined();
  vi.spyOn(console, 'error').mockImplementation(() => { deps.errorCount++; });
  db = await privacyDatabase(); await db.exec("set timezone = 'UTC'");
  expect(deps.migrationReads.length).toBeGreaterThan(0); expect(deps.migrationReads.some((name) => /vault|app_secrets/i.test(name))).toBe(false);
  sourceHashes = hashes(); await reset('complete');
  stopPromise = new Promise((resolve) => { stopResolve = resolve; });
  server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    queue = queue.then(() => dispatch(req, res)).catch(() => { deps.errorCount++; if (!res.headersSent) respond(res, 500, { error: 'Fixture internal error' }); else res.end(); });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 16;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(MODE === 'serve' ? 4324 : 0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`; deps.origin = origin;
  timer = setTimeout(stop, 30 * 60 * 1000); process.once('SIGINT', stop); process.once('SIGTERM', stop);
}, 30_000);
afterAll(async () => {
  stop(); if (server) await stopPromise; await queue; await db?.close();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('renders the checked-in Traction server component over capped real service-role SQL with fixed controls and no external access', async () => {
  const post = (path, body) => request('/__harness/' + path, { method: 'POST', body });
  const setScenario = (scenario) => post('reset', { confirm: 'reset-traction-fixture', scenario });
  const arm = (target, extra = {}) => post('read-failure', { confirm: 'fail-next-traction-page2', target, ...extra });
  const info = async () => (await request('/__harness/status')).data;
  const privateFree = (text) => {
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const marker of ['Private Synthetic', 'PrivateName', 'private-fixture-', '@people.example.test', 'private_synthetic_room_token_', 'synthetic-not-a-real-guest-secret', fixedId('4', 5), fixedId('5', 5), identities.alice]) expect(text).not.toContain(marker);
  };
  const page = async () => {
    const result = await request('/traction'); expect(result.status).toBe(200);
    expect(result.headers['content-security-policy']).toBe(securityHeaders['content-security-policy']);
    privateFree(result.text); return result.text;
  };
  const complete = (html) => {
    expect(html).toContain('<h1>5 people planned a meetup with muop</h1>');
    for (const label of ['joined a room', 'shared preferences', 'completed (also voted)', 'rooms with real guests']) expect(html).toContain(`<strong>5</strong><span>${label}</span>`);
    expect(html.match(/<li class="(?:joined|voted)">/g)).toHaveLength(10);
    expect(html).toContain('Guest 5 in room 5'); expect(html).toContain('2026-10-24T01:05:30');
  };
  const errorPage = (html) => {
    expect(html).toContain('load the numbers right now'); expect(html).not.toContain('planned a meetup with muop');
    expect(html).not.toContain('tr-funnel'); expect(html).not.toContain('No guest activity yet today');
  };
  expect(() => globalThis.fetch('https://external.invalid')).toThrow(); expect(deps.externalFetchAttempts).toBe(1); deps.externalFetchAttempts = 0;
  expect(() => httpRequest(new URL('http://external.invalid'))).toThrow(); expect(deps.externalFetchAttempts).toBe(1); deps.externalFetchAttempts = 0;
  expect(() => readFileSync(new URL('.env', root))).toThrow(); expect(deps.secretAccessAttempts).toBe(1); deps.secretAccessAttempts = 0;
  expect(() => readFileSync(new URL('supabase/migrations/20261025090000_app_secrets_vault.sql', root))).toThrow(); expect(deps.secretAccessAttempts).toBe(1); deps.secretAccessAttempts = 0;
  for (const [path, [file]] of assets) {
    const result = await request(path); expect(result.status).toBe(200); expect(result.text).toBe(readFileSync(new URL(file, root), 'utf8'));
  }
  for (const path of ['/.env', '/api/me', '/api/me/integrations/google', '/traction?scenario=empty', '/__harness/../package.json']) expect((await request(path)).status).toBe(404);
  expect((await request('/traction', { headers: { host: 'external.invalid' } })).status).toBe(403);
  expect((await request('/traction', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  expect((await request('/__harness/reset', { method: 'POST', headers: { origin: 'https://external.invalid' }, body: { confirm: 'reset-traction-fixture', scenario: 'complete' } })).status).toBe(403);
  for (const body of [null, {}, [], { confirm: 'reset-traction-fixture', scenario: 'arbitrary' }, { confirm: 'reset-traction-fixture', scenario: 'complete', count: 6 }]) expect((await post('reset', body)).status).toBe(400);
  for (const target of ['arbitrary', '/api/rooms', null, {}]) expect((await arm(target)).status).toBe(400);
  expect((await arm('attendees', { sql: 'not allowed' })).status).toBe(400);
  expect((await arm('attendees', { page: 3 })).status).toBe(400);
  complete(await page());
  const baseline = await info();
  expect(baseline.counts).toEqual({ attendees: 5, votes: 5, meetups: 5 }); expect(baseline.lookup_calls).toBe(1);
  for (const table of Object.values(targets)) {
    const queries = baseline.last_queries.filter((q) => q.table === table);
    expect(queries.filter((q) => !q.head).map((q) => q.rows)).toEqual([2, 2, 1, 0]);
    expect(queries.at(-1)).toMatchObject({ head: true, count: 0, cursor: true });
  }
  // Independent uncapped SQL baseline: this page is derived from all five rows,
  // not successful fake page/API bodies or a synthetic ledger return value.
  const direct = (await asRole(db, 'service_role', null, (tx) => tx.query('select count(*)::int as n from meetup_attendees'))).rows[0].n;
  expect(direct).toBe(5);

  expect((await setScenario('mixed')).status).toBe(200);
  const mixed = await page(); complete(mixed);
  expect(mixed).toContain('1 visit is excluded because the room or organizer could not be verified; totals may be incomplete.');
  expect(mixed.indexOf('totals may be incomplete')).toBeLessThan(mixed.indexOf('<h1>'));
  expect(mixed).toContain('Not counted: 1 test visit, 2 seeded demo guests and 1 by our own team.');
  expect((await info()).counts).toEqual({ attendees: 10, votes: 10, meetups: 9 });
  expect((await info()).lookup_calls).toBe(3);

  for (const target of Object.keys(targets)) {
    expect((await setScenario('complete')).status).toBe(200);
    expect((await arm(target)).status).toBe(200); expect((await arm(target)).status).toBe(409);
    await request('/traction.css'); expect((await info()).read_failure.pending_target).toBe(target);
    errorPage(await page());
    const failed = await info();
    expect(failed.read_failure).toEqual({ pending_target: null, consumed_count: 1, last_failure: { target, page: 2, first_page_rows: 2 } });
    expect(failed.last_queries.some((q) => q.table === targets[target] && q.cursor && q.error)).toBe(true);
    expect(failed.lookup_calls).toBe(0);
    complete(await page()); expect((await info()).read_failure.consumed_count).toBe(1);
  }

  expect((await setScenario('zero-cap')).status).toBe(200); errorPage(await page());
  const zero = await info(); expect(zero.counts.attendees).toBe(5); expect(zero.lookup_calls).toBe(0);
  expect(zero.last_queries.some((q) => q.head && q.count === 5)).toBe(true);
  expect((await arm('attendees')).status).toBe(409);
  expect((await setScenario('empty')).status).toBe(200);
  const empty = await page(); expect(empty).toContain('<h1>0 people planned a meetup with muop</h1>'); expect(empty).toContain('No guest activity yet today.');
  expect(empty).not.toContain('load the numbers right now'); expect(empty).not.toContain('could not be verified');
  const emptyInfo = await info(); expect(emptyInfo.counts).toEqual({ attendees: 0, votes: 0, meetups: 0 }); expect(emptyInfo.lookup_calls).toBe(0);
  expect(emptyInfo.last_queries.filter((q) => q.head).map((q) => q.count)).toEqual([0, 0]);
  expect((await setScenario('lookup-error')).status).toBe(200);
  const unknown = await page(); expect(unknown).toContain('5 visits are excluded because the room or organizer could not be verified');
  expect(unknown).toContain('<h1>0 people planned a meetup with muop</h1>'); expect(unknown).not.toContain('load the numbers right now');
  expect((await info()).last_queries.every((q) => !q.error)).toBe(true); expect((await info()).lookup_calls).toBe(1);
  expect((await setScenario('complete')).status).toBe(200); expect((await arm('meetups')).status).toBe(200);
  expect((await setScenario('complete')).status).toBe(200); complete(await page());
  const clean = await info(); expect(clean.read_failure).toEqual({ pending_target: null, consumed_count: 0, last_failure: null });
  for (const name of ['external_fetch_attempts', 'provider_attempts', 'secret_access_attempts', 'internal_errors']) expect(clean[name]).toBe(0);
  expect(clean.source_hashes).toEqual(hashes()); privateFree(JSON.stringify(clean));
  await setScenario('complete');
  if (MODE === 'serve') {
    console.log(`LOCAL_TRACTION_HARNESS_READY ${origin}/__harness/ (30 minute maximum; synthetic service-role SQL; no live Auth/cache/hydration)`);
    await stopPromise;
    expect(deps.externalFetchAttempts).toBe(0); expect(deps.providerAttempts).toBe(0); expect(deps.secretAccessAttempts).toBe(0);
  } else {
    expect((await post('stop', { confirm: 'stop-traction-fixture' })).status).toBe(200); await stopPromise;
    console.log('LOCAL_TRACTION_HARNESS_SMOKE_OK: actual page/read/ledger, real capped service-role SQL, exact empty verification, exclusions, failures/recovery, privacy and zero guards; listener stopped.');
  }
});
