import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const deps = vi.hoisted(() => ({ userClient: vi.fn(), limitUser: vi.fn(), forbidden: vi.fn(() => { throw new Error('Forbidden provider or credential module'); }) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ userClient: deps.userClient }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: deps.forbidden }));
vi.mock('@/lib/secrets', () => ({ loadVaultSecrets: deps.forbidden }));
vi.mock('@/lib/ratelimit', () => ({ limitUser: deps.limitUser }));
import { POST as assistantRoute } from '../app/api/assistant/route';
import { GET as listContacts } from '../app/api/me/contacts/route';
import { PATCH as editContact, DELETE as deleteContact } from '../app/api/me/contacts/[id]/route';
import { POST as draftRoute } from '../app/api/me/contacts/[id]/draft/route';
import { HttpError } from '../lib/http';

// Actual shipped assistant -> actual Next handlers -> real local SQL/RLS and
// draft prompt construction -> intercepted model transport. No listening server,
// real Auth/PostgREST, browser, Google, Vault or external delivery is exercised.
const source = readFileSync(new URL('../public/organizer/assistant.js', import.meta.url), 'utf8');
const origin = 'https://app.example.test';
const provider = 'https://assistant-provider.example.test';
const tool = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const model = (content = '', tool_calls = []) => Response.json({ choices: [{ message: { content, tool_calls } }] });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let db, tenants, sessionOwner, providerRequests, databaseQueries, routes, unexpectedNetwork;

function browser({ controls = [], afterRoute = () => {} } = {}) {
  let owner = identities.alice;
  const listeners = new Map();
  const location = { origin, hash: '#/contacts', href: origin + '/organizer/#/contacts' };
  const window = {
    OrganizerAccount: { currentOwner: () => owner }, confirm: vi.fn(() => false),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  };
  const fetch = vi.fn(async (path, options = {}) => {
    const request = new Request(origin + path, options);
    const method = request.method;
    routes.push({ path, method, owner: request.headers.get('X-Contact-Owner') });
    if (path === '/api/assistant' && method === 'POST') return assistantRoute(request);
    if (path === '/api/me/contacts' && method === 'GET') {
      const response = await listContacts(request); await afterRoute(path); return response;
    }
    const contact = path.match(/^\/api\/me\/contacts\/([a-f0-9-]+)$/);
    if (contact && ['PATCH', 'DELETE'].includes(method)) return (method === 'PATCH' ? editContact : deleteContact)(request, { params: Promise.resolve({ id: contact[1] }) });
    throw new Error('Unallowlisted browser request');
  });
  const document = {
    getElementById: () => null,
    querySelectorAll: (selector) => selector.includes('#app button') ? controls : [],
    createElement: () => { throw new Error('External handoff outside this test'); },
  };
  vm.runInNewContext(source, { window, document, location, fetch, AbortController, Event, HashChangeEvent: class { constructor(type) { this.type = type; } } });
  return {
    assistant: window.Assistant, window, fetch,
    setDisplayedOwner: (value) => { owner = value; },
    leave() { location.hash = '#/dashboard'; location.href = origin + '/organizer/#/dashboard'; window.dispatchEvent({ type: 'hashchange' }); },
  };
}
const ask = (h, text = 'Find my people') => h.assistant.ask(text, [], { speakReply: false });
const draft = (id = tenants.alice.contact.id, owner = identities.alice) => draftRoute(new Request(origin + '/api/me/contacts/' + id + '/draft', {
  method: 'POST', headers: { 'X-Contact-Owner': owner },
}), { params: Promise.resolve({ id }) });
const ownedContact = (owner, id) => asRole(db, 'authenticated', owner, (tx) => tx.query('select name, notes from contacts where id = $1', [id]));
const providerFetch = () => vi.mocked(globalThis.fetch);

