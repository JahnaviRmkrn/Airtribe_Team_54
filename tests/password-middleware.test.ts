import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient }));

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-key');
  createServerClient.mockReset().mockImplementation((_url, _key, options) => ({ auth: { getUser: async () => {
    options.cookies.setAll([{ name: 'synthetic-session', value: 'rotated-fixture', options: {} }]);
    return { data: { user: { id: 'fixture' } } };
  } } }));
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

describe('password endpoint middleware cookie boundary', () => {
  it('bypasses session refresh only for the exact password POST', async () => {
    const { middleware } = await import('../middleware');
    const result = await middleware(new NextRequest('https://app.example.test/api/me/password', { method: 'POST' }));
    expect(createServerClient).not.toHaveBeenCalled();
    expect(result.headers.has('set-cookie')).toBe(false);
    expect(result.status).toBe(200);
  });

  it.each([
    ['GET', '/api/me/password'], ['POST', '/api/me/password/extra'],
    ['POST', '/api/me/password/'], ['POST', '/api/me/contacts'], ['GET', '/reset-password'],
  ])('preserves normal refresh for %s %s', async (method, path) => {
    const { middleware } = await import('../middleware');
    const result = await middleware(new NextRequest('https://app.example.test' + path, { method }));
    expect(createServerClient).toHaveBeenCalledOnce();
    expect(result.headers.get('set-cookie')).toContain('synthetic-session=rotated-fixture');
  });

  it('still performs the existing HTTPS redirect before the narrow bypass', async () => {
    const { middleware } = await import('../middleware');
    const result = await middleware(new NextRequest('http://localhost:3000/api/me/password', {
      method: 'POST', headers: { Host: 'app.example.test', 'X-Forwarded-Proto': 'http' },
    }));
    expect(result.status).toBe(308);
    expect(result.headers.get('location')).toBe('https://app.example.test/api/me/password');
    expect(createServerClient).not.toHaveBeenCalled();
    expect(result.headers.has('set-cookie')).toBe(false);
  });
});
