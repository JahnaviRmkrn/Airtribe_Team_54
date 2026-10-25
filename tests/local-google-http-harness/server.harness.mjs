import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const value = { context: null, client: null, send: null, origin: 'http://127.0.0.1:4323', blocked: 0, secretReads: 0,
    calls: [], rpcs: [], loseRpc: null, loseFinish: false, fault: null, faultsConsumed: 0, errors: 0, migrations: [] };
  vi.stubGlobal('fetch', (...args) => {
    if (!value.send) { value.blocked++; throw new Error('External transport forbidden'); }
    return value.send(...args);
  });
  return value;
});
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => state.context().cookies }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => state.client(true) }));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => state.client(false) }));
vi.mock('@supabase/supabase-js', () => { state.blocked++; throw new Error('Live Supabase forbidden'); });
vi.mock('@supabase/ssr', () => { state.blocked++; throw new Error('Live Auth forbidden'); });
vi.mock('@/lib/secrets', () => { state.secretReads++; throw new Error('Secret access forbidden'); });
vi.mock('@plural_pinelabs/agent-toolkit/shared', () => { state.blocked++; throw new Error('Payment providers forbidden'); });
vi.mock('node:http', async original => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('Only fixed fixture loopback HTTP allowed'); };
  const guard = name => (target, ...args) => {
    if (!(target instanceof URL) || target.origin !== state.origin || target.hostname !== '127.0.0.1' || target.username || target.password) return deny();
    // Node request(URL, options) allows options to override the URL. Permit
    // only our fixed client shape, never hostname/port/path/socketPath/lookup,
    // custom agents, createConnection or other destination/transport overrides.
    const [options, callback] = args;
    if (args.length !== 2 || !options || typeof options !== 'object' || Array.isArray(options)
      || options.agent !== false || typeof callback !== 'function'
      || Object.keys(options).some(key => !['method', 'agent', 'headers'].includes(key))) return deny();
    return loaded[name](target, options, callback);
  };
  let servers = 0;
  const guarded = { request: guard('request'), get: guard('get'), createServer: (...args) => {
    if (++servers !== 1) return deny();
    const server = loaded.createServer(...args), listen = server.listen;
    server.listen = (port, host, ...rest) => port === 4323 && host === '127.0.0.1' ? listen.call(server, port, host, ...rest) : deny();
    return server;
  } };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:https', async original => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('HTTPS transport/server forbidden'); };
  const guarded = { request: deny, get: deny, createServer: deny };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:net', async original => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('Socket transport/server forbidden'); };
  class Socket extends loaded.Socket { connect() { return deny(); } }
  const guarded = { Socket, connect: deny, createConnection: deny, createServer: deny };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:tls', async original => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('TLS transport/server forbidden'); };
  class TLSSocket extends loaded.TLSSocket { connect() { return deny(); } }
  const guarded = { TLSSocket, connect: deny, createServer: deny };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:fs', async original => {
  const loaded = await original();
  const check = path => {
    if (/(^|[/\\])\.env|vault|app_secrets|authconfig|credential/i.test(String(path))) {
      state.secretReads++; throw new Error('Environment/Vault/credential file access forbidden');
    }
    if (String(path).endsWith('.sql')) state.migrations.push(String(path).split('/').pop());
  };
  const guarded = { readFileSync(path, ...args) { check(path); return loaded.readFileSync(path, ...args); },
    readFile(path, ...args) { check(path); return loaded.readFile(path, ...args); } };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:fs/promises', async original => {
  const loaded = await original();
  const readFile = (path, ...args) => {
    if (/(^|[/\\])\.env|vault|app_secrets|authconfig|credential/i.test(String(path))) { state.secretReads++; throw new Error('Environment/Vault/credential file access forbidden'); }
    return loaded.readFile(path, ...args);
  };
  return { ...loaded, readFile, default: { ...loaded.default, readFile } };
});

import { identities } from '../helpers/privacy-db.mjs';
import { pgliteClient } from '../helpers/pglite-client.mjs';
import { googleDatabase, googleClient, resetDatabase } from '../local-google-harness/database.mjs';
import { providerFixture, purposes, bookId, drafts } from './provider.mjs';
import { checkNavigationAdapter } from './navigation-checks.mjs';
import { GET as getProfile } from '../../app/api/me/route';
import { GET as getDashboard } from '../../app/api/me/dashboard/route';
import { GET as getContacts } from '../../app/api/me/contacts/route';
import { GET as getContact } from '../../app/api/me/contacts/[id]/route';

