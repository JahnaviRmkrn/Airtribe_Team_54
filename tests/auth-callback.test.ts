import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { exchangeCodeForSession } = vi.hoisted(() => ({ exchangeCodeForSession: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  userClient: async () => ({ auth: { exchangeCodeForSession } }),
}));

import { GET } from '../app/auth/callback/route';

const origin = 'https://example.test';
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe('auth callback return destinations', () => {
  it.each([
    ['/organizer/#/contacts', '/organizer/#/contacts'],
    [origin + '/organizer/?from=login', '/organizer/?from=login'],
    ['/reset-password', '/reset-password'],
    ['https://evil.test', '/'],
    [origin + '//evil.test/path', '/'],
    ['/.//evil.test/path', '/'],
    ['/safe/..//evil.test/path', '/'],
  ])('keeps the successful callback for %s on the app origin', async (next, expected) => {
    const request = new Request(origin + '/auth/callback?code=synthetic-code&next=' + encodeURIComponent(next));
    const result = await GET(request);
    expect(result.headers.get('location')).toBe(origin + expected);
    expect(new URL(result.headers.get('location')!).origin).toBe(origin);
    expect(exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith('synthetic-code');
  });

  it('does not exchange a missing code or follow its requested destination', async () => {
    const result = await GET(new Request(origin + '/auth/callback?next=/reset-password'));
    expect(result.headers.get('location')).toBe(origin + '/login?error=auth');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('does not follow the requested destination when the code is expired', async () => {
    exchangeCodeForSession.mockResolvedValueOnce({ error: new Error('Expired code') });
    const result = await GET(new Request(origin + '/auth/callback?code=expired&next=/reset-password'));
    expect(result.headers.get('location')).toBe(origin + '/login?error=auth');
  });
});

describe('auth callback origin trust boundary', () => {
  const forwarded = { host: 'localhost:3000', 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' };

  it.each(['success', 'missing', 'expired'])('keeps a %s callback on the configured origin despite forged forwarding', async (mode) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin + '/');
    if (mode === 'expired') exchangeCodeForSession.mockResolvedValueOnce({ error: new Error('Expired code') });
    const query = mode === 'missing' ? '' : '?code=synthetic-code&next=/reset-password';
    const result = await GET(new Request('http://localhost:3000/auth/callback' + query, { headers: forwarded }));
    expect(result.headers.get('location')).toBe(origin + (mode === 'success' ? '/reset-password' : '/login?error=auth'));
  });

  it('continues to reject off-origin next values against the canonical origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
    const result = await GET(new Request('http://localhost:3000/auth/callback?code=synthetic-code&next=' +
      encodeURIComponent('https://evil.test/reset-password'), { headers: forwarded }));
    expect(result.headers.get('location')).toBe(origin + '/');
  });

  it('preserves the canonical loopback auth fixture without following its internal origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://127.0.0.1:4320');
    const result = await GET(new Request('http://127.0.0.1:4321/auth/callback?code=synthetic-code&next=/reset-password', {
      headers: { host: '127.0.0.1:4320', 'x-forwarded-host': '127.0.0.1:4320', 'x-forwarded-proto': 'http' },
    }));
    expect(result.headers.get('location')).toBe('http://127.0.0.1:4320/reset-password');
  });

  it('retains trusted-proxy origins when a canonical URL is not configured', async () => {
    const result = await GET(new Request('http://localhost:3000/auth/callback?code=synthetic-code&next=/organizer', {
      headers: { host: 'localhost:3000', 'x-forwarded-host': 'preview.example', 'x-forwarded-proto': 'https, http' },
    }));
    expect(result.headers.get('location')).toBe('https://preview.example/organizer');
  });

  it.each([
    { 'x-forwarded-host': 'evil.test/path', 'x-forwarded-proto': 'https' },
    { 'x-forwarded-host': 'user@evil.test', 'x-forwarded-proto': 'https' },
    { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'ftp' },
  ])('rejects malformed origin headers before exchanging the code: %j', async (headers) => {
    await expect(GET(new Request(origin + '/auth/callback?code=synthetic-code', { headers }))).rejects.toThrow('Invalid public origin');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('does not issue a callback redirect or exchange when the canonical URL is invalid', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'javascript:invalid');
    await expect(GET(new Request(origin + '/auth/callback?code=synthetic-code', { headers: forwarded }))).rejects.toThrow('Invalid public origin');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
