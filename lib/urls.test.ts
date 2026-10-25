import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomUrl, safeNext } from './urls';

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
