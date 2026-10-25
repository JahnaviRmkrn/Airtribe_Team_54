import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const value = { context: null, client: null, queue: [], calls: [], rpcs: [], loseRpc: null, blocked: 0, secretReads: 0 };
  // Install before application imports. A caught provider exception is still a
  // test failure: afterEach checks the unmatched-call counter and full queue.
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const expected = value.queue.shift();
    if (!expected || String(url) !== expected.url || (init.method || 'GET') !== expected.method) {
      value.blocked++; throw new Error('Unmatched provider transport is forbidden');
    }
    value.calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    await expected.inspect?.(init);
    if (expected.fail) throw new Error('Synthetic provider response lost');
    return new Response(JSON.stringify(expected.response), { status: expected.status || 200 });
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
vi.mock('@plural_pinelabs/agent-toolkit/shared', () => { state.blocked++; throw new Error('Other providers forbidden'); });
vi.mock('node:http', async (original) => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('HTTP transport/server forbidden'); };
  const guarded = { request: deny, get: deny, createServer: deny };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:https', async (original) => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('HTTPS transport/server forbidden'); };
  const guarded = { request: deny, get: deny, createServer: deny };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:net', async (original) => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('Socket transport/server forbidden'); };
  class Socket extends loaded.Socket { connect() { return deny(); } }
  const guarded = { Socket, connect: deny, createConnection: deny, createServer: deny };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:tls', async (original) => {
  const loaded = await original();
  const deny = () => { state.blocked++; throw new Error('TLS transport/server forbidden'); };
  class TLSSocket extends loaded.TLSSocket { connect() { return deny(); } }
  const guarded = { TLSSocket, connect: deny, createServer: deny };
  return { ...loaded, ...guarded, default: { ...loaded.default, ...guarded } };
});
vi.mock('node:fs', async (original) => {
  const loaded = await original();
  const readFileSync = (path, ...args) => {
    if (/(^|[/\\])\.env(?:[./\\]|$)|vault|app_secrets/i.test(String(path))) {
      state.secretReads++; throw new Error('Environment/Vault file access forbidden');
    }
    return loaded.readFileSync(path, ...args);
  };
  return { ...loaded, readFileSync, default: { ...loaded.default, readFileSync } };
});

import { asRole, identities } from '../helpers/privacy-db.mjs';
import { pgliteClient } from '../helpers/pglite-client.mjs';
import { googleClient, googleDatabase, resetDatabase } from './database.mjs';
import { googleConfig, unseal } from '../../lib/google/connector';
import { calendarEventId } from '../../lib/google/action-content';

