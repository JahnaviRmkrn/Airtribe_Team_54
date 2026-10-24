import { describe, expect, it } from 'vitest';
import { boundedInteger } from './query';

describe('integer query bounds', () => {
  it.each(['-Infinity', 'Infinity', 'NaN', 'abc', '-1', '1.5', '9007199254740992'])('rejects invalid query %s', (value) => {
    expect(boundedInteger(value, 14, 365, 0)).toBeNull();
  });
  it('uses defaults only for missing or empty input', () => {
    expect(boundedInteger(null, 14, 365, 0)).toBe(14);
    expect(boundedInteger('', 14, 365, 0)).toBe(14);
    expect(boundedInteger('0', 14, 365, 0)).toBe(0);
  });
  it('requires positive list limits and clamps large valid values', () => {
    expect(boundedInteger('0', 20, 100)).toBeNull();
    expect(boundedInteger('5', 20, 100)).toBe(5);
    expect(boundedInteger('1000', 20, 100)).toBe(100);
  });
});
