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
    'https://app.example//evil.example/path',
    '/.//evil.example/path',
    '/safe/..//evil.example/path',
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
  afterEach(() => vi.unstubAllEnvs());
  const request = (headers: Record<string, string> = {}, url = 'http://localhost:3000/auth/callback') =>
    new Request(url, { headers });

  it('uses the canonical configured origin instead of caller-controlled headers', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://APP.example:443/');
    expect(publicOrigin(request({ host: 'other.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' })))
      .toBe('https://app.example');
  });

  it('does not inspect unused forwarded headers when the canonical origin is valid', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
    expect(publicOrigin(request({ 'x-forwarded-host': 'evil.example/path', 'x-forwarded-proto': 'javascript' })))
      .toBe(origin);
  });

  it.each([
    'javascript:alert(1)', 'ftp://app.example', '//app.example', 'https:app.example',
    'https://user:password@app.example', 'https://app.example/path', 'https://app.example?next=evil',
    'https://app.example#fragment', 'https://app.example\\evil', 'https://app.example,evil.example',
    'https://app.example:99999', 'https://app.example /', ' https://app.example',
  ])('rejects invalid canonical configuration %s instead of trusting headers', (configured) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', configured);
    expect(() => publicOrigin(request({ 'x-forwarded-host': 'evil.example' }))).toThrow('Invalid public origin');
  });

  it.each([
    [{ 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https', host: 'localhost:3000' }, 'https://public.example'],
    [{ 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https, http' }, 'https://public.example'],
    [{ host: 'public.example' }, 'https://public.example'],
    [{ host: 'localhost:3000' }, 'http://localhost:3000'],
    [{ host: '127.0.0.1:4320' }, 'http://127.0.0.1:4320'],
    [{ host: '[::1]:4320' }, 'http://[::1]:4320'],
    [{}, 'http://localhost:3000'],
  ])('preserves trusted-proxy/local fallback for %j', (headers, expected) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(publicOrigin(request(headers))).toBe(expected);
  });

  it.each([
    '', 'evil.example/path', 'evil.example?x=1', 'evil.example#fragment', 'user@evil.example',
    'evil.example\\path', 'evil.example,app.example', 'evil.example app.example', '%65vil.example',
    'evil.example:99999', '[::1',
  ])('rejects malformed forwarded host %s', (host) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(() => publicOrigin(request({ host: 'app.example', 'x-forwarded-host': host }))).toThrow('Invalid public origin');
  });

  it.each(['', 'javascript', 'ftp', 'https://evil.example', 'https, javascript', 'https,', 'https http'])
    ('rejects malformed forwarded protocol %s', (proto) => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
      expect(() => publicOrigin(request({ host: 'app.example', 'x-forwarded-proto': proto }))).toThrow('Invalid public origin');
    });

  it('validates the ordinary Host fallback too', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(() => publicOrigin(request({ host: 'user@evil.example' }))).toThrow('Invalid public origin');
  });

  it('rejects a non-http request origin when no host/configuration is available', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(() => publicOrigin(request({}, 'ftp://app.example/callback'))).toThrow('Invalid public origin');
  });
});
