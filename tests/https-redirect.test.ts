import { describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: {} }) } }) }));

async function run(url: string, headers: Record<string, string>) {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://muop.win';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://api.muop.win';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  vi.resetModules();
  const { middleware } = await import('../middleware');
  const { NextRequest } = await import('next/server');
  return middleware(new NextRequest(url, { headers }));
}

describe('http -> https redirect', () => {
  it('sends plain-http visitors of the site to https, keeping path and query', async () => {
    const res = await run('http://localhost:3000/login?next=/organizer', { host: 'muop.win', 'x-forwarded-proto': 'http' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://muop.win/login?next=/organizer');
  });

  it('leaves https traffic and other hosts alone (no open redirect)', async () => {
    expect((await run('http://localhost:3000/', { host: 'muop.win', 'x-forwarded-proto': 'https' })).status).toBe(200);
    expect((await run('http://localhost:3000/', { host: 'evil.example', 'x-forwarded-proto': 'http' })).status).toBe(200);
    expect((await run('http://localhost:3000/', { host: 'localhost:3000' })).status).toBe(200);
  });
});
