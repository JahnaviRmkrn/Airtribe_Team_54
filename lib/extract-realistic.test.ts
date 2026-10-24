import { describe, expect, it } from 'vitest';
import cases from '../fixtures/onboarding/cases.json';
import { ruleExtract, ruleFrequency, userLines } from './extract';

describe('realistic onboarding fallback regressions', () => {
  for (const fixture of cases) it(fixture.id, () => {
    const result = ruleExtract(fixture.transcript);
    expect(result.contacts.map(c => [c.name, c.category, c.preferred_frequency_days ?? null])).toEqual(fixture.contacts);
    expect(result.goals).toEqual(fixture.goals);
  });
  it('keeps assistant continuation lines out of user content', () => {
    expect(userLines('Assistant: My friend Bob\nmy brother Tom\nUser: My sister Ria\nweekly')).toBe('My sister Ria\nweekly');
  });
  it('does not mistake a goal number for a cadence', () => {
    expect(ruleFrequency('Goals personal 50%, community 20%')).toBeUndefined();
    expect(ruleFrequency('every 400 days')).toBeUndefined();
  });
});
