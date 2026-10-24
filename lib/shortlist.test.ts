import { describe, expect, it } from 'vitest';
import { shortlist, type Venue } from './shortlist';

const v = (o: Partial<Venue> & { name: string }): Venue => ({
  id: o.name,
  area: 'Indiranagar',
  activity_types: ['dinner'],
  tags: [],
  price_per_person: 500,
  source_type: 'sample',
  ...o,
});

const venues = [
  v({ name: 'Cheap Veg', area: 'Koramangala', tags: ['veg', 'south-indian'], price_per_person: 300 }),
  v({ name: 'Pricey Grill', area: 'Indiranagar', tags: ['grill', 'non-veg'], price_per_person: 2000 }),
  v({ name: 'Cafe', area: 'Indiranagar', activity_types: ['coffee'], tags: ['veg'], price_per_person: 400 }),
];

describe('shortlist', () => {
  it('returns [] when there is nothing to match on', () => {
    expect(shortlist({}, [], venues)).toEqual([]);
  });

  it('filters by activity and labels results as samples', () => {
    const r = shortlist({ activity: 'coffee' }, [], venues);
    expect(r.map((x) => x.venue.name)).toEqual(['Cafe']);
    expect(r[0].label).toBe('Sample suggestion');
  });

  it('ranks by group preferences', () => {
    const r = shortlist(
      { activity: 'dinner' },
      [
        { area: 'Koramangala', food: ['veg'], budget_max: 800 },
        { area: 'Koramangala', food: ['south-indian'], budget_max: 600 },
      ],
      venues,
    );
    expect(r[0].venue.name).toBe('Cheap Veg');
    expect(r.find((x) => x.venue.name === 'Pricey Grill')).toBeUndefined();
  });

  it('respects the organiser budget', () => {
    const r = shortlist({ activity: 'dinner', area: 'Indiranagar', budget: 1000 }, [], venues);
    expect(r.map((x) => x.venue.name)).not.toContain('Pricey Grill');
  });

  it('returns [] when no venue matches the activity', () => {
    expect(shortlist({ activity: 'bowling' }, [], venues)).toEqual([]);
  });
});

describe('budget-only preferences', () => {
  it('uses an organizer budget as enough signal to suggest affordable venues', () => {
    const result = shortlist({ budget: 500 }, [], venues);
    expect(result.map((item) => item.venue.name).sort()).toEqual(['Cafe', 'Cheap Veg']);
  });

  it('uses a guest budget even without activity, food, or area', () => {
    const result = shortlist({}, [{ budget_max: 350 }], venues);
    expect(result.map((item) => item.venue.name)).toEqual(['Cheap Veg']);
  });

  it('does not infer affordability when a venue has no price', () => {
    expect(shortlist({ budget: 500 }, [], [v({ name: 'Unknown', price_per_person: null })])).toEqual([]);
  });
});