// These are the shipped route entry points, not hand-copied responses or direct
// helper substitutes. No listening socket, Next server, or browser is involved.
const modules = import.meta.glob('../../app/api/me/integrations/google/**/route.ts', { eager: true });
const routes = new Map(Object.entries(modules).map(([path, module]) => [path.split('/google/')[1].replace('/route.ts', ''), module]));
const origin = 'https://google-boundary.example.test';
const purposes = ['contacts', 'sheets-import', 'sheets-export', 'gmail', 'calendar'];
const storage = new AsyncLocalStorage();
const tokenUrl = 'https://oauth2.googleapis.com/token';
const sheetsUrl = 'https://sheets.googleapis.com/v4/spreadsheets';
const bookId = 'synthetic_spreadsheet_00000001';
const exportId = 'synthetic_export_000000000001';
const eventUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const peopleUrl = 'https://people.googleapis.com/v1/people/me/connections?personFields=names%2CemailAddresses&sources=READ_SOURCE_TYPE_CONTACT&pageSize=100&sortOrder=FIRST_NAME_ASCENDING';
const drafts = {
  gmail: { from: 'sender@example.test', to: ['recipient@example.test'], subject: 'Synthetic review', body: 'Exact synthetic body' },
  calendar: { title: 'Synthetic review', description: 'Exact synthetic details', location: 'Synthetic room', localStart: '2026-11-02T12:00', timeZone: 'UTC', durationMinutes: 30, attendees: ['recipient@example.test'], sendUpdates: 'none' },
};
let db, seeded, jar;
const enqueue = (method, url, response, options = {}) => state.queue.push({ method, url, response, ...options });
const rpcCount = name => state.rpcs.filter(value => value === name).length;
const startPath = purpose => purpose === 'contacts' ? 'contacts/start' : purpose.startsWith('sheets-') ? `${purpose}/connect` : purpose;
const statusPath = purpose => purpose.startsWith('sheets-') ? `${purpose}/status` : purpose;
const stopPath = purpose => purpose === 'contacts' ? 'contacts/cancel' : purpose.startsWith('sheets-') ? `${purpose}/disconnect` : purpose;
async function call(path, body, options = {}) {
  const method = options.method || (body === undefined ? 'GET' : 'POST');
  const route = routes.get(path.split('?')[0])?.[method];
  if (!route) throw new Error('Unmatched local route/method');
  const currentJar = options.jar || jar;
  const owner = options.owner === undefined ? identities.alice : options.owner;
  const headers = { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...options.headers };
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  const request = new Request(`${origin}/api/me/integrations/google/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await storage.run({ owner, cookies: {
    get: name => currentJar.has(name) ? { value: currentJar.get(name) } : undefined,
    set: (name, value, attributes) => {
      expect(attributes).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax' });
      if (attributes.maxAge === 0) currentJar.delete(name); else currentJar.set(name, value);
    },
  } }, () => route(request));
  expect(response.headers.get('cache-control')).toContain('no-store');
  if (options.status !== undefined) expect(response.status).toBe(options.status);
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (data) expect(JSON.stringify(data)).not.toMatch(/synthetic-access-token|synthetic-client-secret|synthetic-refresh-token/);
  return { response, data };
}
async function connect(purpose) {
  const { data } = await call(startPath(purpose), ['gmail', 'calendar'].includes(purpose) ? { operation: 'start' } : {}, { status: 200 });
  const consent = new URL(data.authorization_url || data.authorizationUrl || data.url);
  expect(consent.searchParams.get('scope')).toBe(googleConfig(purpose).scope);
  expect(state.queue).toHaveLength(0);
  return consent.searchParams.get('state');
}
async function authorize(purpose) {
  const authState = await connect(purpose);
  enqueue('POST', tokenUrl, { access_token: 'synthetic-access-token', token_type: 'Bearer', scope: googleConfig(purpose).scope, expires_in: 900, refresh_token: 'synthetic-refresh-token' });
  if (purpose === 'sheets-export') enqueue('GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { user: { emailAddress: 'destination@example.test' } });
  const path = `${purpose}/callback?state=${authState}&code=synthetic-code`;
  const { response } = await call(path, undefined, { status: 303 });
  expect(response.headers.get('location')).not.toMatch(/synthetic-code|synthetic-access|state=/);
  return path;
}
async function payload(purpose) {
  const { rows } = await db.query('select * from google_connector_sessions where user_id=$1 and purpose=$2', [identities.alice, purpose]);
  expect(rows).toHaveLength(1);
  return unseal(rows[0].encrypted_payload, googleConfig(purpose), rows[0].id, identities.alice);
}
async function contactsPreview() {
  await authorize('contacts');
  enqueue('GET', peopleUrl, { connections: [
    { names: [{ displayName: 'Existing Alice' }], emailAddresses: [{ value: 'ALICE.CONTACT@example.test' }] },
    { names: [{ displayName: 'New Person' }], emailAddresses: [{ value: 'new@example.test' }] },
  ] });
  return (await call('contacts/preview', {}, { status: 200 })).data;
}
async function importPreview() {
  await authorize('sheets-import');
  enqueue('GET', `${sheetsUrl}/${bookId}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title))`, {
    spreadsheetId: bookId, properties: { title: 'Synthetic contacts' }, sheets: [{ properties: { sheetId: 0, title: 'People' } }],
  });
  enqueue('GET', `${sheetsUrl}/${bookId}/values/${encodeURIComponent("'People'!A1:Z101")}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, {
    values: [['Name', 'Email', 'Notes'], ['Existing Alice', 'alice.contact@example.test', 'skip'], ['Sheet Person', 'sheet@example.test', 'Explicit synthetic note']],
  });
  await call('sheets-import/source', { spreadsheetId: bookId, sheetId: 0 }, { status: 200 });
  return (await call('sheets-import/preview', { rows: [2, 3], mapping: { name: 0, email: 1, notes: 2 }, defaultCategory: 'professional', includeNotes: true }, { status: 200 })).data.preview;
}
async function exportPreview() {
  await authorize('sheets-export');
  return (await call('sheets-export/preview', { contactIds: [seeded.alice.contact.id], fields: ['name', 'email'], title: 'Synthetic export' }, { status: 200 })).data.preview;
}
async function actionPreview(purpose) {
  await authorize(purpose);
  return (await call(purpose, { operation: 'preview', draft: drafts[purpose] }, { status: 200 })).data.action;
}
const confirmation = action => ({ operation: 'confirm', id: action.id, previewHash: action.previewHash, confirmed: true, senderAcknowledged: true });

