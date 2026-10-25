import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('server-only', () => ({}));
vi.mock('../supabase/admin', () => ({ adminClient: vi.fn(() => { throw new Error('No database access permitted in this unit test'); }) }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
import { authorization, CONTACTS_SCOPE, exchangeCode, googleConfig, googleJson, googleRoute, sameOrigin, seal, unseal, validState, type GoogleConfig } from './connector';
import { contactKey, loadContactsPage, normalizePeople, selectionsSchema, type ReadyContacts } from './contacts';

const config: GoogleConfig = { purpose: 'contacts', clientId: 'synthetic-client', clientSecret: 'synthetic-secret', origin: 'https://example.test', redirectUri: 'https://example.test/api/me/integrations/google/contacts/callback', key: Buffer.alloc(32, 42), scope: CONTACTS_SCOPE };
const ready = (): ReadyContacts => ({ phase: 'ready', token: 'synthetic-token', tokenExpiresAt: Date.now() + 60000, contacts: [], nextPageToken: null, seenPages: [], pages: 0, skipped: 0, truncated: false });
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled: provide a mock'); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('purpose-bound Google OAuth security', () => {
  it('fails closed without full server-only configuration', () => {
    for (const key of ['GOOGLE_CONTACTS_CLIENT_ID', 'GOOGLE_CONTACTS_CLIENT_SECRET', 'GOOGLE_CONNECTOR_ORIGIN', 'GOOGLE_CONNECTOR_ENCRYPTION_KEY']) vi.stubEnv(key, '');
    expect(googleConfig('contacts')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['https://example.test/path', 'https://user:pass@example.test', 'http://example.test', 'https://example.test/?x=1', 'https://example.test/#x'])('rejects unsafe configured origin %s', (origin) => {
    vi.stubEnv('GOOGLE_CONTACTS_CLIENT_ID', 'synthetic-client'); vi.stubEnv('GOOGLE_CONTACTS_CLIENT_SECRET', 'synthetic-secret'); vi.stubEnv('GOOGLE_CONNECTOR_ENCRYPTION_KEY', config.key.toString('base64')); vi.stubEnv('GOOGLE_CONNECTOR_ORIGIN', origin);
    expect(googleConfig('contacts')).toBeNull();
  });
  it('uses a fixed redirect, contacts.readonly, online-only authorization and S256 PKCE', () => {
    const result = authorization(config);
    const url = new URL(result.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(CONTACTS_SCOPE);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(result.verifier).digest('base64url'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(result.url).not.toContain(config.clientSecret);
    expect(authorization(config).state).not.toBe(result.state);
  });
  it('validates state without accepting missing, Unicode, truncated or mismatched state', () => {
    const { state } = authorization(config);
    expect(validState(state, state)).toBe(true);
    for (const wrong of [null, '', state.slice(1), 'é'.repeat(43), 'a'.repeat(43)]) expect(validState(wrong, state)).toBe(false);
  });
  it('rejects spoofed Host/forwarding or absent Origin on mutations', () => {
    expect(() => sameOrigin(new Request('https://internal.test', { headers: { origin: config.origin } }), config)).not.toThrow();
    expect(() => sameOrigin(new Request(config.origin, { headers: { host: 'example.test', 'x-forwarded-host': 'example.test', origin: 'https://evil.test' } }), config)).toThrow();
    expect(() => sameOrigin(new Request(config.origin), config)).toThrow();
  });
  it('authenticated encryption binds session, owner and purpose and uses fresh nonces', () => {
    const payload = { token: 'synthetic-access-token', preview: ['private'] };
    const cipher = seal(payload, config, 'id-one', 'owner-one');
    expect(cipher).not.toContain('synthetic-access-token');
    expect(unseal(cipher, config, 'id-one', 'owner-one')).toEqual(payload);
    expect(seal(payload, config, 'id-one', 'owner-one')).not.toBe(cipher);
    expect(() => unseal(cipher, config, 'id-two', 'owner-one')).toThrow();
    expect(() => unseal(cipher, config, 'id-one', 'owner-two')).toThrow();
    expect(() => unseal(cipher, { ...config, purpose: 'sheets-import' }, 'id-one', 'owner-one')).toThrow();
    const bytes = Buffer.from(cipher, 'base64'); bytes[30] ^= 1;
    expect(() => unseal(bytes.toString('base64'), config, 'id-one', 'owner-one')).toThrow();
  });
  it('exchanges code only via a server-side POST and drops refresh tokens', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ access_token: 'synthetic-token', refresh_token: 'must-be-discarded', scope: CONTACTS_SCOPE, token_type: 'Bearer', expires_in: 3600 })));
    const result = await exchangeCode(config, 'synthetic-code', 'synthetic-verifier');
    expect(result).toEqual({ token: 'synthetic-token', tokenExpiresAt: expect.any(Number) });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options).toMatchObject({ method: 'POST', cache: 'no-store', redirect: 'error' });
    const body = options?.body as URLSearchParams;
    expect(body.get('code_verifier')).toBe('synthetic-verifier');
    expect(body.get('client_secret')).toBe('synthetic-secret');
    expect(JSON.stringify(result)).not.toContain('refresh');
  });
  it('rejects missing scope, wrong token type and invalid expiry', async () => {
    for (const change of [{ scope: 'openid' }, { token_type: 'mac' }, { expires_in: 0 }, { access_token: '' }]) {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-token', scope: CONTACTS_SCOPE, token_type: 'Bearer', expires_in: 60, ...change })));
      await expect(exchangeCode(config, 'code', 'verifier')).rejects.toThrow(/permission/);
    }
  });
  it.each([401, 403, 429, 500])('sanitizes Google HTTP %s and never logs provider bodies', async (status) => {
    const log = vi.spyOn(console, 'error');
    vi.mocked(fetch).mockResolvedValue(new Response('SECRET provider diagnostic', { status }));
    await expect(googleJson('https://people.googleapis.com/v1/people/me/connections', {})).rejects.not.toThrow('SECRET');
    expect(log).not.toHaveBeenCalled();
  });
  it('sanitizes timeouts and uncaught route errors with no-store responses', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('SECRET request token'));
    await expect(googleJson('https://people.googleapis.com', {})).rejects.toThrow('did not respond in time');
    const response = await googleRoute(async () => { throw new Error('SECRET'); })(new Request(config.origin));
    expect(await response.text()).not.toContain('SECRET');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

