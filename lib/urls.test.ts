import { describe, expect, it } from 'vitest';
import { safeNext } from './urls';

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
