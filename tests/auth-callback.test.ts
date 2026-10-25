import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exchangeCodeForSession } = vi.hoisted(() => ({ exchangeCodeForSession: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  userClient: async () => ({ auth: { exchangeCodeForSession } }),
}));

import { GET } from '../app/auth/callback/route';

const origin = 'https://example.test';
beforeEach(() => {
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
});

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
