import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicOrigin, roomUrl, safeNext } from './urls';

const origin = 'https://app.example';

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/dashboard?x=1#top', origin)).toBe('/dashboard?x=1#top');
  });

  it.each([
    'javascript:alert(document.domain)',
    '//evil.example/path',
    '/\\evil.example',
    'https://evil.example/',
    'data:text/html,hi',
  ])('rejects %s', (next) => {
    expect(safeNext(next, origin)).toBe('/');
  });

  it('defaults to / when missing', () => {
    expect(safeNext(null, origin)).toBe('/');
  });
});

describe('roomUrl', () => {
  const req = new Request('https://preview.example/api/me/meetups');
  afterEach(() => vi.unstubAllEnvs());

  it('uses NEXT_PUBLIC_SITE_URL without a double slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example/');
    expect(roomUrl(req, 'tok')).toBe('https://app.example/m/tok');
  });

  it('falls back to the request origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(roomUrl(req, 'tok')).toBe('https://preview.example/m/tok');
  });
});

describe('publicOrigin', () => {
  const at = (headers: Record<string, string>) => new Request('http://localhost:3000/auth/callback', { headers });
  afterEach(() => vi.unstubAllEnvs());

  it('uses the Host header behind a tunnel', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://muop.win');
    expect(publicOrigin(at({ host: 'muop.win', 'x-forwarded-proto': 'https' }))).toBe('https://muop.win');
  });

  it('ignores a client-sent X-Forwarded-Host (open redirect through the tunnel)', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://muop.win');
    expect(publicOrigin(at({ host: 'muop.win', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }))).toBe('https://muop.win');
  });

  it('falls back to the configured site for a Host that is not allowed', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://muop.win');
    expect(publicOrigin(at({ host: 'evil.example' }))).toBe('https://muop.win');
    expect(publicOrigin(at({ host: 'muop.win.evil.example' }))).toBe('https://muop.win');
    expect(publicOrigin(at({ host: 'muop.win@evil.example' }))).toBe('https://muop.win');
    expect(publicOrigin(at({ host: 'evil.example/x' }))).toBe('https://muop.win');
  });

  it('allows localhost, tunnel backups and ALLOWED_HOSTS', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://muop.win');
    vi.stubEnv('ALLOWED_HOSTS', 'staging.muop.win');
    expect(publicOrigin(at({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
    expect(publicOrigin(at({ host: 'abc-def.trycloudflare.com' }))).toBe('https://abc-def.trycloudflare.com');
    expect(publicOrigin(at({ host: 'staging.muop.win' }))).toBe('https://staging.muop.win');
  });

  it('only honours http/https forwarded protocols', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://muop.win');
    expect(publicOrigin(at({ host: 'muop.win', 'x-forwarded-proto': 'javascript' }))).toBe('https://muop.win');
  });

  it('without a configured site, falls back to the request URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(publicOrigin(new Request('https://preview.example/x', { headers: { host: 'evil.example' } }))).toBe('https://preview.example');
  });
});
