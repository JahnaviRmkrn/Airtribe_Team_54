import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient }));

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-key');
  createServerClient.mockReset().mockImplementation(() => ({ auth: { getUser: async () => ({ data: { user: null } }) } }));
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

// Pine Labs checkout returns the guest with a form POST to callback_url.
describe('payment return middleware', () => {
  it('turns the provider POST into a same-path GET', async () => {
    const { middleware } = await import('../middleware');
    const result = await middleware(new NextRequest('https://app.example.test/m/tok_EN-9?payment=done', {
      method: 'POST', body: 'order_id=v1-x&status=AUTHORIZED', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }));
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('/m/tok_EN-9?payment=done');
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('drops any extra query the POST carried', async () => {
    const { middleware } = await import('../middleware');
    const result = await middleware(new NextRequest('https://app.example.test/m/tok?payment=done&next=//evil.test', { method: 'POST' }));
    expect(result.headers.get('location')).toBe('/m/tok?payment=done');
  });

  it.each([
    ['GET', '/m/tok?payment=done'], ['POST', '/m/tok'], ['POST', '/m/tok?payment=other'],
    ['POST', '/m/tok/extra?payment=done'], ['POST', '/m//evil.test?payment=done'], ['POST', '/organizer?payment=done'],
  ])('leaves %s %s alone', async (method, path) => {
    const { middleware } = await import('../middleware');
    const result = await middleware(new NextRequest('https://app.example.test' + path, { method }));
    expect(result.status).not.toBe(303);
    expect(createServerClient).toHaveBeenCalledOnce();
  });
});
