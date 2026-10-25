import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rows: [], contacts: [], cookieJar: new Map(), cookieWrites: [], owner: '11111111-1111-4111-8111-111111111111',
  schemaMissing: false, replacementMissing: false, rateAllowed: true, importLostResponse: false, operations: [],
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: (name) => mock.cookieJar.has(name) ? { value: mock.cookieJar.get(name) } : undefined,
  set: (name, value, options) => { mock.cookieJar.set(name, value); mock.cookieWrites.push({ name, value, options }); },
}) }));
vi.mock('../lib/supabase/server', () => ({ userClient: async () => ({ auth: { getUser: async () => ({ data: { user: mock.owner ? { id: mock.owner } : null }, error: null }) } }) }));
vi.mock('../lib/supabase/admin', () => ({ adminClient: () => ({
  from: (table) => {
    if (table !== 'google_connector_sessions') throw new Error('Unexpected table');
    let operation = 'select'; let patch; let returning = false; let rowLimit = Infinity;
    const filters = [];
    const query = {
      select: () => { returning = true; return query; },
      update: (data) => { operation = 'update'; patch = data; return query; },
      upsert: (data) => { operation = 'upsert'; patch = data; return query; },
      delete: () => { operation = 'delete'; return query; },
      eq: (key, value) => { filters.push((row) => row[key] === value); return query; },
      gt: (key, value) => { filters.push((row) => row[key] > value); return query; },
      lte: (key, value) => { filters.push((row) => row[key] <= value); return query; },
      limit: (limit) => { rowLimit = limit; return query; },
      then: (resolve, reject) => Promise.resolve().then(() => {
        mock.operations.push(operation);
        if (mock.schemaMissing) return { data: null, error: { message: 'missing table' } };
        let rows = mock.rows.filter((row) => filters.every((filter) => filter(row))).slice(0, rowLimit);
        if (operation === 'upsert') {
          mock.rows = mock.rows.filter((row) => !(row.user_id === patch.user_id && row.purpose === patch.purpose));
          mock.rows.push({ ...patch }); rows = [patch];
        }
        if (operation === 'update') rows.forEach((row) => Object.assign(row, patch));
        if (operation === 'delete') mock.rows = mock.rows.filter((row) => !rows.includes(row));
        return { data: returning ? rows.map((row) => ({ ...row })) : null, error: null };
      }).then(resolve, reject),
    };
    return query;
  },
  rpc: async (name, args) => {
    mock.operations.push(name);
    if (name === 'hit_rate_limit') return { data: mock.rateAllowed, error: null };
    if (name === 'google_connector_purpose_ready') return { data: !mock.schemaMissing && !mock.replacementMissing, error: null };
    if (name === 'replace_google_connector_session') {
      if (mock.schemaMissing || mock.replacementMissing) return { data: null, error: { message: 'Missing connector replacement function' } };
      const existing = mock.rows.find((row) => row.user_id === args.p_owner && row.purpose === args.p_purpose);
      if (existing?.locked_until && Date.parse(existing.locked_until) > Date.now()) return { data: null, error: { message: 'connector_busy' } };
      if (existing?.protected_action && Date.parse(existing.expires_at) > Date.now()) return { data: null, error: { message: 'connector_action_pending' } };
      mock.rows = mock.rows.filter((row) => row !== existing);
      mock.rows.push({ id: args.p_id, user_id: args.p_owner, purpose: args.p_purpose, encrypted_payload: args.p_payload, expires_at: args.p_expires_at, lease: null, locked_until: null, protected_action: false });
      return { data: null, error: null };
    }

    if (name === 'claim_google_connector_session') {
      const row = mock.rows.find((row) => row.id === args.p_id && row.user_id === args.p_owner && row.purpose === args.p_purpose);
      if (!row) return { data: [], error: null };
      if (new Date(row.expires_at).getTime() <= Date.now()) { mock.rows = mock.rows.filter((item) => item !== row); return { data: [], error: null }; }
      if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) return { data: null, error: { message: 'connector_busy' } };
      row.lease = args.p_lease; row.locked_until = new Date(Date.now() + 30000).toISOString();
      return { data: [{ encrypted_payload: row.encrypted_payload, expires_at: row.expires_at }], error: null };
    }
    const matches = (existing, candidate) => existing.email && candidate.email
      ? existing.email.trim().toLowerCase() === candidate.email.trim().toLowerCase()
      : existing.name.trim().toLowerCase() === candidate.name.trim().toLowerCase();
    if (name === 'preview_google_contact_duplicates') return { data: args.p_contacts.filter((candidate) => mock.contacts.some((existing) => existing.user_id === args.p_owner && matches(existing, candidate))).map(({ id }) => ({ id })), error: null };
    if (name === 'import_google_contacts') {
      const row = mock.rows.find((row) => row.id === args.p_session && row.user_id === args.p_owner && row.purpose === args.p_purpose && row.lease === args.p_lease);
      if (!row) return { data: null, error: { message: 'connector_expired' } };
      let added = 0; let skipped = 0;
      for (const candidate of args.p_contacts) {
        if (mock.contacts.some((existing) => existing.user_id === args.p_owner && matches(existing, candidate))) skipped++;
        else { mock.contacts.push({ ...candidate, user_id: args.p_owner }); added++; }
      }
      if (mock.importLostResponse) { mock.importLostResponse = false; return { data: null, error: { message: 'Uncertain transport result' } }; }
      return { data: { added, skipped }, error: null };
    }
    throw new Error('Unexpected RPC: ' + name);
  },
}) }));

