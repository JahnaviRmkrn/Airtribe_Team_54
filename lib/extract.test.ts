import { describe, expect, it } from 'vitest';
import { clean, extractBody, extractResult, normalizeGoals, ruleExtract, ruleGoals, userLines } from './extract';

const sum = (g: Record<string, number>) => Object.values(g).reduce((a, b) => a + b, 0);

describe('ruleExtract (fallback)', () => {
  it('finds people by relation and maps them to categories', () => {
    const r = ruleExtract(
      'I want to call my sister Priya more, catch up with my friend Arjun, and my mentor Meera. Also my neighbour Ravi.',
    );
    expect(r.contacts.map((c) => [c.name, c.category])).toEqual([
      ['Priya', 'personal'],
      ['Arjun', 'personal'],
      ['Meera', 'professional'],
      ['Ravi', 'community'],
    ]);
  });

  it('handles "Name, my relation" and loose mentions, without duplicates', () => {
    const r = ruleExtract('Karan, my colleague, is great. I should meet Karan and see Divya Rao soon.');
    expect(r.contacts.map((c) => c.name)).toEqual(['Karan', 'Divya Rao']);
    expect(r.contacts[0].category).toBe('professional');
  });

  it('ignores the agent side of a labelled transcript', () => {
    const t = 'Agent: Would you like to stay in touch with my friend Bob?\nUser: Yes, with my brother Sam.';
    expect(userLines(t)).toBe('Yes, with my brother Sam.');
    expect(ruleExtract(t).contacts.map((c) => c.name)).toEqual(['Sam']);
  });

  it('caps contacts at 5', () => {
    const t = 'my friend Aa, my friend Bb, my friend Cc, my friend Dd, my friend Ee, my friend Ff, my friend Gg';
    expect(ruleExtract(t).contacts).toHaveLength(5);
  });

  it('reads explicit percentages, merging synonyms into one category', () => {
    expect(ruleGoals('family 40%, friends 30%, work 20%, community 10%')).toEqual({ personal: 70, professional: 20, community: 10 });
    expect(ruleExtract('60% personal, 30 percent work and 10% community').goals).toEqual({ personal: 60, professional: 30, community: 10 });
  });

  it('normalises explicit numbers that do not total 100', () => {
    const g = ruleExtract('family 50%, work 50%, community 50%').goals;
    expect(sum(g)).toBe(100);
    expect(g).toEqual({ personal: 34, professional: 33, community: 33 });
  });

  it('weights by emphasis when no numbers are given', () => {
    const g = ruleExtract('Mostly work, work and my career. A bit of family.').goals;
    expect(sum(g)).toBe(100);
    expect(g.professional).toBeGreaterThan(g.personal);
    expect(g.personal).toBeGreaterThan(g.community);
  });

  it('returns a valid empty result for text with nobody in it', () => {
    const r = ruleExtract('hello there');
    expect(r.contacts).toEqual([]);
    expect(extractResult.safeParse(r).success).toBe(true);
  });
});

describe('normalizeGoals', () => {
  it('always totals 100 with non-negative integers', () => {
    for (const g of [
      { personal: 1, professional: 1, community: 1 },
      { personal: 33.3, professional: 33.3, community: 33.3 },
      { personal: 250, professional: 0, community: 0 },
      { personal: -50, professional: 10, community: 'x' },
      {},
      null,
    ]) {
      const out = normalizeGoals(g as Record<string, unknown> | null);
      expect(sum(out)).toBe(100);
      expect(Object.values(out).every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    }
  });

  it('accepts the old PR #3 labels', () => {
    expect(normalizeGoals({ Family: 40, Friends: 30, Work: 20, Mentors: 10 })).toEqual({ personal: 70, professional: 30, community: 0 });
  });
});

describe('clean (LLM output validation)', () => {
  it('clamps to 5 contacts, dedupes, coerces fields and drops junk', () => {
    const r = clean({
      contacts: [
        { name: '  Priya ', category: 'Family', interests: 'chai, books', preferred_frequency_days: '7' },
        { name: 'priya', category: 'personal' },
        { name: '', category: 'work' },
        { name: 'Meera', category: 'nonsense', interests: ['x'.repeat(100)], preferred_frequency_days: 9999 },
        { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' },
      ],
      goals: { personal: '80', professional: 80, community: null },
    });
    expect(r.contacts).toHaveLength(5);
    expect(r.contacts[0]).toEqual({ name: 'Priya', category: 'personal', interests: ['chai', 'books'], preferred_frequency_days: 7 });
    expect(r.contacts[1]).toEqual({ name: 'Meera', category: 'personal', interests: ['x'.repeat(40)] });
    expect(r.goals).toEqual({ personal: 50, professional: 50, community: 0 });
    expect(extractResult.safeParse(r).success).toBe(true);
  });

  it('handles missing contacts and goals', () => {
    expect(clean({})).toEqual({ contacts: [], goals: { personal: 34, professional: 33, community: 33 } });
  });
});

describe('extractBody', () => {
  it('rejects empty and over-long transcripts', () => {
    expect(extractBody.safeParse({ transcript: '   ' }).success).toBe(false);
    expect(extractBody.safeParse({ transcript: 'x'.repeat(20_001) }).success).toBe(false);
    expect(extractBody.safeParse({ transcript: 'my friend Arjun' }).success).toBe(true);
  });
});