describe('minimal Google Contacts preview', () => {
  it('selects primary name/email, strips other fields and skips unusable people', () => {
    const page = normalizePeople({ connections: [
      { names: [{ displayName: 'Secondary' }, { displayName: ' Primary ', metadata: { primary: true } }], emailAddresses: [{ value: 'other@example.test' }, { value: ' primary@example.test ', metadata: { primary: true } }], photos: ['PRIVATE'], birthdays: ['PRIVATE'] },
      { names: [{ displayName: 'No Email' }], emailAddresses: [{ value: 'invalid' }] },
      { emailAddresses: [{ value: 'emailonly@example.test' }] }, {},
    ] });
    expect(page.contacts).toEqual([
      { id: expect.any(String), name: 'Primary', email: 'primary@example.test' },
      { id: expect.any(String), name: 'No Email', email: null },
      { id: expect.any(String), name: 'emailonly@example.test', email: 'emailonly@example.test' },
    ]);
    expect(page.skipped).toBe(1);
    expect(JSON.stringify(page)).not.toContain('PRIVATE');
    expect(contactKey({ name: ' A ', email: ' X@EXAMPLE.TEST ' })).toBe('email:x@example.test');
  });
  it('pages with constant params, deduplicates across pages, and clears token at the end', async () => {
    const payload = ready();
    const person = { names: [{ displayName: 'Person' }], emailAddresses: [{ value: 'person@example.test' }] };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ connections: [person], nextPageToken: 'page2' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ connections: [person, { names: [{ displayName: 'Second' }] }] })));
    await loadContactsPage(payload); await loadContactsPage(payload);
    expect(payload.contacts).toHaveLength(2);
    expect(payload.skipped).toBe(1);
    expect(payload.token).toBeNull();
    expect(payload.nextPageToken).toBeNull();
    const first = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    const second = new URL(String(vi.mocked(fetch).mock.calls[1][0]));
    expect(second.searchParams.get('pageToken')).toBe('page2');
    second.searchParams.delete('pageToken');
    expect(second.toString()).toBe(first.toString());
    expect(first.searchParams.get('personFields')).toBe('names,emailAddresses');
    expect(first.searchParams.get('sources')).toBe('READ_SOURCE_TYPE_CONTACT');
    expect(first.toString()).not.toContain('synthetic-token');
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer synthetic-token' });
  });
  it('preserves state on quota or timeout so retry can safely request the same page', async () => {
    const payload = ready();
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(loadContactsPage(payload)).rejects.toThrow('rate limiting');
    expect(payload.pages).toBe(0); expect(payload.contacts).toEqual([]);
  });
  it('rejects pagination loops and clears tokens at the bounded page limit', async () => {
    const payload = ready(); payload.pages = 1; payload.nextPageToken = 'loop';
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ nextPageToken: 'loop' })));
    await expect(loadContactsPage(payload)).rejects.toThrow('repeated');
    payload.pages = 9;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ nextPageToken: 'more' })));
    await loadContactsPage(payload);
    expect(payload.truncated).toBe(true); expect(payload.token).toBeNull(); expect(payload.nextPageToken).toBeNull();
  });
  it('rejects expired access before any Google call', async () => {
    const payload = ready(); payload.tokenExpiresAt = 0;
    await expect(loadContactsPage(payload)).rejects.toThrow('expired');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('limits explicit selections to five and accepts no caller-supplied contact fields', () => {
    const row = { id: '11111111-1111-4111-8111-111111111111', category: 'personal' };
    expect(selectionsSchema.safeParse({ selections: [row] }).success).toBe(true);
    expect(selectionsSchema.safeParse({ selections: [] }).success).toBe(false);
    expect(selectionsSchema.safeParse({ selections: Array(6).fill(row) }).success).toBe(false);
    expect(selectionsSchema.safeParse({ selections: [{ ...row, name: 'injected' }] }).success).toBe(false);
  });
});
