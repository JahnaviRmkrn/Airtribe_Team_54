import { describe, expect, it } from 'vitest';
import { isOverdue } from './due';

// 24 Oct 2026, 10:00 IST
const now = new Date('2026-10-24T04:30:00Z');

describe('isOverdue', () => {
  it('a check-in due today is not overdue, even after its stored time has passed', () => {
    expect(isOverdue('2026-10-24T00:00:00Z', now)).toBe(false);
  });
  it('yesterday (IST) is overdue', () => {
    expect(isOverdue('2026-10-23T00:00:00Z', now)).toBe(true);
    // 23 Oct 23:00 IST
    expect(isOverdue('2026-10-23T17:30:00Z', now)).toBe(true);
  });
  it('uses the IST day, not the UTC day', () => {
    // 24 Oct 00:30 IST is still 23 Oct in UTC
    expect(isOverdue('2026-10-23T19:00:00Z', now)).toBe(false);
  });
  it('future, missing and invalid dates are not overdue', () => {
    expect(isOverdue('2026-10-26T00:00:00Z', now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
    expect(isOverdue('nope', now)).toBe(false);
  });
});