beforeAll(async () => {
  expect(state.blocked).toBe(0); expect(state.secretReads).toBe(0);
  db = await googleDatabase();
  expect(state.blocked).toBe(0); expect(state.secretReads).toBe(0);
  state.context = () => storage.getStore();
  state.client = admin => googleClient(db, storage.getStore()?.owner || null, state, admin);
});
beforeEach(async () => {
  seeded = await resetDatabase(db); jar = new Map();
  state.queue = []; state.calls = []; state.rpcs = []; state.loseRpc = null; state.loseFinish = false;
  state.blocked = 0; state.secretReads = 0;
  for (const prefix of ['CONTACTS', 'SHEETS', 'GMAIL', 'CALENDAR']) {
    vi.stubEnv(`GOOGLE_${prefix}_CLIENT_ID`, 'synthetic-client-id');
    vi.stubEnv(`GOOGLE_${prefix}_CLIENT_SECRET`, 'synthetic-client-secret');
  }
  vi.stubEnv('GOOGLE_GMAIL_ENABLED', 'true'); vi.stubEnv('GOOGLE_CALENDAR_ENABLED', 'true');
  vi.stubEnv('GOOGLE_CONNECTOR_ORIGIN', origin);
  vi.stubEnv('GOOGLE_CONNECTOR_ENCRYPTION_KEY', Buffer.alloc(32, 23).toString('base64'));
});
afterEach(() => {
  expect(state.queue).toHaveLength(0);
  expect(state.blocked).toBe(0); expect(state.secretReads).toBe(0);
  vi.unstubAllEnvs();
});
afterAll(async () => { await db?.close(); vi.unstubAllGlobals(); });