beforeAll(async () => {
  // Only the existing contact-era migrations are needed. The helper also skips
  // the Vault filename before opening files; the worktree excludes it entirely.
  db = await privacyDatabase({ beforeMigration: '20261025' });
}, 30_000);
beforeEach(async () => {
  tenants = await seedPrivateData(db);
  vi.clearAllMocks();
  sessionOwner = identities.alice; providerRequests = []; databaseQueries = []; routes = []; unexpectedNetwork = [];
  deps.userClient.mockImplementation(() => {
    // Snapshot the synthetic session for this request. The adapter executes the
    // real ownership policies with transaction-local role and auth.uid().
    const client = pgliteClient(db, sessionOwner ? 'authenticated' : 'anon', sessionOwner, {
      allowedTables: ['contacts', 'interactions'], allowedRpcs: [], organizerQueries: true, jsonRows: true,
    });
    const from = client.from;
    client.from = (table) => { databaseQueries.push({ table, owner: sessionOwner }); return from(table); };
    return client;
  });
  vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-model-key');
  vi.stubEnv('DEEPSEEK_BASE_URL', provider);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('GOOGLE_GMAIL_ENABLED', '');
  vi.stubEnv('GOOGLE_CALENDAR_ENABLED', '');
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url !== provider + '/chat/completions') { unexpectedNetwork.push(String(url)); throw new Error('Unallowlisted model transport'); }
    providerRequests.push(JSON.parse(options.body));
    return model('No changes requested.');
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(unexpectedNetwork).toEqual([]);
  expect(deps.forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
afterAll(async () => { await db?.close(); });

// Change only the response of the allowlisted transport, retaining its request
// recorder and deny-by-default URL check even on failure/cancellation paths.
function respond(handler) {
  const guarded = providerFetch().getMockImplementation();
  providerFetch().mockImplementation(async (url, options) => {
    await guarded(url, options);
    return handler(providerRequests.length, options);
  });
}

describe('assistant route chain with local PostgreSQL ownership policies', () => {
  it('returns only owned summaries to the next model round, not raw contact rows or unrelated notes', async () => {
    respond((round) => round === 1 ? model('', [tool('find_contacts', {})]) : model('Found your person.'));
    const result = await ask(browser());
    expect(result.reply).toBe('Found your person.');
    expect(providerRequests).toHaveLength(2);
    const resultMessage = providerRequests[1].messages.find((message) => message.role === 'tool');
    expect(JSON.parse(resultMessage.content)).toEqual({ count: 1, people: [{
      name: tenants.alice.contact.name, category: 'personal', interests: [], email: tenants.alice.contact.email,
      every_days: null, next_check_in: null, last_contact: null,
    }] });
    const outbound = JSON.stringify(providerRequests);
    for (const hidden of [identities.alice, identities.bob, tenants.alice.contact.id, tenants.alice.contact.notes, tenants.alice.interaction.notes, tenants.bob.contact.name, tenants.bob.contact.email, tenants.bob.contact.notes]) expect(outbound).not.toContain(hidden);
    expect(databaseQueries).toEqual([{ table: 'contacts', owner: identities.alice }]);
    expect(routes.map(({ path }) => path)).toEqual(['/api/assistant', '/api/me/contacts', '/api/assistant']);
    expect(routes.every(({ owner }) => owner === identities.alice)).toBe(true);
  });

  it('applies an explicit local edit once through the real PATCH route, without changing the other owner', async () => {
    respond((round) => round < 3 ? model('', [tool('update_contact', { name: tenants.alice.contact.name, notes: 'Requested new synthetic note' }, 'edit-' + round)]) : model('Updated.'));
    const result = await ask(browser(), 'Update my contact note');
    expect(result.reply).toBe('Updated.');
    expect(routes.filter(({ method }) => method === 'PATCH')).toHaveLength(1);
    expect((await ownedContact(identities.alice, tenants.alice.contact.id)).rows[0].notes).toBe('Requested new synthetic note');
    expect((await ownedContact(identities.bob, tenants.bob.contact.id)).rows[0].notes).toBe(tenants.bob.contact.notes);
    expect(JSON.stringify(providerRequests)).not.toContain(tenants.bob.contact.id);
  });

  it('refuses a silent cookie-session replacement between the model reply and its contact read', async () => {
    respond(() => { sessionOwner = identities.bob; return model('', [tool('update_contact', { name: tenants.alice.contact.name, notes: 'Stale edit' })]); });
    const result = await ask(browser(), 'Update my contact note');
    expect(result.cancelled).toBe(true);
    expect(result.reply).toMatch(/account changed/i);
    expect(providerRequests).toHaveLength(1); expect(databaseQueries).toEqual([]);
    expect(routes.map(({ method }) => method)).toEqual(['POST', 'GET']);
    expect((await ownedContact(identities.alice, tenants.alice.contact.id)).rows[0].notes).toBe(tenants.alice.contact.notes);
    expect((await ownedContact(identities.bob, tenants.bob.contact.id)).rows[0].notes).toBe(tenants.bob.contact.notes);
  });

  it('refuses a session replacement after the owned lookup but before the actual PATCH route', async () => {
    respond(() => model('', [tool('update_contact', { name: tenants.alice.contact.name, notes: 'Stale edit' })]));
    const h = browser({ afterRoute: () => { sessionOwner = identities.bob; } });
    const result = await ask(h, 'Update my contact note');
    expect(result.cancelled).toBe(true);
    expect(routes.map(({ method }) => method)).toEqual(['POST', 'GET', 'PATCH']);
    expect(databaseQueries).toEqual([{ table: 'contacts', owner: identities.alice }]);
    expect(providerRequests).toHaveLength(1);
    expect((await ownedContact(identities.alice, tenants.alice.contact.id)).rows[0].notes).toBe(tenants.alice.contact.notes);
    expect((await ownedContact(identities.bob, tenants.bob.contact.id)).rows[0].notes).toBe(tenants.bob.contact.notes);
  });

  it.each(['navigate', 'displayed owner', 'abort'])('drops an actual model route response after %s without requesting contact data', async (change) => {
    const started = deferred(), pendingModel = deferred(), controller = new AbortController();
    respond(() => { started.resolve(); return pendingModel.promise; });
    const h = browser();
    const pending = h.assistant.ask('Update a note', [], { speakReply: false, signal: controller.signal });
    await started.promise;
    if (change === 'navigate') h.leave();
    else if (change === 'displayed owner') h.setDisplayedOwner(identities.bob);
    else controller.abort();
    pendingModel.resolve(model('', [tool('update_contact', { name: tenants.alice.contact.name, notes: 'Late edit' })]));
    expect((await pending).cancelled).toBe(true);
    expect(providerRequests).toHaveLength(1); expect(databaseQueries).toEqual([]);
    expect(routes).toHaveLength(1);
  });

  it.each([null, identities.bob])('rejects missing or changed session %s before even the first model request', async (owner) => {
    sessionOwner = owner;
    const result = await ask(browser());
    expect(result.error).toMatch(/signed in|account changed/i);
    expect(providerRequests).toEqual([]); expect(databaseQueries).toEqual([]);
    expect(deps.limitUser).not.toHaveBeenCalled();
  });

  it('honors the route rate-limit rejection without returning source data or running tools', async () => {
    deps.limitUser.mockRejectedValueOnce(new HttpError(429, 'Try again later'));
    const result = await ask(browser());
    expect(result.error).toBe('Try again later');
    expect(providerRequests).toEqual([]); expect(databaseQueries).toEqual([]); expect(routes).toHaveLength(1);
  });
});

describe('actual assistant model failures and human-only action boundaries', () => {
  it.each(['HTTP failure', 'invalid JSON', 'invalid action'])('stops at %s without running a local action or retrying the provider', async (failure) => {
    respond(() => failure === 'HTTP failure' ? new Response('Synthetic upstream failure', { status: 503 })
      : failure === 'invalid JSON' ? new Response('not-json', { status: 200 })
        : model('', [{ id: 'broken', function: { name: 'update_contact', arguments: '{"name":' } }]));
    const result = await ask(browser(), 'Update a contact');
    expect(result.error).toMatch(/Assistant model/);
    expect(result.actions).toEqual([]); expect(providerRequests).toHaveLength(1); expect(databaseQueries).toEqual([]);
  });

  it('uses the real route timeout signal and stops after its single aborted provider attempt', async () => {
    const deadline = new AbortController(), started = deferred();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    respond((_round, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Synthetic deadline', 'TimeoutError')), { once: true });
      started.resolve();
    }));
    const pending = ask(browser()); await started.promise; deadline.abort();
    const result = await pending;
    expect(timeout).toHaveBeenCalledWith(25_000);
    expect(result.error).toBe('Could not reach the assistant model');
    expect(providerRequests).toHaveLength(1); expect(databaseQueries).toEqual([]); expect(routes).toHaveLength(1);
  });

  it.each(['ga-confirm', 'gc-connect', 'gc-save'])('cannot turn a model-chosen generic click into protected action %s', async (id) => {
    const button = { id, innerText: 'Continue', offsetWidth: 10, dataset: {}, getAttribute: () => null, click: vi.fn(() => { throw new Error('Human-only action was activated'); }) };
    respond((round) => round === 1 ? model('', [tool('click', { label: 'Continue' })]) : model('Please use the page controls.'));
    const result = await ask(browser({ controls: [button] }), 'Continue');
    expect(result.actions[0].result.error).toMatch(/manual|yourself/i);
    expect(button.click).not.toHaveBeenCalled(); expect(databaseQueries).toEqual([]);
    expect(routes.every(({ path }) => path === '/api/assistant')).toBe(true);
    expect(process.env.GOOGLE_GMAIL_ENABLED).not.toBe('true'); expect(process.env.GOOGLE_CALENDAR_ENABLED).not.toBe('true');
  });

  it('treats model confirmed:true as insufficient for deletion when the human dialog is declined', async () => {
    respond((round) => round === 1 ? model('', [tool('delete_contact', { name: tenants.alice.contact.name, confirmed: true })]) : model('Not deleted.'));
    const h = browser(), result = await ask(h, 'Delete the contact');
    expect(h.window.confirm).toHaveBeenCalledTimes(1);
    expect(result.actions[0].result.error).toMatch(/cancelled/);
    expect(routes.some(({ method }) => method === 'DELETE')).toBe(false);
    expect((await ownedContact(identities.alice, tenants.alice.contact.id)).rows).toHaveLength(1);
  });
});

describe('draft route source minimization through real queries and provider prompt', () => {
  it('rejects a foreign contact under real RLS before reading history or calling the model', async () => {
    expect((await draft(tenants.bob.contact.id)).status).toBe(404);
    expect(providerRequests).toEqual([]);
    expect(databaseQueries).toEqual([{ table: 'contacts', owner: identities.alice }]);
  });

  it('sends only the bounded selected contact facts and newest three history notes to the draft provider', async () => {
    const contactNote = 'Contact fact '.repeat(30);
    await asRole(db, 'authenticated', identities.alice, async (tx) => {
      await tx.query('update contacts set notes = $1 where id = $2', [contactNote + 'EXCLUDED_CONTACT_TAIL', tenants.alice.contact.id]);
      await tx.query('delete from interactions where contact_id = $1', [tenants.alice.contact.id]);
      for (let day = 1; day <= 4; day++) await tx.query('insert into interactions (contact_id, occurred_at, notes) values ($1, $2, $3)', [tenants.alice.contact.id, `2026-10-0${day}T12:00:00Z`, `HISTORY_${day}:` + 'x'.repeat(220) + 'EXCLUDED_HISTORY_TAIL']);
    });
    respond(() => model('Hi Alice, shall we catch up this week?'));
    const response = await draft(), payload = await response.json();
    expect(response.status).toBe(200); expect(payload.source).toBe('deepseek');
    expect(providerRequests).toHaveLength(1);
    const prompt = providerRequests[0].messages[0].content;
    expect(prompt).toContain(tenants.alice.contact.name); expect(prompt).toContain(contactNote.slice(0, 300));
    for (const day of [2, 3, 4]) expect(prompt).toContain(`HISTORY_${day}:` + 'x'.repeat(190));
    for (const hidden of ['EXCLUDED_CONTACT_TAIL', 'EXCLUDED_HISTORY_TAIL', 'HISTORY_1:', tenants.bob.contact.name, tenants.bob.contact.notes, tenants.bob.interaction.notes, tenants.alice.contact.email, tenants.alice.contact.id, identities.alice]) expect(prompt).not.toContain(hidden);
    expect(payload.basis.filter((item) => item.startsWith('Earlier check-in:'))).toHaveLength(3);
    expect(providerFetch().mock.calls[0][1].cache).toBe('no-store');
  });

  it('does not leak provider exception text containing source data when falling back to the editable template', async () => {
    respond(() => { throw new Error('Synthetic transport diagnostic: ' + JSON.stringify(providerRequests[0])); });
    const response = await draft(), payload = await response.json();
    expect(response.status).toBe(200); expect(payload.source).toBe('template');
    expect(payload.basis).toEqual(['Written from a template (no AI)', 'Relationship: personal']);
    expect(providerRequests).toHaveLength(1);
    const logs = JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]);
    expect(logs).not.toContain(tenants.alice.contact.notes);
    expect(logs).not.toContain(tenants.alice.interaction.notes);
    expect(logs).not.toContain('Synthetic transport diagnostic');
  });
});