const modules = import.meta.glob('../../app/api/me/integrations/google/**/route.ts', { eager: true });
const routes = new Map(Object.entries(modules).map(([path, module]) => [path.split('/google/')[1].replace('/route.ts', ''), module]));
const MODE = process.env.TEAM54_GOOGLE_HTTP_MODE;
const origin = 'http://127.0.0.1:4323';
const root = new URL('../../', import.meta.url);
const googleRoot = '/api/me/integrations/google/';
const storage = new AsyncLocalStorage();
const startPath = purpose => purpose === 'contacts' ? 'contacts/start' : purpose.startsWith('sheets-') ? `${purpose}/connect` : purpose;
const statusPath = purpose => purpose.startsWith('sheets-') ? `${purpose}/status` : purpose;
const faultTargets = ['contacts-import', 'sheets-import', 'sheets-create', 'sheets-write', 'gmail', 'calendar'];
const roleName = '__google_http_fixture_role';
const assets = new Map([
  ...['index.html', 'styles.css', 'voice.css', 'google-actions.css', 'assistant.js', 'live.js', 'plan-voice.js', 'voice.js', 'google-contacts.js', 'google-actions.js', 'app.js', 'desktop.js'].map(file => [
    '/organizer/' + file, ['public/organizer/' + file, file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript'],
  ]),
  ['/organizer/', ['public/organizer/index.html', 'text/html']],
  ['/product-analytics.js', ['public/product-analytics.js', 'text/javascript']],
  ['/muop-mark.svg', ['public/muop-mark.svg', 'image/svg+xml']],
  ['/integrations/google-sheets', ['tests/local-google-http-harness/sheets.html', 'text/html']],
  ['/__harness/sheets.css', ['app/integrations/google-sheets/sheets.css', 'text/css']],
  ['/__harness/', ['tests/local-google-http-harness/controls.html', 'text/html']],
  ['/__harness/controls.js', ['tests/local-google-http-harness/controls.js', 'text/javascript']],
  ['/__harness/navigation-guard.js', ['tests/local-google-http-harness/navigation-guard.js', 'text/javascript']],
]);
const securityHeaders = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'x-dns-prefetch-control': 'off', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store',
};
let db, seeded, provider, server, timer, resolveStop, stopPromise, bundle, bundleDir;
let stopped = false, queue = Promise.resolve(), requests = 0, resets = 0;
const sourceHashes = {};
const digest = value => createHash('sha256').update(value).digest('hex');
// Response-only safety adapter. Source HTML/JS/CSS files are never rewritten.
const safetyScript = '<script src="/__harness/navigation-guard.js"></script>';
const htmlResponse = bytes => bytes.toString().replace(/<head>/i, '<head>' + safetyScript);
const recordSource = file => {
  const bytes = readFileSync(new URL(file, root));
  sourceHashes[file] = digest(bytes); return bytes;
};
function cookieHeader(name, value, options = {}) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`, 'HttpOnly', 'SameSite=Lax',
    Number.isInteger(options.maxAge) ? `Max-Age=${options.maxAge}` : '', options.secure ? 'Secure' : ''].filter(Boolean).join('; ');
}
function requestContext(req) {
  const values = new Map();
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) try { values.set(pair.slice(0, i).trim(), decodeURIComponent(pair.slice(i + 1))); } catch { /* Ignore malformed values. */ }
  }
  const role = ['owner', 'other'].includes(values.get(roleName)) ? values.get(roleName) : 'observer';
  const ctx = { role, owner: role === 'owner' ? identities.alice : role === 'other' ? identities.bob : null, values, writes: [], steps: [], cookies: {
    get: name => values.has(name) ? { value: values.get(name) } : undefined,
    set: (name, value, options = {}) => {
      if (name !== roleName && !purposes.some(purpose => name === `moup_google_${purpose}` && options.path === googleRoot + purpose)) throw new Error('Unexpected cookie write');
      if (options.maxAge === 0) values.delete(name); else values.set(name, value);
      ctx.writes.push(cookieHeader(name, value, options));
    },
  } };
  return ctx;
}
function respond(res, code, data, ctx, type = 'application/json', headers = {}) {
  res.writeHead(code, { ...securityHeaders, ...headers, 'content-type': type + (type.startsWith('text/') || type === 'application/json' ? '; charset=utf-8' : ''), ...(ctx?.writes.length ? { 'set-cookie': ctx.writes } : {}) });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
async function bodyBytes(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100_000) throw new Error('Body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const exact = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
async function reset(ctx) {
  seeded = await resetDatabase(db); provider.reset();
  state.calls = []; state.rpcs = []; state.loseRpc = null; state.loseFinish = false; state.fault = null; state.faultsConsumed = 0;
  if (ctx) for (const purpose of purposes) ctx.cookies.set(`moup_google_${purpose}`, '', { path: googleRoot + purpose, maxAge: 0 });
  resets++;
}
async function snapshot(ctx) {
  const counts = (await db.query(`select
    (select count(*)::int from contacts where user_id=$1) as alice_contacts,
    (select count(*)::int from contacts where user_id=$2) as bob_contacts,
    (select count(*)::int from google_connector_sessions) as sessions`, [identities.alice, identities.bob])).rows[0];
  const actions = (await db.query('select purpose,state,count(*)::int as count from google_confirmed_actions group by purpose,state order by purpose,state')).rows;
  return { fixture: 'synthetic-google-real-http-routes-pglite', role: ctx.role, ...counts, actions,
    provider_calls: [...state.calls], rpc_counts: Object.fromEntries([...new Set(state.rpcs)].map(name => [name, state.rpcs.filter(value => value === name).length])),
    pending_fault: state.fault, faults_consumed: state.faultsConsumed, requests, resets,
    external_transport_attempts: state.blocked, secret_access_attempts: state.secretReads, internal_errors: state.errors,
    source_sha256: sourceHashes, sheets_bundle_sha256: digest(bundle),
    real_google_consent: false, live_google: false, live_auth: false, live_postgrest: false, next_hydration: false, html_response_adapter: 'prepended fixture-only navigation-guard.js; source HTML unchanged',
  };
}
async function invoke(ctx, route, method, body, query = '') {
  const handler = routes.get(route)?.[method];
  if (!handler) throw new Error('Unexpected fixture route');
  ctx.routePath = googleRoot + route;
  ctx.steps = method === 'POST' || route.endsWith('/callback') ? await provider.plan(ctx, route, body) : [];
  const importFault = route === 'contacts/import' ? 'contacts-import' : route === 'sheets-import/confirm' ? 'sheets-import' : null;
  if (importFault && state.fault === importFault) state.loseRpc = 'import_google_contacts';
  const request = new Request(origin + googleRoot + route + query, {
    method, headers: ctx.forwardHeaders || { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const response = await storage.run(ctx, () => handler(request));
  if (importFault && state.fault === importFault && state.loseRpc === null) { state.fault = null; state.faultsConsumed++; }
  state.loseRpc = null;
  // Invalid/replayed requests may legitimately consume none of their potential
  // plan. A successful provider-facing operation must consume its full sequence.
  if (response.ok && ctx.steps.length && !['sheets-export/confirm', 'gmail', 'calendar'].includes(route)) throw new Error('Incomplete successful provider plan');
  ctx.steps = [];
  return response;
}
async function connectSynthetic(ctx, purpose) {
  if (!ctx.owner) return { status: 401, body: { error: 'Choose a synthetic owner first' } };
  const start = await invoke(ctx, startPath(purpose), 'POST', ['gmail', 'calendar'].includes(purpose) ? { operation: 'start' } : {});
  const data = await start.json();
  if (!start.ok) return { status: start.status, body: data };
  const consent = new URL(data.authorization_url || data.authorizationUrl || data.url);
  if (consent.origin !== 'https://accounts.google.com' || consent.pathname !== '/o/oauth2/v2/auth') throw new Error('Unexpected synthetic consent destination');
  ctx.syntheticCallback = true;
  const response = await invoke(ctx, `${purpose}/callback`, 'GET', undefined, `?state=${encodeURIComponent(consent.searchParams.get('state'))}&code=synthetic-code`);
  ctx.syntheticCallback = false;
  if (response.status !== 303 || (await provider.session(ctx, purpose))?.payload.phase !== 'ready') throw new Error('Synthetic callback did not become ready');
  return { status: 200, body: await snapshot(ctx) };
}
async function dispatch(req, res) {
  requests++;
  const ctx = requestContext(req);
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== '127.0.0.1:4323') return respond(res, 403, { error: 'Exact loopback Host required' });
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return respond(res, 403, { error: 'Same-origin request required' });
  if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return respond(res, 404, { error: 'Target not allowed' });
  const url = new URL(req.url, origin), path = url.pathname;
  const mutating = !['GET', 'HEAD'].includes(req.method);
  if (mutating && req.headers.origin !== origin) return respond(res, 403, { error: 'Same-origin mutation required' });
  if (req.method === 'GET' && ['/', '/__harness', '/organizer'].includes(path)) return respond(res, 302, '', ctx, 'text/plain', { location: path === '/organizer' ? '/organizer/' : '/__harness/' });
  if (assets.has(path) || path === '/__harness/sheets-client.js') {
    if (req.method !== 'GET' || (path.startsWith('/__harness/') && url.search)) return respond(res, 405, { error: 'Static GET only' });
    if (path === '/__harness/sheets-client.js') return respond(res, 200, bundle, ctx, 'text/javascript');
    const [file, type] = assets.get(path), bytes = readFileSync(new URL(file, root));
    return respond(res, 200, type === 'text/html' ? htmlResponse(bytes) : bytes, ctx, type);
  }
  if (path.startsWith('/__harness/')) {
    if (url.search) return respond(res, 400, { error: 'Control queries forbidden' });
    if (path === '/__harness/status' && req.method === 'GET') return respond(res, 200, await snapshot(ctx), ctx);
    if (!['/__harness/role', '/__harness/connect', '/__harness/fault', '/__harness/reset', '/__harness/stop'].includes(path)) return respond(res, 404, { error: 'Unknown control' });
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return respond(res, 405, { error: 'JSON POST required' });
    let body; try { body = JSON.parse(await bodyBytes(req)); } catch { return respond(res, 400, { error: 'Invalid control body' }); }
    if (path.endsWith('/role')) {
      if (!exact(body, ['role']) || !['owner', 'other', 'observer'].includes(body.role)) return respond(res, 400, { error: 'Fixed role required' });
      ctx.role = body.role; ctx.owner = body.role === 'owner' ? identities.alice : body.role === 'other' ? identities.bob : null; ctx.cookies.set(roleName, body.role);
    } else if (path.endsWith('/connect')) {
      if (!exact(body, ['purpose', 'confirm']) || !purposes.includes(body.purpose) || body.confirm !== 'install-synthetic-not-real-consent') return respond(res, 400, { error: 'Explicit synthetic connection required' });
      const result = await connectSynthetic(ctx, body.purpose); return respond(res, result.status, result.body, ctx);
    } else if (path.endsWith('/fault')) {
      if (!exact(body, ['target', 'confirm']) || !faultTargets.includes(body.target) || body.confirm !== 'arm-one-synthetic-fault') return respond(res, 400, { error: 'Fixed fault target required' });
      if (state.fault) return respond(res, 409, { error: 'Consume the armed fault or reset first' });
      state.fault = body.target;
    } else if (path.endsWith('/reset')) {
      if (!exact(body, ['confirm']) || body.confirm !== 'reset-local-fixture') return respond(res, 400, { error: 'Explicit reset required' });
      await reset(ctx);
    } else {
      if (!exact(body, ['confirm']) || body.confirm !== 'stop-local-fixture') return respond(res, 400, { error: 'Explicit stop required' });
      respond(res, 200, { stopped: true }, ctx); setImmediate(stop); return;
    }
    return respond(res, 200, await snapshot(ctx), ctx);
  }
  let bytes; try { bytes = mutating ? await bodyBytes(req) : undefined; } catch { return respond(res, 413, { error: 'Body too large' }); }
  ctx.forwardHeaders = new Headers();
  for (const header of ['origin', 'content-type', 'x-contact-owner', 'sec-fetch-site']) if (req.headers[header]) ctx.forwardHeaders.set(header, req.headers[header]);
  let response;
  if (path.startsWith(googleRoot)) {
    const route = path.slice(googleRoot.length), handler = routes.get(route)?.[req.method];
    if (!handler) return respond(res, routes.has(route) ? 405 : 404, { error: 'Route/method not allowed' });
    let body; try { body = bytes?.length ? JSON.parse(bytes) : undefined; } catch { body = bytes.toString(); }
    // Never give a browser an authorization URL or expose callback injection.
    // The visible fixed control invokes these exact exports internally instead.
    if (route.endsWith('/start') || route.endsWith('/connect') || route.endsWith('/callback') || body?.operation === 'start') return respond(res, 409, { error: 'Real consent is disabled. Use /__harness/ to install a fixed synthetic test connection.' });
    if (route === 'sheets-import/source' && body?.spreadsheetId && body.spreadsheetId !== bookId) return respond(res, 400, { error: 'Only the documented synthetic spreadsheet is available' });
    if (route === 'gmail' && body?.operation === 'preview' && (body.draft?.from !== 'sender@example.test' || JSON.stringify(body.draft?.to) !== '["recipient@example.test"]')) return respond(res, 400, { error: 'Use only the documented synthetic sender and recipient' });
    if (route === 'calendar' && body?.operation === 'preview' && Array.isArray(body.draft?.attendees) && body.draft.attendees.some(email => email !== 'recipient@example.test')) return respond(res, 400, { error: 'Use only the documented synthetic attendee' });
    response = await invoke(ctx, route, req.method, body, url.search);
  } else {
    const contact = path.match(/^\/api\/me\/contacts\/([0-9a-f-]{36})$/);
    const handler = new Map([['/api/me', getProfile], ['/api/me/dashboard', getDashboard], ['/api/me/contacts', getContacts]]).get(path) || (contact && getContact);
    if (!handler || req.method !== 'GET') return respond(res, 404, { error: 'Non-Google write, live auth, payment, voice and unrelated endpoints disabled' });
    ctx.routePath = path;
    response = await storage.run(ctx, () => handler(new Request(url, { headers: ctx.forwardHeaders }), { params: Promise.resolve({ id: contact?.[1] }) }));
  }
  const location = response.headers.get('location');
  if (location && new URL(location, origin).origin !== origin) throw new Error('External redirect blocked');
  return respond(res, response.status, Buffer.from(await response.arrayBuffer()), ctx, response.headers.get('content-type')?.split(';')[0] || 'application/json', location ? { location } : {});
}
function stop() {
  if (stopped) return;
  stopped = true; clearTimeout(timer);
  if (!server?.listening) resolveStop?.();
  else { server.close(() => resolveStop?.()); server.closeAllConnections(); }
}

// Path-aware HTTP cookie jars model browser ownership/purpose boundaries. They
// intentionally expose no token values in output and cannot contact other hosts.
function client() {
  const jar = new Map();
  const send = async (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const cookies = [...jar].filter(([, value]) => new URL(path, origin).pathname === value.path || new URL(path, origin).pathname.startsWith(value.path.endsWith('/') ? value.path : value.path + '/')).map(([name, value]) => `${name}=${value.value}`);
    const request = httpRequest(new URL(path, origin), { method, agent: false, headers: {
      ...(cookies.length ? { cookie: cookies.join('; ') } : {}), ...(method !== 'GET' ? { origin } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers,
    } }, response => {
      for (const header of response.headers['set-cookie'] || []) {
        const [pair] = header.split(';'), i = pair.indexOf('='), name = pair.slice(0, i);
        if (/max-age=0/i.test(header)) jar.delete(name);
        else jar.set(name, { value: pair.slice(i + 1), path: /(?:^|;)\s*Path=([^;]+)/i.exec(header)?.[1] || '/' });
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let data;
        try { data = JSON.parse(text); } catch { /* Static response. */ }
        resolve({ status: response.statusCode, headers: response.headers, text, data });
      });
    });
    request.once('error', reject); request.setTimeout(5000, () => request.destroy(new Error('Local HTTP timeout'))); request.end(payload);
  });
  send.jar = jar; return send;
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test' || !['smoke', 'serve'].includes(MODE)) throw new Error('Use the clean test-only launcher');
  const forbidden = Object.keys(process.env).filter(key => /SUPABASE|PINE_|GEMINI|ELEVENLABS|OPENAI|DEEPSEEK|TOKEN|SECRET|PASSWORD|CREDENTIAL|VAULT|DATABASE_URL|^GOOGLE_/i.test(key));
  expect(forbidden.length, 'Inherited credential-like environment names are forbidden').toBe(0);
  vi.spyOn(console, 'error').mockImplementation(() => { state.errors++; });
  db = await googleDatabase();
  expect(state.migrations.length).toBeGreaterThan(0);
  expect(state.migrations.some(name => /vault|app_secrets/i.test(name))).toBe(false);
  for (const prefix of ['CONTACTS', 'SHEETS', 'GMAIL', 'CALENDAR']) {
    vi.stubEnv(`GOOGLE_${prefix}_CLIENT_ID`, 'synthetic-client-id'); vi.stubEnv(`GOOGLE_${prefix}_CLIENT_SECRET`, 'synthetic-client-secret');
  }
  vi.stubEnv('GOOGLE_GMAIL_ENABLED', 'true'); vi.stubEnv('GOOGLE_CALENDAR_ENABLED', 'true');
  vi.stubEnv('GOOGLE_CONNECTOR_ORIGIN', origin); vi.stubEnv('GOOGLE_CONNECTOR_ENCRYPTION_KEY', Buffer.alloc(32, 23).toString('base64'));
  state.context = () => storage.getStore();
  state.client = admin => {
    const ctx = storage.getStore(), owner = ctx?.owner || null;
    if (admin || ctx?.routePath?.startsWith(googleRoot)) return googleClient(db, owner, state, admin);
    return pgliteClient(db, owner ? 'authenticated' : 'anon', owner, { organizerQueries: true, jsonRows: true, allowedTables: ['contacts', 'balance_goals', 'interactions', 'meetups'], allowedRpcs: [] });
  };
  provider = providerFixture(db, state, () => storage.getStore()); state.send = provider.send;
  await reset();
  for (const [file] of assets.values()) recordSource(file);
  recordSource('app/integrations/google-sheets/SheetsClient.tsx'); recordSource('lib/google/sheets-data.ts');
  bundleDir = mkdtempSync(`${tmpdir()}/team54-sheets-disposable-`);
  const require = createRequire(import.meta.url);
  const vite = await import(require.resolve('vite', { paths: [dirname(require.resolve('vitest/package.json'))] }));
  const result = await vite.build({
    configFile: false, root: fileURLToPath(root), envDir: bundleDir, logLevel: 'silent',
    resolve: { alias: { '@': fileURLToPath(root), 'next/link': fileURLToPath(new URL('link-adapter.jsx', import.meta.url)) } },
    // The launcher must stay NODE_ENV=test for its safety guards, but the
    // browser bundle uses production React. Pin OXC's JSX runtime consistently.
    oxc: { jsx: { runtime: 'automatic', development: false } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { write: false, outDir: bundleDir, minify: false, sourcemap: false, lib: { entry: fileURLToPath(new URL('sheets-entry.jsx', import.meta.url)), formats: ['es'], fileName: 'sheets-client' } },
  });
  const output = Array.isArray(result) ? result.flatMap(value => value.output) : result.output;
  expect(output.length).toBe(1); expect(output[0].type).toBe('chunk'); bundle = output[0].code;
  expect(bundle.length).toBeGreaterThan(10000);
  // Catch a dev JSX transform paired with production React before browser QA.
  expect(bundle).not.toMatch(/\bjsxDEV\b/);
  expect(digest(readFileSync(new URL('app/integrations/google-sheets/SheetsClient.tsx', root)))).toBe(sourceHashes['app/integrations/google-sheets/SheetsClient.tsx']);
  stopPromise = new Promise(resolve => { resolveStop = resolve; });
  server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    queue = queue.then(() => dispatch(req, res)).catch(() => {
      state.errors++; if (!res.headersSent) respond(res, 500, { error: 'Local fixture internal error' }); else res.end();
    });
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4323, '127.0.0.1', resolve); });
  timer = setTimeout(stop, 30 * 60 * 1000); process.once('SIGINT', stop); process.once('SIGTERM', stop);
}, 60_000);

afterAll(async () => {
  stop(); if (stopPromise) await stopPromise; await queue;
  if (db) { await db.close(); db = null; }
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }); bundle = null;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it('joins unchanged Google UIs, actual HTTP exports, encrypted SQL and strictly ordered synthetic provider requests', async () => {
  const owner = client(), other = client(), observer = client();
  const post = (client, path, body) => client(path, { method: 'POST', body });
  const google = (client, route, body, options = {}) => client(googleRoot + route, { ...(body === undefined ? {} : { method: 'POST', body }), ...options });
  const statusIs = (response, status) => { expect(response.status).toBe(status); return response.data; };
  const connect = async (client, purpose) => statusIs(await post(client, '/__harness/connect', { purpose, confirm: 'install-synthetic-not-real-consent' }), 200);
  const arm = async target => statusIs(await post(owner, '/__harness/fault', { target, confirm: 'arm-one-synthetic-fault' }), 200);
  const counts = async () => statusIs(await owner('/__harness/status'), 200);
  const calls = label => state.calls.filter(value => value === label).length;
  const confirm = action => ({ operation: 'confirm', id: action.id, previewHash: action.previewHash, confirmed: true, senderAcknowledged: true });
  const actionPreview = async purpose => statusIs(await google(owner, purpose, { operation: 'preview', draft: drafts[purpose] }), 200).action;
  const resetOwner = async () => statusIs(await post(owner, '/__harness/reset', { confirm: 'reset-local-fixture' }), 200);

  // Explicit guard probes throw before opening a file or attempting a transport.
  await expect(fetch('https://unmatched.example.test')).rejects.toThrow('forbidden');
  const http = await import('node:http'), https = await import('node:https');
  const net = await import('node:net'), tls = await import('node:tls');
  for (const transport of [http, http.default]) expect(() => transport.request(new URL('http://127.0.0.1:4324/'))).toThrow('fixed fixture');
  for (const transport of [http, http.default]) for (const method of ['request', 'get']) {
    for (const overrides of [{ hostname: 'example.test' }, { port: 443 }, { socketPath: '/not-opened/socket' }, { createConnection: () => {} }, { agent: {} }]) {
      expect(() => transport[method](new URL(origin + '/__harness/status'), { method: 'GET', headers: {}, agent: false, ...overrides }, () => {})).toThrow('fixed fixture');
    }
  }
  for (const transport of [https, https.default]) expect(() => transport.request('https://example.test')).toThrow('forbidden');
  for (const transport of [net, net.default, tls, tls.default]) expect(() => transport.connect({ host: 'example.test', port: 443 })).toThrow('forbidden');
  const socket = new net.Socket();
  try { expect(() => socket.connect(443, 'example.test')).toThrow('forbidden'); } finally { socket.destroy(); }
  expect(() => readFileSync('/not-opened/.env.local')).toThrow('forbidden');
  expect(() => readFileSync('/not-opened/supabase/migrations/20261025090000_app_secrets_vault.sql')).toThrow('forbidden');
  const fsPromises = await import('node:fs/promises');
  expect(() => fsPromises.readFile('/not-opened/authconfig')).toThrow('forbidden');
  expect(state.blocked).toBe(30); expect(state.secretReads).toBe(3);
  state.blocked = 0; state.secretReads = 0;

  checkNavigationAdapter(readFileSync(new URL('navigation-guard.js', import.meta.url), 'utf8'));
  for (const [url, [file, type]] of assets) {
    const result = await observer(url); statusIs(result, 200);
    const source = readFileSync(new URL(file, root));
    expect(result.text).toBe(type === 'text/html' ? htmlResponse(source) : source.toString());
    if (type === 'text/html') expect(result.text.startsWith(source.toString().slice(0, source.toString().indexOf('<head>') + 6) + safetyScript)).toBe(true);
    expect(result.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(result.headers['permissions-policy']).toContain('microphone=()');
  }
  expect((await observer('/__harness/sheets-client.js')).text).toBe(bundle);
  for (const path of ['/.env', '/supabase/migrations/20261025090000_app_secrets_vault.sql', '/__harness/arbitrary', '/api/extract', '/api/voice/live-token', '/api/me/password', '/auth/signout']) statusIs(await observer(path), 404);
  statusIs(await observer('/__harness/status', { headers: { host: 'external.invalid' } }), 403);
  statusIs(await observer('/__harness/status', { headers: { 'sec-fetch-site': 'cross-site' } }), 403);
  statusIs(await observer('/__harness/status?sql=select'), 400);
  statusIs(await post(observer, '/__harness/role', { role: 'owner', identity: identities.bob }), 400);
  statusIs(await post(observer, '/__harness/connect', { purpose: 'contacts', confirm: 'install-synthetic-not-real-consent', url: 'https://example.test' }), 400);
  statusIs(await post(observer, '/__harness/fault', { target: 'unknown', confirm: 'arm-one-synthetic-fault' }), 400);
  statusIs(await owner('/__harness/reset', { method: 'POST', body: { confirm: 'reset-local-fixture' }, headers: { origin: 'https://foreign.example.test' } }), 403);
  for (const purpose of purposes) statusIs(await google(observer, statusPath(purpose)), 401);
  statusIs(await post(owner, '/__harness/role', { role: 'owner' }), 200);
  statusIs(await post(other, '/__harness/role', { role: 'other' }), 200);
  statusIs(await owner('/api/me'), 200); statusIs(await owner('/api/me/dashboard'), 200);
  expect(statusIs(await owner('/api/me/contacts'), 200).contacts.map(row => row.name)).toEqual(['alice contact']);
  expect(statusIs(await other('/api/me/contacts'), 200).contacts.map(row => row.name)).toEqual(['bob contact']);

  for (const purpose of purposes) {
    statusIs(await google(owner, statusPath(purpose), undefined, { headers: { 'x-contact-owner': identities.bob } }), 409);
    const connected = await connect(owner, purpose);
    expect(connected.real_google_consent).toBe(false);
    const cookie = owner.jar.get(`moup_google_${purpose}`);
    expect(cookie.path).toBe(googleRoot + purpose);
    expect(cookie.value.length).toBe(43);
    statusIs(await google(owner, startPath(purpose), ['gmail', 'calendar'].includes(purpose) ? { operation: 'start' } : {}), 409);
    statusIs(await google(owner, `${purpose}/callback?state=synthetic&code=synthetic`), 409);
  }
  expect(calls('oauth-token')).toBe(5); expect(calls('export-account')).toBe(1);
  // Cross-owner use of Alice's exact purpose cookie does not confer Alice's access.
  other.jar.set('moup_google_contacts', { ...owner.jar.get('moup_google_contacts') });
  const notReady = statusIs(await google(other, 'contacts'), 200); expect(notReady.ready).toBe(false);
  statusIs(await google(other, 'contacts/preview', {}), 410);
  // Copying a Gmail handle into the Calendar cookie is also not sufficient.
  const calendarCookie = owner.jar.get('moup_google_calendar');
  owner.jar.set('moup_google_calendar', { ...owner.jar.get('moup_google_gmail'), path: googleRoot + 'calendar' });
  expect(statusIs(await google(owner, 'calendar'), 200).connected).toBe(false);
  owner.jar.set('moup_google_calendar', calendarCookie);
  statusIs(await google(owner, 'contacts/preview', {}, { headers: { origin: 'https://foreign.example.test' } }), 403);

  const preview = statusIs(await google(owner, 'contacts/preview', {}), 200);
  expect(preview.contacts.map(row => row.duplicate)).toEqual([true, false, false]);
  expect((await counts()).alice_contacts).toBe(1);
  const selected = { selections: [{ id: preview.contacts[1].id, category: 'community' }] };
  statusIs(await google(owner, 'contacts/import', { selections: [{ id: identities.venue, category: 'personal' }] }), 400);
  await arm('contacts-import');
  statusIs(await google(owner, 'contacts/import', selected), 503);
  expect((await counts()).alice_contacts).toBe(2);
  expect(statusIs(await google(owner, 'contacts/import', selected), 200)).toEqual({ added: 0, skipped: 1 });
  expect((await counts()).alice_contacts).toBe(2); expect(calls('contacts-read')).toBe(1);
  statusIs(await google(owner, 'contacts/cancel', {}), 200);
  expect(owner.jar.has('moup_google_contacts')).toBe(false);
  statusIs(await google(owner, 'contacts/import', selected), 410);

  statusIs(await google(owner, 'sheets-import/source', { spreadsheetId: bookId }), 200);
  statusIs(await google(owner, 'sheets-import/source', { spreadsheetId: bookId, sheetId: 0 }), 200);
  const imported = statusIs(await google(owner, 'sheets-import/preview', { rows: [2, 3], mapping: { name: 0, email: 1, notes: 2 }, defaultCategory: 'professional', includeNotes: true }), 200).preview;
  expect(imported.rows.map(row => row.duplicate)).toEqual([true, false]);
  expect((await counts()).alice_contacts).toBe(2);
  const importBody = { previewId: imported.id };
  const importResult = statusIs(await google(owner, 'sheets-import/confirm', importBody), 200);
  expect(importResult.result).toMatchObject({ state: 'complete', added: 1, skipped: 1 });
  expect(statusIs(await google(owner, 'sheets-import/confirm', importBody), 200)).toEqual(importResult);
  expect((await counts()).alice_contacts).toBe(3);
  const saved = statusIs(await owner('/api/me/contacts'), 200).contacts;
  expect(saved.find(row => row.email === 'sheet@example.test')).toMatchObject({ category: 'professional', notes: 'Explicit synthetic note' });
  const secondPreview = statusIs(await google(owner, 'sheets-import/preview', { rows: [4], mapping: { name: 0, email: 1 }, defaultCategory: 'personal', includeNotes: false }), 200).preview;
  await arm('sheets-import');
  expect(statusIs(await google(owner, 'sheets-import/confirm', { previewId: secondPreview.id }), 200).result.state).toBe('uncertain');
  const rpcBefore = state.rpcs.filter(name => name === 'import_google_contacts').length;
  expect(statusIs(await google(owner, 'sheets-import/confirm', { previewId: secondPreview.id }), 200).result.state).toBe('uncertain');
  expect(state.rpcs.filter(name => name === 'import_google_contacts').length).toBe(rpcBefore);
  expect((await counts()).alice_contacts).toBe(4);
  statusIs(await post(owner, '/__harness/connect', { purpose: 'sheets-import', confirm: 'install-synthetic-not-real-consent' }), 409);

  const exported = statusIs(await google(owner, 'sheets-export/preview', { contactIds: [seeded.alice.contact.id], fields: ['name', 'email'], title: 'Synthetic export' }), 200).preview;
  expect(exported.values).toEqual([['Name', 'Email'], ['alice contact', 'alice.contact@example.test']]);
  expect(calls('export-create')).toBe(0);
  await arm('sheets-write');
  const exportBody = { previewId: exported.id };
  expect(statusIs(await google(owner, 'sheets-export/confirm', exportBody), 200).result.state).toBe('uncertain');
  expect(statusIs(await google(owner, 'sheets-export/confirm', exportBody), 200).result.state).toBe('uncertain');
  expect(calls('export-create')).toBe(1); expect(calls('export-write')).toBe(1);
  expect(statusIs(await google(owner, 'sheets-export/confirm', { checkOnly: true }), 200).result.state).toBe('complete');
  expect(calls('export-read')).toBe(1); expect(calls('export-write')).toBe(1);

  for (const purpose of ['gmail', 'calendar']) {
    const cancelled = await actionPreview(purpose);
    expect(statusIs(await google(owner, purpose, { operation: 'cancel', id: cancelled.id }), 200).action.state).toBe('cancelled');
    expect(statusIs(await google(owner, purpose, confirm(cancelled)), 200).action.state).toBe('cancelled');
    expect(calls(purpose === 'gmail' ? 'gmail-send' : 'calendar-insert')).toBe(0);
    const action = await actionPreview(purpose);
    statusIs(await google(owner, purpose === 'gmail' ? 'calendar' : 'gmail', confirm(action)), 404);
    statusIs(await google(owner, purpose, { ...confirm(action), draft: { subject: 'changed' } }), 400);
    await arm(purpose);
    expect(statusIs(await google(owner, purpose, confirm(action)), 200).action.state).toBe('uncertain');
    expect(statusIs(await google(owner, purpose, confirm(action)), 200).action.state).toBe('uncertain');
    expect(calls(purpose === 'gmail' ? 'gmail-send' : 'calendar-insert')).toBe(1);
    if (purpose === 'calendar') {
      expect(statusIs(await google(owner, purpose, { operation: 'reconcile', id: action.id }), 200).action.state).toBe('completed');
      expect(calls('calendar-read')).toBe(1); expect(calls('calendar-insert')).toBe(1);
    } else statusIs(await google(owner, purpose, { operation: 'reconcile', id: action.id }), 400);
  }
  const final = await counts();
  expect(final.bob_contacts).toBe(1); expect(final.faults_consumed).toBe(5);
  expect(final.external_transport_attempts).toBe(0); expect(final.secret_access_attempts).toBe(0); expect(final.internal_errors).toBe(0);
  expect(final.actions).toContainEqual({ purpose: 'gmail', state: 'uncertain', count: 1 });
  expect(final.actions).toContainEqual({ purpose: 'calendar', state: 'completed', count: 1 });
  expect(JSON.stringify(final)).not.toMatch(/synthetic-access-token|synthetic-client-secret|encrypted_payload|encrypted_preview|code_verifier/);
  const evidence = { provider_calls: [...state.calls], source_sha256: sourceHashes, sheets_bundle_sha256: digest(bundle) };
  await resetOwner();
  expect((await counts()).alice_contacts).toBe(1); expect((await counts()).sessions).toBe(0); expect((await counts()).actions).toEqual([]);
  for (const purpose of purposes) expect(owner.jar.has(`moup_google_${purpose}`)).toBe(false);
  console.log('LOCAL_GOOGLE_HTTP_SMOKE_OK ' + JSON.stringify(evidence));
  if (MODE === 'serve') {
    console.log(`LOCAL_GOOGLE_HTTP_READY ${origin}/__harness/ (30 minute maximum; synthetic consent only; unchanged component, not Next hydration)`);
    await stopPromise;
    expect(state.blocked).toBe(0); expect(state.secretReads).toBe(0); expect(state.errors).toBe(0);
    console.log('LOCAL_GOOGLE_HTTP_STOP_COUNTS ' + JSON.stringify({ external_transport_attempts: state.blocked, secret_access_attempts: state.secretReads, internal_errors: state.errors, provider_calls: state.calls }));
  } else {
    statusIs(await post(owner, '/__harness/stop', { confirm: 'stop-local-fixture' }), 200);
    await stopPromise; expect(server.listening).toBe(false);
    await expect(owner('/__harness/status')).rejects.toThrow();
    console.log('LOCAL_GOOGLE_HTTP_CLEANUP_OK listener stopped; database/bundle disposed by afterAll');
  }
});