describe('actual Google HTTP exports + connector + PostgreSQL boundaries', () => {
  it('fails closed on unmatched transports, forbidden files and unknown adapters', async () => {
    await expect(fetch('https://unmatched.example.test')).rejects.toThrow('forbidden');
    for (const transport of [http, http.default, https, https.default]) expect(() => transport.request('https://example.test')).toThrow('forbidden');
    for (const transport of [net, net.default, tls, tls.default]) expect(() => transport.connect({ host: 'example.test', port: 443 })).toThrow('forbidden');
    const socket = new net.Socket();
    try { expect(() => socket.connect(443, 'example.test')).toThrow('forbidden'); } finally { socket.destroy(); }
    expect(() => fileSystem.readFileSync('/not-opened/.env')).toThrow('forbidden');
    expect(() => pgliteClient(db, 'authenticated', identities.alice).from('contacts').in('id', ['a'])).toThrow('not enabled');
    await expect(googleClient(db, identities.alice, state, true).rpc('unknown')).rejects.toThrow('Unsupported');
    expect(state.blocked).toBe(10); expect(state.secretReads).toBe(1);
    state.blocked = 0; state.secretReads = 0;
  });

  it.each(purposes)('%s rejects missing authentication, missing/foreign origin and changed owner intent', async purpose => {
    await call(statusPath(purpose), undefined, { owner: null, status: 401 });
    const body = ['gmail', 'calendar'].includes(purpose) ? { operation: 'start' } : {};
    for (const Origin of [null, 'https://foreign.example.test']) await call(startPath(purpose), body, { headers: { Origin }, status: 403 });
    await call(startPath(purpose), body, { headers: { 'X-Contact-Owner': identities.bob }, status: 409 });
    expect(state.calls).toHaveLength(0); expect(state.rpcs).toHaveLength(0);
  });

  it.each(purposes)('%s binds real session claims to the owner and consumes callbacks once', async purpose => {
    const callback = await authorize(purpose), count = state.calls.length;
    await call(callback, undefined, { owner: identities.bob, status: 303 });
    await call(callback, undefined, { status: 303 });
    expect(state.calls).toHaveLength(count);
    expect((await payload(purpose)).phase).toBe('ready');
    const other = (await call(statusPath(purpose), undefined, { owner: identities.bob, status: 200 })).data;
    expect(other.ready || other.connected || other.session?.connected || false).toBe(false);
    const ownerJar = new Map(jar);
    await call(stopPath(purpose), ['gmail', 'calendar'].includes(purpose) ? { operation: 'disconnect' } : {}, { owner: identities.bob, status: 200 });
    jar = ownerJar;
    expect((await payload(purpose)).phase).toBe('ready');
    expect(state.calls).toHaveLength(count);
  });

  it('Contacts previews real duplicates, validates selections, safely retries a committed lost import and cancels', async () => {
    const preview = await contactsPreview();
    expect(preview.contacts.map(contact => contact.duplicate)).toEqual([true, false]);
    expect((await payload('contacts')).token).toBeNull();
    expect((await db.query('select id from contacts')).rows).toHaveLength(2);
    const selections = [{ id: preview.contacts[1].id, category: 'community' }];
    await call('contacts/import', { selections: [{ ...selections[0], id: identities.venue }] }, { status: 400 });
    await call('contacts/import', { selections }, { owner: identities.bob, status: 410 });
    state.loseRpc = 'import_google_contacts';
    await call('contacts/import', { selections }, { status: 503 });
    expect((await call('contacts/import', { selections }, { status: 200 })).data).toEqual({ added: 0, skipped: 1 });
    expect((await db.query("select user_id,category from contacts where email='new@example.test'")).rows).toEqual([{ user_id: identities.alice, category: 'community' }]);
    await call('contacts/cancel', {}, { status: 200 });
    await call('contacts/import', { selections }, { status: 410 });
    expect(state.calls).toHaveLength(2);
  });

  it('Sheets import joins the mapped preview, real duplicate SQL, confirmation receipt and cancellation', async () => {
    const preview = await importPreview();
    expect(preview.rows.map(row => row.duplicate)).toEqual([true, false]);
    expect((await db.query('select id from contacts')).rows).toHaveLength(2);
    await call('sheets-import/confirm', { previewId: preview.id, contacts: [] }, { status: 400 });
    await call('sheets-import/confirm', { previewId: preview.id }, { owner: identities.bob, status: 410 });
    const result = await call('sheets-import/confirm', { previewId: preview.id }, { status: 200 });
    expect(result.data.result).toMatchObject({ state: 'complete', added: 1, skipped: 1 });
    expect((await call('sheets-import/confirm', { previewId: preview.id }, { status: 200 })).data).toEqual(result.data);
    expect(rpcCount('import_google_contacts')).toBe(1);
    expect((await db.query("select user_id,notes,category from contacts where email='sheet@example.test'")).rows).toEqual([{ user_id: identities.alice, notes: 'Explicit synthetic note', category: 'professional' }]);
    await call('sheets-import/disconnect', {}, { status: 200 });
    await call('sheets-import/confirm', { previewId: preview.id }, { status: 410 });
  });

  it('Sheets import retains an uncertain committed receipt and cannot reconnect or repeat it', async () => {
    const preview = await importPreview(); state.loseRpc = 'import_google_contacts';
    for (let i = 0; i < 2; i++) expect((await call('sheets-import/confirm', { previewId: preview.id }, { status: 200 })).data.result.state).toBe('uncertain');
    await call('sheets-import/connect', {}, { status: 409 });
    expect((await payload('sheets-import')).importRun.state).toBe('uncertain');
    expect(rpcCount('import_google_contacts')).toBe(1);
    expect((await db.query("select id from contacts where email='sheet@example.test'")).rows).toHaveLength(1);
  });

  it.each(['contacts', 'sheets-import', 'sheets-export'])('%s cancels a reviewed preview before any contact/provider write', async purpose => {
    const preview = await (purpose === 'contacts' ? contactsPreview() : purpose === 'sheets-import' ? importPreview() : exportPreview());
    const calls = state.calls.length;
    await call(stopPath(purpose), {}, { status: 200 });
    const body = purpose === 'contacts' ? { selections: [{ id: preview.contacts[1].id, category: 'personal' }] } : { previewId: preview.id };
    await call(purpose === 'contacts' ? 'contacts/import' : `${purpose}/confirm`, body, { status: 410 });
    expect(rpcCount('import_google_contacts')).toBe(0);
    expect(state.calls).toHaveLength(calls);
    expect((await db.query('select id from contacts')).rows).toHaveLength(2);
  });

  it('Sheets export sends only the reviewed owner snapshot, using RAW once after durable checkpoints', async () => {
    const preview = await exportPreview();
    expect(preview).toMatchObject({ destinationEmail: 'destination@example.test', values: [['Name', 'Email'], ['alice contact', 'alice.contact@example.test']], includeNotes: false });
    await call('sheets-export/preview', { contactIds: [seeded.bob.contact.id], fields: ['name'], title: 'Other owner' }, { status: 409 });
    await call('sheets-export/preview', { contactIds: [seeded.alice.contact.id], fields: ['notes'], title: 'No notes consent' }, { status: 400 });
    await call('sheets-export/confirm', { previewId: preview.id }, { owner: identities.bob, status: 410 });
    await db.query("update contacts set name='Changed after review' where id=$1", [seeded.alice.contact.id]);
    enqueue('POST', sheetsUrl, { spreadsheetId: exportId }, { inspect: async init => {
      expect((await payload('sheets-export')).exportRun.state).toBe('creating');
      expect(JSON.parse(init.body).properties.title).toBe(preview.title);
      expect(init.body).not.toContain('alice.contact');
    } });
    enqueue('PUT', `${sheetsUrl}/${exportId}/values/${encodeURIComponent(preview.range)}?valueInputOption=RAW`, { spreadsheetId: exportId, updatedRange: preview.range, updatedRows: 2, updatedColumns: 2, updatedCells: 4 }, { inspect: async init => {
      expect((await payload('sheets-export')).exportRun).toMatchObject({ state: 'writing', spreadsheetId: exportId });
      expect(JSON.parse(init.body).values).toEqual(preview.values);
    } });
    for (let i = 0; i < 2; i++) expect((await call('sheets-export/confirm', { previewId: preview.id }, { status: 200 })).data.result.state).toBe('complete');
    expect(state.calls.filter(call => ['POST', 'PUT'].includes(call.method) && call.url.startsWith(sheetsUrl))).toHaveLength(2);
    await call('sheets-export/disconnect', {}, { status: 200 });
    await call('sheets-export/confirm', { previewId: preview.id }, { status: 410 });
  });

  it.each(['create', 'write'])('Sheets export never repeats an unknown %s and reconciles only a known sheet by GET', async failure => {
    const preview = await exportPreview();
    enqueue('POST', sheetsUrl, { spreadsheetId: exportId }, { fail: failure === 'create' });
    if (failure === 'write') enqueue('PUT', `${sheetsUrl}/${exportId}/values/${encodeURIComponent(preview.range)}?valueInputOption=RAW`, {}, { fail: true });
    for (let i = 0; i < 2; i++) expect((await call('sheets-export/confirm', { previewId: preview.id }, { status: 200 })).data.result.state).toBe('uncertain');
    await call('sheets-export/connect', {}, { status: 409 });
    if (failure === 'create') await call('sheets-export/confirm', { checkOnly: true }, { status: 409 });
    else {
      enqueue('GET', `${sheetsUrl}/${exportId}/values/${encodeURIComponent(preview.range)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`, { values: preview.values });
      expect((await call('sheets-export/confirm', { checkOnly: true }, { status: 200 })).data.result.state).toBe('complete');
    }
    expect(state.calls.filter(call => call.method === 'POST' && call.url === sheetsUrl)).toHaveLength(1);
  });

  it.each(['gmail', 'calendar'])('%s ties exact preview and cancel to owner and performs one durably claimed action', async purpose => {
    const cancelled = await actionPreview(purpose);
    await call(purpose, { operation: 'cancel', id: cancelled.id }, { owner: identities.bob, status: 404 });
    expect((await call(purpose, { operation: 'cancel', id: cancelled.id }, { status: 200 })).data.action.state).toBe('cancelled');
    expect((await call(purpose, confirmation(cancelled), { status: 200 })).data.action.state).toBe('cancelled');
    const action = (await call(purpose, { operation: 'preview', draft: { ...drafts[purpose], ...(purpose === 'gmail' ? { subject: 'Second preview' } : { title: 'Second preview' }) } }, { status: 200 })).data.action;
    await call(purpose, { ...confirmation(action), previewHash: 'f'.repeat(64) }, { status: 409 });
    await call(purpose, { ...confirmation(action), unexpected: 'mutated content' }, { status: 400 });
    await call(purpose, confirmation(action), { owner: identities.bob, status: 410 });
    const url = purpose === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/sender%40example.test/messages/send' : `${eventUrl}?sendUpdates=none`;
    enqueue('POST', url, { id: purpose === 'gmail' ? 'synthetic-message-1' : calendarEventId(action.id) }, { inspect: async init => {
      expect((await db.query('select state from google_confirmed_actions where id=$1', [action.id])).rows).toEqual([{ state: 'claimed' }]);
      if (purpose === 'gmail') {
        const mime = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8');
        expect(mime).toContain('From: sender@example.test'); expect(mime).toContain('To: recipient@example.test');
        expect(mime).toContain(Buffer.from(drafts.gmail.body).toString('base64'));
      } else expect(JSON.parse(init.body)).toMatchObject({ id: calendarEventId(action.id), summary: action.preview.title, extendedProperties: { private: { moupAction: action.id, moupPreview: action.previewHash } } });
    } });
    for (let i = 0; i < 2; i++) expect((await call(purpose, confirmation(action), { status: 200 })).data.action.state).toBe('completed');
    expect((await db.query('select state from google_confirmed_actions where id=$1', [action.id])).rows).toEqual([{ state: 'completed' }]);
    expect(state.calls.filter(call => call.url === url)).toHaveLength(1);
  });

  it.each(['gmail', 'calendar'])('%s persists uncertain delivery, blocks repeat after reconnect and only reconciles Calendar', async purpose => {
    const action = await actionPreview(purpose);
    const url = purpose === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/sender%40example.test/messages/send' : `${eventUrl}?sendUpdates=none`;
    enqueue('POST', url, {}, { fail: true });
    expect((await call(purpose, confirmation(action), { status: 200 })).data.action.state).toBe('uncertain');
    await call(purpose, { operation: 'disconnect' }, { status: 200 });
    expect((await call(purpose, undefined, { status: 200 })).data).toMatchObject({ connected: false, actions: [{ state: 'uncertain' }] });
    await authorize(purpose);
    const repeated = (await call(purpose, { operation: 'preview', draft: drafts[purpose] }, { status: 200 })).data.action;
    expect(repeated).toMatchObject({ id: action.id, state: 'uncertain' });
    expect((await call(purpose, confirmation(action), { status: 200 })).data.action.state).toBe('uncertain');
    if (purpose === 'gmail') await call(purpose, { operation: 'reconcile', id: action.id }, { status: 400 });
    else {
      enqueue('GET', `${eventUrl}/${calendarEventId(action.id)}`, { id: calendarEventId(action.id), extendedProperties: { private: { moupAction: action.id, moupPreview: action.previewHash } } });
      expect((await call(purpose, { operation: 'reconcile', id: action.id }, { status: 200 })).data.action.state).toBe('completed');
    }
    expect(state.calls.filter(call => call.url === url)).toHaveLength(1);
  });

  it('does not send after the real one-time action claim commits but its receipt is lost', async () => {
    const action = await actionPreview('gmail'); state.loseRpc = 'claim_google_confirmed_action';
    await call('gmail', confirmation(action), { status: 503 });
    expect((await call('gmail', confirmation(action), { status: 200 })).data.action.state).toBe('claimed');
    expect(state.calls).toHaveLength(1);
    expect(rpcCount('claim_google_confirmed_action')).toBe(1);
  });

  it('rejects cross-purpose action IDs and session cookies before any provider write', async () => {
    const action = await actionPreview('gmail');
    await authorize('calendar');
    await call('calendar', confirmation(action), { status: 404 });
    await call('calendar', { operation: 'cancel', id: action.id }, { status: 404 });
    const original = jar.get('__Secure-moup_google_calendar');
    jar.set('__Secure-moup_google_calendar', jar.get('__Secure-moup_google_gmail'));
    await call('calendar', { operation: 'preview', draft: drafts.calendar }, { status: 410 });
    jar.set('__Secure-moup_google_calendar', original);
    expect((await call(`gmail?id=${action.id}`, undefined, { status: 200 })).data.action.state).toBe('preview');
    expect(state.calls).toHaveLength(2);
  });

  it.each(['gmail', 'calendar'])('%s reports uncertainty when successful delivery has a lost local persistence receipt', async purpose => {
    const action = await actionPreview(purpose);
    const url = purpose === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/sender%40example.test/messages/send' : `${eventUrl}?sendUpdates=none`;
    enqueue('POST', url, { id: purpose === 'gmail' ? 'synthetic-accepted' : calendarEventId(action.id) });
    state.loseFinish = true;
    expect((await call(purpose, confirmation(action), { status: 200 })).data.action.state).toBe('uncertain');
    expect(state.loseFinish).toBe(false);
    // GET recovers the actual committed receipt; another confirm cannot resend.
    expect((await call(`${purpose}?id=${action.id}`, undefined, { status: 200 })).data.action.state).toBe('completed');
    expect((await call(purpose, confirmation(action), { status: 200 })).data.action.state).toBe('completed');
    expect(state.calls.filter(call => call.url === url)).toHaveLength(1);
  });

  it('retains real RLS and private session/action table denials with bounded IN predicates', async () => {
    const query = pgliteClient(db, 'authenticated', identities.alice, { organizerQueries: true, allowedRpcs: [], allowedTables: ['contacts'] });
    expect((await query.from('contacts').select('id').in('id', [seeded.alice.contact.id, seeded.bob.contact.id])).data).toEqual([{ id: seeded.alice.contact.id }]);
    expect((await query.from('contacts').select('id').in('name', ["'); delete from contacts; --"])).data).toEqual([]);
    expect((await db.query('select id from contacts')).rows).toHaveLength(2);
    expect(() => query.from('contacts').in('id', [])).toThrow('IN values');
    expect(() => query.from('contacts').in('id', Array(101).fill('a'))).toThrow('IN values');
    expect(() => pgliteClient(db, 'authenticated', identities.alice, { maxLimit: 1002 })).toThrow('limit ceiling');
    expect(() => query.from('contacts').limit(101)).toThrow('test limit');
    const expanded = pgliteClient(db, 'authenticated', identities.alice, { organizerQueries: true, maxLimit: 1001 });
    expect((await expanded.from('contacts').select('id').limit(1001)).data).toHaveLength(1);
    expect(() => expanded.from('contacts').limit(1002)).toThrow('test limit');
    for (const table of ['google_connector_sessions', 'google_confirmed_actions']) await expect(asRole(db, 'authenticated', identities.alice, tx => tx.query(`select * from ${table}`))).rejects.toThrow('permission denied');
  });
});

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as fileSystem from 'node:fs';