import { callback, cancel, preview, save, start, status } from '../lib/google/contacts-routes';
import { acquireGoogleSession, checkpointGoogleSession, CONTACTS_SCOPE, googleConfig, unseal } from '../lib/google/connector';
const origin = 'https://example.test';
const request = (action = '', body) => new Request(origin + '/api/me/integrations/google/contacts' + action, { method: action ? 'POST' : 'GET', headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
let googleFetch;
beforeEach(() => {
  mock.rows = []; mock.contacts = []; mock.cookieJar = new Map(); mock.cookieWrites = []; mock.operations = [];
  mock.owner = '11111111-1111-4111-8111-111111111111'; mock.schemaMissing = false; mock.replacementMissing = false; mock.rateAllowed = true; mock.importLostResponse = false;
  vi.stubEnv('GOOGLE_CONTACTS_CLIENT_ID', 'synthetic-client'); vi.stubEnv('GOOGLE_CONTACTS_CLIENT_SECRET', 'synthetic-secret');
  vi.stubEnv('GOOGLE_CONNECTOR_ORIGIN', origin); vi.stubEnv('GOOGLE_CONNECTOR_ENCRYPTION_KEY', Buffer.alloc(32, 42).toString('base64'));
  googleFetch = vi.fn(() => { throw new Error('External requests are forbidden in tests'); }); vi.stubGlobal('fetch', googleFetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function connect() {
  const response = await start(request('/start'));
  expect(response.status).toBe(200);
  const { authorization_url } = await response.json();
  return new URL(authorization_url).searchParams.get('state');
}
async function authorize() {
  const state = await connect();
  googleFetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-token', scope: CONTACTS_SCOPE, expires_in: 3600, token_type: 'Bearer', refresh_token: 'discard-me' })));
  const response = await callback(new Request(origin + '/api/me/integrations/google/contacts/callback?code=synthetic-code&state=' + state));
  expect(response.headers.get('location')).toBe(origin + '/organizer/?google_import=ready#/google-contacts');
  return state;
}
async function loadPreview() {
  await authorize();
  googleFetch.mockResolvedValueOnce(new Response(JSON.stringify({ connections: [{ names: [{ displayName: 'Alice' }], emailAddresses: [{ value: 'alice@example.test' }] }, { names: [{ displayName: 'Bob' }] }] })));
  const response = await preview(request('/preview'));
  expect(response.status).toBe(200);
  return response.json();
}

describe('Google Contacts mocked request lifecycle', () => {
  it('exposes a friendly disabled state without configuration or schema', async () => {
    vi.stubEnv('GOOGLE_CONTACTS_CLIENT_SECRET', '');
    expect(await (await status(request())).json()).toEqual({ configured: false, ready: false });
    vi.stubEnv('GOOGLE_CONTACTS_CLIENT_SECRET', 'synthetic-secret'); mock.schemaMissing = true;
    expect(await (await status(request())).json()).toEqual({ configured: false, ready: false });
    expect(googleFetch).not.toHaveBeenCalled();
  });
  it('does not advertise or start Contacts with only the original connector table', async () => {
    mock.replacementMissing = true;
    expect(await (await status(request())).json()).toEqual({ configured: false, ready: false });
    expect((await start(request('/start'))).status).toBe(503);
    expect(mock.rows).toEqual([]); expect(mock.cookieWrites).toEqual([]); expect(googleFetch).not.toHaveBeenCalled();
  });
  it('requires application authentication and trusted origin', async () => {
    mock.owner = null;
    for (const route of [status, start, preview, save, cancel]) expect((await route(request('/x'))).status).toBe(401);
    mock.owner = '11111111-1111-4111-8111-111111111111';
    expect((await start(new Request(origin, { method: 'POST', headers: { origin: 'https://evil.test' } }))).status).toBe(403);
    expect(mock.rows).toEqual([]); expect(googleFetch).not.toHaveBeenCalled();
  });
  it('stores only encrypted OAuth state/verifier and opaque secure HttpOnly cookie', async () => {
    const state = await connect();
    expect(mock.rows[0].encrypted_payload).not.toContain(state);
    expect(mock.cookieWrites[0]).toMatchObject({ name: '__Secure-moup_google_contacts', options: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 900, path: '/api/me/integrations/google/contacts' } });
    expect(mock.cookieWrites[0].value).not.toBe(mock.rows[0].id);
    expect(await (await status(request())).json()).toEqual({ configured: true, ready: false, pending: true });
    expect(googleFetch).not.toHaveBeenCalled();
  });
  it('bounds start attempts and keeps existing sessions on denied start', async () => {
    mock.rateAllowed = false;
    expect((await start(request('/start'))).status).toBe(429);
    expect(mock.rows).toEqual([]);
  });
  it('rejects mismatched state without exchanging code, logging or persisting contacts', async () => {
    await connect();
    const response = await callback(new Request(origin + '/callback?code=SECRET&state=wrong&next=https://evil.test'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(origin + '/organizer/?google_import=expired#/google-contacts');
    expect(mock.rows).toHaveLength(1); expect(mock.rows[0].lease).toBeNull(); expect(mock.contacts).toEqual([]); expect(googleFetch).not.toHaveBeenCalled();
  });
  it('handles denied consent and clears transient access', async () => {
    const state = await connect();
    const response = await callback(new Request(origin + '/callback?error=access_denied&state=' + state));
    expect(response.headers.get('location')).toContain('google_import=denied');
    expect(mock.rows).toEqual([]); expect(googleFetch).not.toHaveBeenCalled();
  });
  it('rejects callback replay without a second code exchange', async () => {
    const state = await authorize();
    const response = await callback(new Request(origin + '/callback?code=synthetic-code&state=' + state));
    expect(response.headers.get('location')).toContain('google_import=expired');
    expect(googleFetch).toHaveBeenCalledTimes(1);
    expect(mock.rows).toHaveLength(1);
    expect((await (await status(request())).json()).ready).toBe(true);
  });
  it('an old callback using the new tab cookie cannot discard the new authorization', async () => {
    const oldState = await connect(); const newState = await connect();
    const response = await callback(new Request(origin + '/callback?code=synthetic-old&state=' + oldState));
    expect(response.headers.get('location')).toContain('expired');
    expect(mock.rows).toHaveLength(1); expect(googleFetch).not.toHaveBeenCalled();
    const row = mock.rows[0];
    expect(unseal(row.encrypted_payload, googleConfig('contacts'), row.id, row.user_id).state).toBe(newState);
    expect(row.lease).toBeNull();
  });
  it('binds callback/preview/import/cancel to signed-in owner', async () => {
    const state = await connect(); const actualOwner = mock.owner;
    mock.owner = '22222222-2222-4222-8222-222222222222';
    const response = await callback(new Request(origin + '/callback?code=synthetic-code&state=' + state));
    expect(response.headers.get('location')).toContain('expired'); expect(mock.rows[0].user_id).toBe(actualOwner);
    expect((await preview(request('/preview'))).status).toBe(410);
    await cancel(request('/cancel')); expect(mock.rows[0].user_id).toBe(actualOwner);
  });
  it('handles expired sessions and leaves no credentials after lookup', async () => {
    await connect(); mock.rows[0].expires_at = new Date(0).toISOString();
    expect(await (await status(request())).json()).toEqual({ configured: true, ready: false });
    expect(mock.rows).toEqual([]);
  });
  it('loads only a preview, drops token when all pages are loaded, and never auto-imports', async () => {
    const result = await loadPreview();
    expect(result.contacts).toHaveLength(2); expect(result.loaded).toBe(true); expect(result.has_more).toBe(false);
    expect(mock.contacts).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-token|refresh|SECRET|state/);
    const row = mock.rows[0];
    expect(unseal(row.encrypted_payload, googleConfig('contacts'), row.id, row.user_id).token).toBeNull();
    expect((await status(request())).headers.get('cache-control')).toContain('no-store');
  });
  it('requires actual preview IDs and explicit valid categories before saving', async () => {
    const result = await loadPreview();
    expect((await save(request('/import', { selections: [{ id: '99999999-9999-4999-8999-999999999999', category: 'personal' }] }))).status).toBe(400);
    expect((await save(request('/import', { selections: [{ id: result.contacts[0].id, category: 'wrong' }] }))).status).toBe(400);
    expect(mock.contacts).toEqual([]);
    const response = await save(request('/import', { selections: [{ id: result.contacts[0].id, category: 'professional' }] }));
    expect(await response.json()).toEqual({ added: 1, skipped: 0 });
    expect(mock.contacts[0]).toMatchObject({ name: 'Alice', email: 'alice@example.test', category: 'professional' });
    expect((await (await status(request())).json()).contacts[0].duplicate).toBe(true);
  });
  it('is safe to retry after a lost import response and rejects duplicate selection IDs', async () => {
    const result = await loadPreview(); const selection = { id: result.contacts[0].id, category: 'personal' };
    expect((await save(request('/import', { selections: [selection, selection] }))).status).toBe(400);
    mock.importLostResponse = true;
    expect((await save(request('/import', { selections: [selection] }))).status).toBe(503);
    expect(await (await save(request('/import', { selections: [selection] }))).json()).toEqual({ added: 0, skipped: 1 });
    expect(mock.contacts).toHaveLength(1);
  });
  it('reports quota errors without advancing the page, and supports retry', async () => {
    await authorize();
    googleFetch.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect((await preview(request('/preview'))).status).toBe(429);
    expect((await (await status(request())).json()).loaded).toBe(false);
    googleFetch.mockResolvedValueOnce(new Response(JSON.stringify({ connections: [] })));
    expect((await preview(request('/preview'))).status).toBe(200);
  });
  it('cancel deletes token/preview/cookie and late reads cannot restore them', async () => {
    await authorize();
    let respond;
    googleFetch.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const pending = preview(request('/preview'));
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'));
    expect((await cancel(request('/cancel'))).status).toBe(200);
    respond(new Response(JSON.stringify({ connections: [] })));
    expect((await pending).status).toBe(410);
    expect(mock.rows).toEqual([]); expect(mock.cookieWrites.at(-1).options.maxAge).toBe(0);
  });
  it('blocks replacement during exchange and preserves a new connection after explicit cancellation', async () => {
    const state = await connect(); let respond;
    googleFetch.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const pending = callback(new Request(origin + '/callback?code=synthetic-code&state=' + state));
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'));
    expect((await start(request('/start'))).status).toBe(409);
    expect(mock.cookieWrites).toHaveLength(1);
    expect((await cancel(request('/cancel'))).status).toBe(200);
    const newState = await connect();
    respond(new Response(JSON.stringify({ access_token: 'synthetic-token', scope: CONTACTS_SCOPE, expires_in: 60, token_type: 'Bearer' })));
    await pending;
    expect(mock.rows).toHaveLength(1);
    const row = mock.rows[0];
    expect(unseal(row.encrypted_payload, googleConfig('contacts'), row.id, row.user_id).state).toBe(newState);
  });
  it('checkpoints a durable intent without unlocking, and cannot revive an expired lease', async () => {
    await connect();
    const config = googleConfig('contacts');
    const session = await acquireGoogleSession(config, mock.owner);
    session.payload = { phase: 'mutation-intent', id: 'synthetic-operation' };
    await checkpointGoogleSession(config, session);
    expect(mock.rows[0].lease).toBe(session.lease);
    expect(unseal(mock.rows[0].encrypted_payload, config, session.id, mock.owner)).toEqual(session.payload);
    expect((await status(request())).status).toBe(409);
    mock.rows[0].locked_until = new Date(0).toISOString();
    await expect(checkpointGoogleSession(config, session)).rejects.toThrow('expired');
  });
});
