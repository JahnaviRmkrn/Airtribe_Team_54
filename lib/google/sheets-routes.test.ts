import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleConfig, Session } from './connector';
import type { SheetsPayload } from './sheets-types';
const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), rpc: vi.fn(), from: vi.fn(), acquire: vi.fn(), checkpoint: vi.fn(), save: vi.fn(), release: vi.fn(), create: vi.fn(), discard: vi.fn(), remove: vi.fn(), consume: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/http', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/http')>(), requireUser: mocks.requireUser }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('./connector', async importOriginal => ({
  ...await importOriginal<typeof import('./connector')>(), acquireGoogleSession: mocks.acquire, checkpointGoogleSession: mocks.checkpoint, saveGoogleSession: mocks.save,
  releaseGoogleSession: mocks.release, createGoogleSession: mocks.create, deleteGoogleSession: mocks.remove, discardGoogleSession: mocks.discard, consumeGoogleAuthorization: mocks.consume,
}));
import { HttpError } from '@/lib/http';
import { sheetsCallback, sheetsConnect, sheetsDisconnect, sheetsExportConfirm, sheetsExportPreview, sheetsImportConfirm, sheetsImportPreview, sheetsSource, sheetsStatus } from './sheets-routes';

const owner = '11111111-1111-4111-8111-111111111111';
const contactId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const bookId = 'a'.repeat(30);
const createdId = 'b'.repeat(30);
const origin = 'https://example.test';
const stored = new Map<string, Session<SheetsPayload>>();
let contacts: Record<string, unknown>[];
let filters: [string, unknown][];
let selectedColumns: string;
const ready = (): SheetsPayload => ({ phase: 'ready', token: 'synthetic-token', tokenExpiresAt: Date.now() + 60_000, destinationEmail: 'destination@example.test' });
function request(body?: unknown, sourceOrigin = origin) { return new Request(`${origin}/api/me/integrations/google/sheets-export/confirm`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: sourceOrigin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
function payload(mode: 'import' | 'export' = 'export') { return stored.get(`sheets-${mode}`)!.payload; }
async function prepareExport(fields = ['name', 'email'], includeNotes = false) {
  const response = await sheetsExportPreview(request({ contactIds: [contactId], title: 'Exact destination', fields, includeNotes }));
  expect(response.status).toBe(200);
  return payload().exportPreview!.id;
}
beforeEach(() => {
  vi.clearAllMocks(); stored.clear(); filters = []; selectedColumns = '';
  for (const mode of ['import', 'export']) stored.set(`sheets-${mode}`, { id: `session-${mode}`, owner, lease: `lease-${mode}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), payload: ready() });
  for (const [name, value] of Object.entries({ GOOGLE_SHEETS_CLIENT_ID: 'synthetic-client', GOOGLE_SHEETS_CLIENT_SECRET: 'synthetic-secret', GOOGLE_CONNECTOR_ORIGIN: origin, GOOGLE_CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') })) vi.stubEnv(name, value);
  contacts = [{ id: contactId, name: '=literal', email: 'ada@example.test', category: 'personal', interests: ['tea'], notes: 'private secret note' }];
  mocks.requireUser.mockResolvedValue({ user: { id: owner }, supabase: { from: mocks.from } });
  mocks.from.mockImplementation(() => {
    let ids: string[] | undefined;
    const chain = {
      select: (columns: string) => { selectedColumns = columns; return chain; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return chain; },
      in: (_key: string, values: string[]) => { ids = values; return chain; }, order: () => chain, limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => resolve({ data: contacts.filter(c => !ids || ids.includes(String(c.id))).map(c => Object.fromEntries(selectedColumns.split(',').map(field => [field, c[field]]))), error: null }),
    };
    return chain;
  });
  mocks.acquire.mockImplementation(async (config: GoogleConfig, requestingOwner: string) => {
    if (requestingOwner !== owner || !stored.has(config.purpose)) throw new HttpError(410, 'Expired');
    return structuredClone(stored.get(config.purpose));
  });
  const persist = async (config: GoogleConfig, session: Session<SheetsPayload>) => { stored.set(config.purpose, structuredClone(session)); };
  mocks.save.mockImplementation(persist); mocks.checkpoint.mockImplementation(persist);
  mocks.remove.mockImplementation(async (config: GoogleConfig) => { stored.delete(config.purpose); });
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'google_connector_session_ready' ? true : name === 'preview_google_contact_duplicates' ? [] : { added: 1, skipped: 0 }, error: null }));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network: configure a synthetic mock'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Sheets session and consent isolation', () => {
  it('returns a friendly disabled state without configuration and never reads private notes', async () => {
    vi.stubEnv('GOOGLE_SHEETS_CLIENT_SECRET', '');
    const result = await (await sheetsStatus('export')(request())).json();
    expect(result.configured).toBe(false); expect(result.session.connected).toBe(false);
    expect(selectedColumns).toBe('id,name,email,category');
    expect(JSON.stringify(result)).not.toContain('private secret');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires authentication and same-origin before connecting', async () => {
    expect((await sheetsConnect('import')(request({}, 'https://evil.test'))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.requireUser.mockRejectedValue(new HttpError(401, 'Not signed in'));
    expect((await sheetsStatus('export')(request())).status).toBe(401);
  });
  it('does not advertise a ready connector when the additive schema probe is missing', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Missing readiness RPC' } });
    const result = await (await sheetsStatus('export')(request())).json();
    expect(result.configured).toBe(false); expect(result.session.connected).toBe(false);
    expect(mocks.acquire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([['import', 'spreadsheets.readonly'], ['export', 'drive.file']] as const)('requests only %s scope and creates no Google file', async (mode, scope) => {
    const result = await (await sheetsConnect(mode)(request({}))).json();
    const url = new URL(result.url);
    expect(url.searchParams.get('scope')).toBe(`https://www.googleapis.com/auth/${scope}`);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/me/integrations/google/sheets-${mode}/callback`);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('honors the owner/purpose database guard when another browser has no current cookie', async () => {
    const previewId = await prepareExport();
    payload().exportRun = { previewId, state: 'uncertain' };
    const before = structuredClone(payload());
    mocks.acquire.mockRejectedValueOnce(new HttpError(410, 'No cookie in this browser'));
    mocks.create.mockRejectedValueOnce(new HttpError(409, 'A previous Google action may have completed.'));
    expect((await sheetsConnect('export')(request({}))).status).toBe(409);
    expect(mocks.create).toHaveBeenCalledOnce(); expect(payload()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('honors the atomic replacement guard when confirm starts after the cookie precheck releases its lease', async () => {
    const previewId = await prepareExport();
    mocks.release.mockImplementationOnce(async () => { payload().exportRun = { previewId, state: 'creating' }; });
    mocks.create.mockImplementationOnce(async () => { throw new HttpError(409, 'A Google action is still running.'); });
    expect((await sheetsConnect('export')(request({}))).status).toBe(409);
    expect(payload().exportRun?.state).toBe('creating'); expect(fetch).not.toHaveBeenCalled();
  });
  it('invalid state and cancelled consent never import, export, or exchange a token', async () => {
    payload('import').phase = 'oauth'; payload('import').state = 'a'.repeat(43); payload('import').verifier = 'verifier';
    let response = await sheetsCallback('import')(new Request(`${origin}/callback?state=wrong&code=code`));
    expect(response.headers.get('location')).toContain('google=error');
    expect(mocks.consume).not.toHaveBeenCalled();
    response = await sheetsCallback('import')(new Request(`${origin}/callback?state=${'a'.repeat(43)}&error=access_denied`));
    expect(response.headers.get('location')).toContain('google=cancelled');
    expect(mocks.discard).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('verifies destination account using drive.file without listing files or adding scopes', async () => {
    payload().phase = 'oauth'; payload().state = 'a'.repeat(43); payload().verifier = 'verifier';
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-token', token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { emailAddress: 'verified@example.test' } })));
    const response = await sheetsCallback('export')(new Request(`${origin}/callback?state=${'a'.repeat(43)}&code=synthetic-code`));
    expect(response.headers.get('location')).toContain('google=sheets-export');
    expect(payload().destinationEmail).toBe('verified@example.test');
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)');
    expect(mocks.consume).toHaveBeenCalledOnce(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('preserves a newer ready preview when an old or replayed callback arrives', async () => {
    const previewId = await prepareExport();
    const before = structuredClone(payload());
    const response = await sheetsCallback('export')(new Request(`${origin}/callback?state=${'z'.repeat(43)}&error=access_denied`));
    expect(response.headers.get('location')).toContain('google=error');
    expect(payload()).toEqual(before); expect(payload().exportPreview?.id).toBe(previewId);
    expect(mocks.discard).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('disconnect only removes its purpose session, with zero Google calls and zero contact writes', async () => {
    await sheetsDisconnect('export')(request({}));
    expect(stored.has('sheets-export')).toBe(false); expect(stored.has('sheets-import')).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('never serializes credentials into session status', async () => {
    const result = await (await sheetsStatus('export')(request())).text();
    expect(result).not.toContain('synthetic-token'); expect(result).not.toContain('tokenExpiresAt');
  });
});

describe('Sheets source, mapping and imports', () => {
  beforeEach(() => { payload('import').source = { spreadsheetId: bookId, title: 'Chosen', sheetId: 0, sheetTitle: 'Contacts', range: "'Contacts'!A1:Z101", values: [['Name', 'Email', 'Notes'], ['Ada', 'ada@example.test', 'private'], ['Ada', 'ada@example.test', 'private']] }; });
  it('validates IDs and worksheet selection before requesting a fixed bounded range', async () => {
    expect((await sheetsSource(request({ spreadsheetId: '../secret' }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: bookId, properties: { title: 'Chosen' }, sheets: [{ properties: { sheetId: 7, title: "Ada's" } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: [['Name'], ['Ada']] })));
    expect((await sheetsSource(request({ spreadsheetId: bookId, sheetId: 7 }))).status).toBe(200);
    const target = new URL(String(vi.mocked(fetch).mock.calls[1][0]));
    expect(decodeURIComponent(target.pathname)).toContain("'Ada''s'!A1:Z101");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects a tab not in the selected spreadsheet and never follows arbitrary destinations', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: bookId, properties: { title: 'Chosen' }, sheets: [{ properties: { sheetId: 7, title: 'People' } }] })));
    expect((await sheetsSource(request({ spreadsheetId: bookId, sheetId: 99 }))).status).toBe(400);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('previews without writing, flags within-batch duplicates and excludes unmapped notes', async () => {
    expect((await sheetsImportPreview(request({ rows: [2, 3], mapping: { name: 0, email: 1 }, defaultCategory: 'personal' }))).status).toBe(200);
    expect(payload('import').importPreview?.rows.map(r => r.duplicate)).toEqual([false, true]);
    expect(payload('import').importPreview?.rows[0].contact?.notes).toBeNull();
    expect(mocks.rpc.mock.calls.every(call => call[0] === 'preview_google_contact_duplicates')).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it('never lets a skipped name-only duplicate bridge two distinct email contacts', async () => {
    payload('import').source!.values = [['Name', 'Email'], ['Ada', 'a@example.test'], ['Ada', ''], ['Ada', 'b@example.test']];
    await sheetsImportPreview(request({ rows: [2, 3, 4], mapping: { name: 0, email: 1 }, defaultCategory: 'personal' }));
    expect(payload('import').importPreview!.rows.map(row => row.duplicate)).toEqual([false, true, false]);
    await sheetsImportConfirm(request({ previewId: payload('import').importPreview!.id }));
    const write = mocks.rpc.mock.calls.find(call => call[0] === 'import_google_contacts')!;
    expect(write[1].p_contacts.map((contact: { email: string }) => contact.email)).toEqual(['a@example.test', 'b@example.test']);
  });
  it('saves only the server-side reviewed rows on explicit confirmation; repeat clicks have no second write', async () => {
    await sheetsImportPreview(request({ rows: [2], mapping: { name: 0, email: 1, notes: 2 }, defaultCategory: 'personal', includeNotes: true }));
    const previewId = payload('import').importPreview!.id;
    expect((await sheetsImportConfirm(request({ previewId, contacts: [] }))).status).toBe(400);
    const response = await sheetsImportConfirm(request({ previewId }));
    expect((await response.json()).result).toMatchObject({ state: 'complete', added: 1 });
    await sheetsImportConfirm(request({ previewId }));
    const writes = mocks.rpc.mock.calls.filter(call => call[0] === 'import_google_contacts');
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ p_owner: owner, p_purpose: 'sheets-import', p_contacts: [{ name: 'Ada', email: 'ada@example.test', notes: 'private', category: 'personal', interests: [] }] });
    expect(mocks.checkpoint).toHaveBeenCalledOnce();
  });
  it('blocks invalid rows and stale preview IDs', async () => {
    await sheetsImportPreview(request({ rows: [10], mapping: { name: 0 }, defaultCategory: 'personal' }));
    expect((await sheetsImportConfirm(request({ previewId: payload('import').importPreview!.id }))).status).toBe(400);
    expect((await sheetsImportConfirm(request({ previewId: otherId }))).status).toBe(409);
    expect(mocks.rpc.mock.calls.some(call => call[0] === 'import_google_contacts')).toBe(false);
  });
  it('persists uncertainty and does not retry an ambiguous import', async () => {
    await sheetsImportPreview(request({ rows: [2], mapping: { name: 0 }, defaultCategory: 'personal' }));
    const previewId = payload('import').importPreview!.id;
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Unknown transport result' } });
    await sheetsImportConfirm(request({ previewId })); await sheetsImportConfirm(request({ previewId }));
    expect(payload('import').importRun?.state).toBe('uncertain');
    expect(mocks.rpc.mock.calls.filter(call => call[0] === 'import_google_contacts')).toHaveLength(1);
  });
});

describe('Sheets exact export and uncertain-result safety', () => {
  it('previews selected owned contacts only, no provider call and no private-note query', async () => {
    await prepareExport();
    expect(selectedColumns).not.toContain('notes'); expect(filters).toContainEqual(['user_id', owner]);
    expect(payload().exportPreview).toMatchObject({ destinationEmail: 'destination@example.test', title: 'Exact destination', values: [['Name', 'Email'], ['=literal', 'ada@example.test']] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fetches notes only after explicit field selection and opt-in, shows exact notes in preview', async () => {
    expect((await sheetsExportPreview(request({ contactIds: [contactId], title: 'No', fields: ['notes'] }))).status).toBe(400);
    await prepareExport(['name', 'notes'], true);
    expect(selectedColumns).toContain('notes'); expect(payload().exportPreview?.values[1]).toEqual(['=literal', 'private secret note']);
  });
  it('rejects missing/foreign contacts and rechecks ownership before action', async () => {
    expect((await sheetsExportPreview(request({ contactIds: [otherId], fields: ['name'], title: 'No' }))).status).toBe(409);
    const previewId = await prepareExport(); contacts = [];
    expect((await sheetsExportConfirm(request({ previewId }))).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checkpoints intent, creates one NEW file, checkpoints its ID, then writes RAW exact preview once', async () => {
    const previewId = await prepareExport();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: createdId }))).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: createdId, updatedRange: 'Contacts!A1:B2', updatedRows: 2, updatedColumns: 2, updatedCells: 4 })));
    const response = await sheetsExportConfirm(request({ previewId }));
    expect((await response.json()).result).toMatchObject({ state: 'complete', spreadsheetId: createdId });
    expect(mocks.checkpoint).toHaveBeenCalledTimes(2);
    const [createURL, createOptions] = vi.mocked(fetch).mock.calls[0];
    expect(createURL).toBe('https://sheets.googleapis.com/v4/spreadsheets'); expect(createOptions?.method).toBe('POST');
    expect(JSON.parse(String(createOptions?.body))).toMatchObject({ properties: { title: 'Exact destination' }, sheets: [{ properties: { title: 'Contacts' } }] });
    const [writeURL, writeOptions] = vi.mocked(fetch).mock.calls[1];
    expect(String(writeURL)).toContain(`/${createdId}/values/`); expect(String(writeURL)).toContain('valueInputOption=RAW'); expect(writeOptions?.method).toBe('PUT');
    expect(JSON.parse(String(writeOptions?.body)).values).toEqual(payload().exportPreview?.values);
    await sheetsExportConfirm(request({ previewId })); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not send any request if durable intent cannot be saved', async () => {
    const previewId = await prepareExport(); mocks.checkpoint.mockRejectedValue(new Error('Storage unavailable'));
    expect((await sheetsExportConfirm(request({ previewId }))).status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects expired Google access before creating a file', async () => {
    const previewId = await prepareExport(); payload().tokenExpiresAt = 0;
    expect((await sheetsExportConfirm(request({ previewId }))).status).toBe(410);
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.checkpoint).not.toHaveBeenCalled();
  });
  it('treats a malformed or mismatched write receipt as uncertain, not success', async () => {
    const previewId = await prepareExport();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: createdId })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: bookId, updatedRange: 'Contacts!A1:B2', updatedRows: 2, updatedColumns: 2, updatedCells: 4 })));
    await sheetsExportConfirm(request({ previewId }));
    expect(payload().exportRun?.state).toBe('uncertain');
    await sheetsExportConfirm(request({ previewId })); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not send contact data if the created spreadsheet ID cannot be persisted', async () => {
    const previewId = await prepareExport();
    mocks.checkpoint.mockImplementationOnce(async (config: GoogleConfig, session: Session<SheetsPayload>) => { stored.set(config.purpose, structuredClone(session)); }).mockRejectedValueOnce(new Error('Storage unavailable'));
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ spreadsheetId: createdId })));
    await sheetsExportConfirm(request({ previewId }));
    expect(fetch).toHaveBeenCalledOnce(); expect(payload().exportRun?.state).toBe('uncertain');
  });
  it('never retries ambiguous creation, even after repeated confirm or reconnect clicks', async () => {
    const previewId = await prepareExport(); vi.mocked(fetch).mockRejectedValue(new Error('Timeout after provider may have created sheet'));
    await sheetsExportConfirm(request({ previewId })); await sheetsExportConfirm(request({ previewId }));
    expect(payload().exportRun?.state).toBe('uncertain'); expect(payload().exportRun?.spreadsheetId).toBeUndefined();
    expect((await sheetsConnect('export')(request({}))).status).toBe(409);
    expect((await sheetsExportConfirm(request({ checkOnly: true }))).status).toBe(409);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('reconciles an uncertain write using read-only exact values, with no append or rewrite', async () => {
    const previewId = await prepareExport();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: createdId }))).mockRejectedValueOnce(new Error('Lost write response'));
    await sheetsExportConfirm(request({ previewId })); expect(payload().exportRun?.state).toBe('uncertain');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ values: payload().exportPreview!.values })));
    await sheetsExportConfirm(request({ checkOnly: true })); expect(payload().exportRun?.state).toBe('complete');
    expect(vi.mocked(fetch).mock.calls[2][1]?.method).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('keeps a mismatched write uncertain without overwriting user changes', async () => {
    const previewId = await prepareExport();
    payload().exportRun = { previewId, state: 'uncertain', spreadsheetId: createdId };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ values: [['Name'], ['Someone edited this']] })));
    await sheetsExportConfirm(request({ checkOnly: true })); expect(payload().exportRun?.state).toBe('uncertain'); expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBeUndefined();
  });
  it('rejects caller-provided destinations/values and oversized bodies before any external action', async () => {
    const previewId = await prepareExport();
    expect((await sheetsExportConfirm(request({ previewId, spreadsheetId: bookId, values: [] }))).status).toBe(400);
    expect((await sheetsExportPreview(request({ title: 'x'.repeat(17_000) }))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses reviewed snapshot instead of silently replacing values edited after preview', async () => {
    const previewId = await prepareExport(); contacts[0].name = 'Changed after preview';
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: createdId }))).mockResolvedValueOnce(new Response(JSON.stringify({ spreadsheetId: createdId, updatedRange: 'Contacts!A1:B2', updatedRows: 2, updatedColumns: 2, updatedCells: 4 })));
    await sheetsExportConfirm(request({ previewId }));
    expect(String(vi.mocked(fetch).mock.calls[1][1]?.body)).not.toContain('Changed after preview');
  });
});
