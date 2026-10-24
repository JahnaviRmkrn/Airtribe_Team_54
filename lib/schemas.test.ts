import { describe, expect, it } from 'vitest';
import { guestJoin, guestPreferences, guestUpdate } from './schemas';

describe('guest budget validation', () => {
  it('rejects inverted budget ranges on join and update', () => {
    const preferences = { budget_min: 1000, budget_max: 500 };
    expect(guestPreferences.safeParse(preferences).success).toBe(false);
    expect(guestJoin.safeParse({ guest_name: 'Asha', preferences }).success).toBe(false);
    expect(guestUpdate.safeParse({ preferences }).success).toBe(false);
  });

  it.each([{}, { budget_min: 0 }, { budget_max: 500 }, { budget_min: 500, budget_max: 500 }])('accepts valid optional bounds: %j', (preferences) => {
    expect(guestPreferences.safeParse(preferences).success).toBe(true);
  });
});
