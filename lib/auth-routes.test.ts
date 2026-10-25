import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
const exchange = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  userClient: async () => ({ auth: { signOut, exchangeCodeForSession: exchange } }),
}));

const { POST } = await import('../app/auth/signout/route');
const { GET } = await import('../app/auth/callback/route');

beforeEach(() => {
  signOut.mockReset().mockResolvedValue({});
  exchange.mockReset().mockResolvedValue({ error: null });
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://muop.win');
});
afterEach(() => vi.unstubAllEnvs());

const post = (headers: Record<string, string>) =>
  new Request('http://localhost:3000/auth/signout', { method: 'POST', headers: { host: 'muop.win', ...headers } });

describe('POST /auth/signout (CSRF)', () => {
  it('signs out a same-origin form post', async () => {
    const res = await POST(post({ origin: 'https://muop.win' }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://muop.win/login');
    expect(signOut).toHaveBeenCalled();
  });

  it('refuses a cross-site post and does not sign out', async () => {
    const res = await POST(post({ origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('refuses the opaque "null" origin sent from sandboxed frames', async () => {
    expect((await POST(post({ origin: 'null' }))).status).toBe(403);
  });
});

describe('GET /auth/callback redirects', () => {
  const get = (qs: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost:3000/auth/callback?' + qs, { headers: { host: 'muop.win', ...headers } });

  it('sends a successful sign-in to a same-origin next path', async () => {
    const res = await GET(get('code=abc&next=/organizer/'));
    expect(res.headers.get('location')).toBe('https://muop.win/organizer/');
  });

  it.each(['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])('ignores next=%s', async (next) => {
    const res = await GET(get('code=abc&next=' + encodeURIComponent(next)));
    expect(new URL(res.headers.get('location')!).origin).toBe('https://muop.win');
  });

  it('cannot be steered to another domain with X-Forwarded-Host', async () => {
    const res = await GET(get('code=abc&next=/x', { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }));
    expect(res.headers.get('location')).toBe('https://muop.win/x');
    const bad = await GET(get('next=/x', { 'x-forwarded-host': 'evil.example' }));
    expect(bad.headers.get('location')).toBe('https://muop.win/login?error=auth');
  });
});
