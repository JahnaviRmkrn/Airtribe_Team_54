import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('../supabase/admin', () => ({ adminClient: () => { throw new Error('Live DB disabled'); } }));
vi.mock('../http', async (original) => ({ ...await original<typeof import('../http')>(), requireUser: vi.fn() }));
vi.mock('./connector', async (original) => ({
  ...await original<typeof import('./connector')>(), googleConfig: vi.fn(), googleConnectorSchemaReady: vi.fn(), acquireGoogleSession: vi.fn(), releaseGoogleSession: vi.fn(),
  createGoogleSession: vi.fn(), deleteGoogleSession: vi.fn(), discardGoogleSession: vi.fn(), consumeGoogleAuthorization: vi.fn(), saveGoogleSession: vi.fn(), exchangeCode: vi.fn(),
}));
vi.mock('./action-store', () => ({ loadAction: vi.fn(), recentActions: vi.fn(), actionView: vi.fn(), contentForAction: vi.fn(), storePreview: vi.fn(), claimAction: vi.fn(), finishAction: vi.fn(), cancelAction: vi.fn() }));
vi.mock('./action-provider', () => ({ performGoogleAction: vi.fn(), reconcileCalendarAction: vi.fn() }));
import { HttpError, requireUser } from '../http';
import * as connector from './connector';
import * as store from './action-store';
import * as provider from './action-provider';
import { actionRoutes } from './action-routes';
import { preparePreview, previewHash } from './action-content';
import type { StoredAction } from './action-store';
const owner = '11111111-1111-4111-8111-111111111111', id = '44444444-4444-4444-8444-444444444444';
const config: connector.GoogleConfig = { purpose: 'gmail', clientId: 'synthetic', clientSecret: 'synthetic', origin: 'https://example.test', redirectUri: 'https://example.test/api/me/integrations/google/gmail/callback', key: Buffer.alloc(32, 9), scope: 'https://www.googleapis.com/auth/gmail.send' };
const preview = preparePreview('gmail', { from: 'sender@example.test', to: ['person@example.test'], subject: 'Hello', body: 'Explicit body' });
const hash = previewHash(preview);
const session = () => ({ id: 'a'.repeat(64), owner, lease: id, expiresAt: new Date(Date.now() + 600000).toISOString(), payload: { phase: 'ready', token: 'synthetic-token', tokenExpiresAt: Date.now() + 600000 } });
const row = (state: StoredAction['state'] = 'preview'): StoredAction => ({ id, user_id: owner, purpose: 'gmail', session_id: 'a'.repeat(64), preview_hash: hash, encrypted_preview: 'synthetic-encrypted', state, provider_ref: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() });
const req = (body: unknown, origin: string | null = config.origin) => new Request(config.origin + '/api/me/integrations/google/gmail', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
const confirm = () => ({ operation: 'confirm', id, previewHash: hash, confirmed: true, senderAcknowledged: true });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('GOOGLE_GMAIL_ENABLED', 'true'); vi.stubEnv('GOOGLE_CALENDAR_ENABLED', 'true');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live network disabled'); }));
  vi.mocked(requireUser).mockResolvedValue({ user: { id: owner } } as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(connector.googleConfig).mockReturnValue(config);
  vi.mocked(connector.googleConnectorSchemaReady).mockResolvedValue(true);
  vi.mocked(connector.acquireGoogleSession).mockResolvedValue(session());
  vi.mocked(store.loadAction).mockResolvedValue(row()); vi.mocked(store.recentActions).mockResolvedValue([]);
  vi.mocked(store.claimAction).mockResolvedValue(row('claimed'));
  vi.mocked(store.contentForAction).mockReturnValue(preview);
  vi.mocked(store.actionView).mockImplementation((_c, a) => ({ id: a.id, purpose: a.purpose, previewHash: a.preview_hash, state: a.state, expiresAt: a.expires_at, createdAt: a.created_at, preview, providerRef: a.provider_ref }));
  vi.mocked(provider.performGoogleAction).mockResolvedValue({ state: 'completed', providerRef: 'provider123' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('explicit action endpoint boundaries', () => {
  it('is disabled by default even when Google credentials exist', async () => {
    vi.stubEnv('GOOGLE_GMAIL_ENABLED', '');
    const routes = actionRoutes('gmail');
    expect(await (await routes.GET(new Request(config.origin))).json()).toMatchObject({ enabled: false, connected: false });
    expect((await routes.POST(req({ operation: 'start' }))).status).toBe(503);
    expect(connector.createGoogleSession).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['gmail', 'calendar'] as const)('keeps %s disabled with a partial connector migration', async (purpose) => {
    vi.mocked(connector.googleConnectorSchemaReady).mockResolvedValue(false);
    const routes = actionRoutes(purpose);
    expect(await (await routes.GET(new Request(config.origin))).json()).toMatchObject({ enabled: false, connected: false });
    expect((await routes.POST(req({ operation: 'start' }))).status).toBe(503);
    expect((await routes.POST(req(confirm()))).status).toBe(503);
    expect(connector.createGoogleSession).not.toHaveBeenCalled(); expect(store.claimAction).not.toHaveBeenCalled();
    expect(provider.performGoogleAction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a real app user before disclosing saved content or setup status', async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, 'Not signed in'));
    expect((await actionRoutes('gmail').GET(new Request(config.origin))).status).toBe(401);
    expect(store.recentActions).not.toHaveBeenCalled();
  });
  it.each([null, 'https://evil.test'])('rejects absent/cross-site origin %s before state or provider writes', async (origin) => {
    expect((await actionRoutes('gmail').POST(req(confirm(), origin))).status).toBe(403);
    expect(store.claimAction).not.toHaveBeenCalled(); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('rejects chunked oversized JSON and unsupported content types without writes', async () => {
    expect((await actionRoutes('gmail').POST(req({ operation: 'preview', draft: 'x'.repeat(100001) }))).status).toBe(413);
    const bad = new Request(config.origin, { method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'text/plain' }, body: '{}' });
    expect((await actionRoutes('gmail').POST(bad)).status).toBe(415);
    expect(store.storePreview).not.toHaveBeenCalled();
  });
  it('only starts OAuth on an explicit start and never calls the provider', async () => {
    const response = await actionRoutes('gmail').POST(req({ operation: 'start' }));
    const data = await response.json();
    expect(new URL(data.authorizationUrl).searchParams.get('scope')).toBe(config.scope);
    expect(new URL(data.authorizationUrl).searchParams.get('prompt')).toBe('select_account consent');
    expect(connector.createGoogleSession).toHaveBeenCalledTimes(1); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('preview stores only bounded validated data without any external write', async () => {
    vi.mocked(store.storePreview).mockResolvedValue(row());
    expect((await actionRoutes('gmail').POST(req({ operation: 'preview', draft: { from: 'sender@example.test', to: ['person@example.test'], subject: 'Hello', body: 'Explicit body' } }))).status).toBe(200);
    expect(store.storePreview).toHaveBeenCalledWith(config, expect.objectContaining({ owner }), preview);
    expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it.each([{ ...confirm(), confirmed: false }, { ...confirm(), to: ['evil@example.test'] }, { ...confirm(), body: 'replacement' }, { ...confirm(), previewHash: 'wrong' }])('rejects unconfirmed or mutable confirmation payload %j', async (body) => {
    expect((await actionRoutes('gmail').POST(req(body))).status).toBe(400); expect(store.claimAction).not.toHaveBeenCalled();
  });
  it('requires explicit sender/account acknowledgment before sending', async () => {
    const body = { ...confirm() }; delete (body as { senderAcknowledged?: boolean }).senderAcknowledged;
    expect((await actionRoutes('gmail').POST(req(body))).status).toBe(400); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('rejects an altered preview binding and switched account/session', async () => {
    expect((await actionRoutes('gmail').POST(req({ ...confirm(), previewHash: 'f'.repeat(64) }))).status).toBe(409);
    vi.mocked(store.loadAction).mockResolvedValue({ ...row(), session_id: 'b'.repeat(64) });
    expect((await actionRoutes('gmail').POST(req(confirm()))).status).toBe(409); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('claims durably before its single write and saves the outcome', async () => {
    const response = await actionRoutes('gmail').POST(req(confirm()));
    expect(await response.json()).toMatchObject({ action: { state: 'completed' } });
    expect(provider.performGoogleAction).toHaveBeenCalledExactlyOnceWith(preview, id, hash, 'synthetic-token', expect.any(String));
    expect(vi.mocked(store.claimAction).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(provider.performGoogleAction).mock.invocationCallOrder[0]);
    expect(store.finishAction).toHaveBeenCalledWith(config, owner, id, { state: 'completed', providerRef: 'provider123' });
  });
  it.each(['claimed', 'uncertain', 'completed', 'cancelled', 'rejected', 'expired'] as const)('never replays action in state %s', async (state) => {
    vi.mocked(store.loadAction).mockResolvedValue(row(state));
    expect(await (await actionRoutes('gmail').POST(req(confirm()))).json()).toMatchObject({ action: { state } });
    expect(store.claimAction).not.toHaveBeenCalled(); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('does not send after a competing or uncertain claim', async () => {
    vi.mocked(store.claimAction).mockResolvedValue(null);
    await actionRoutes('gmail').POST(req(confirm())); expect(provider.performGoogleAction).not.toHaveBeenCalled();
    vi.mocked(store.claimAction).mockRejectedValue(new Error('Claim may have committed'));
    expect((await actionRoutes('gmail').POST(req(confirm()))).status).toBe(503); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('reports uncertainty when saving an accepted provider outcome fails', async () => {
    vi.mocked(store.finishAction).mockRejectedValue(new Error('Storage failed'));
    const response = await actionRoutes('gmail').POST(req(confirm()));
    expect(await response.json()).toMatchObject({ action: { state: 'uncertain' } }); expect(provider.performGoogleAction).toHaveBeenCalledTimes(1);
  });
  it('cancel/back never calls a provider and cannot pretend to undo a claimed send', async () => {
    vi.mocked(store.cancelAction).mockResolvedValue(row('claimed'));
    expect(await (await actionRoutes('gmail').POST(req({ operation: 'cancel', id }))).json()).toMatchObject({ action: { state: 'claimed' } });
    expect(connector.acquireGoogleSession).not.toHaveBeenCalled(); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('status recovery works after the OAuth session is gone and is read-only', async () => {
    vi.mocked(connector.acquireGoogleSession).mockRejectedValue(new HttpError(410, 'expired'));
    vi.mocked(store.recentActions).mockResolvedValue([row('uncertain')]);
    const data = await (await actionRoutes('gmail').GET(new Request(config.origin))).json();
    expect(data).toMatchObject({ connected: false, actions: [{ state: 'uncertain' }] }); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
  it('does not attempt mailbox reads under send-only scope', async () => {
    expect((await actionRoutes('gmail').POST(req({ operation: 'reconcile', id }))).status).toBe(400);
    expect(provider.reconcileCalendarAction).not.toHaveBeenCalled();
  });
  it('calendar reconciliation only calls the read helper, never insert', async () => {
    vi.mocked(connector.googleConfig).mockReturnValue({ ...config, purpose: 'calendar' });
    vi.mocked(store.loadAction).mockResolvedValue(row('uncertain'));
    vi.mocked(provider.reconcileCalendarAction).mockResolvedValue({ state: 'uncertain' });
    await actionRoutes('calendar').POST(req({ operation: 'reconcile', id }));
    expect(provider.reconcileCalendarAction).toHaveBeenCalledExactlyOnceWith(id, hash, 'synthetic-token'); expect(provider.performGoogleAction).not.toHaveBeenCalled();
  });
});

describe('action OAuth callbacks', () => {
  it('does not discard a newer authorization on stale or mismatched state', async () => {
    const payload = { phase: 'authorizing', state: 'a'.repeat(43), verifier: 'synthetic-verifier' };
    vi.mocked(connector.acquireGoogleSession).mockResolvedValue({ ...session(), payload });
    const response = await actionRoutes('gmail').callback(new Request(config.redirectUri + '?state=' + 'b'.repeat(43) + '&code=synthetic'));
    expect(response.status).toBe(303); expect(connector.discardGoogleSession).not.toHaveBeenCalled(); expect(connector.exchangeCode).not.toHaveBeenCalled();
    expect(connector.releaseGoogleSession).toHaveBeenCalled();
  });
  it('ignores a replayed callback against a ready connection without deleting it', async () => {
    await actionRoutes('gmail').callback(new Request(config.redirectUri + '?state=' + 'a'.repeat(43) + '&code=replay'));
    expect(connector.discardGoogleSession).not.toHaveBeenCalled(); expect(connector.exchangeCode).not.toHaveBeenCalled();
    expect(connector.releaseGoogleSession).toHaveBeenCalled();
  });
  it('consumes matched state before exchange and stores only a ready short-lived token payload', async () => {
    const payload = { phase: 'authorizing', state: 'a'.repeat(43), verifier: 'synthetic-verifier' };
    vi.mocked(connector.acquireGoogleSession).mockResolvedValue({ ...session(), payload });
    vi.mocked(connector.exchangeCode).mockResolvedValue({ token: 'synthetic-token', tokenExpiresAt: Date.now() + 60000 });
    const response = await actionRoutes('gmail').callback(new Request(config.redirectUri + '?state=' + 'a'.repeat(43) + '&code=synthetic'));
    expect(vi.mocked(connector.consumeGoogleAuthorization).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(connector.exchangeCode).mock.invocationCallOrder[0]);
    expect(connector.saveGoogleSession).toHaveBeenCalledWith(config, expect.objectContaining({ payload: { phase: 'ready', token: 'synthetic-token', tokenExpiresAt: expect.any(Number) } }));
    expect(response.headers.get('location')).toBe('https://example.test/organizer/#/gmail'); expect(response.headers.get('location')).not.toContain('token');
  });
  it('cancellation discards only the verified matching session, never a newer owner session', async () => {
    vi.mocked(connector.acquireGoogleSession).mockResolvedValue({ ...session(), payload: { phase: 'authorizing', state: 'a'.repeat(43), verifier: 'synthetic' } });
    await actionRoutes('gmail').callback(new Request(config.redirectUri + '?state=' + 'a'.repeat(43) + '&error=access_denied'));
    expect(connector.discardGoogleSession).toHaveBeenCalledTimes(1); expect(connector.deleteGoogleSession).not.toHaveBeenCalled(); expect(connector.exchangeCode).not.toHaveBeenCalled();
  });
});
