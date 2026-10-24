import { describe, expect, it } from 'vitest';
import { shortlist, type Venue } from './shortlist';
import { AREAS } from './geo';

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

describe('meet in the middle', () => {
  const venues: Venue[] = [
    v({ name: 'Whitefield Diner', area: 'Whitefield' }),
    v({ name: 'Domlur Diner', area: 'Domlur' }),
    v({ name: 'Jayanagar Diner', area: 'Jayanagar' }),
  ];
  const people = [AREAS.whitefield, AREAS.jayanagar];

  it('ranks the place in the middle first and reports travel', () => {
    const list = shortlist({ activity: 'dinner' }, [{}, {}], venues, 5, { people });
    expect(list[0].venue.name).toBe('Domlur Diner');
    expect(list[0].travel!.max_km).toBeLessThan(list[1].travel!.max_km);
    expect(list[0].reasons.some((r) => r.startsWith('Max '))).toBe(true);
  });

  it('suggests by distance alone when there is no other signal', () => {
    const list = shortlist({}, [{}, {}], venues, 5, { people });
    expect(list.length).toBe(3);
    expect(list[0].venue.name).toBe('Domlur Diner');
  });

  it('ignores distance with fewer than two people', () => {
    const list = shortlist({ activity: 'dinner' }, [{}], venues, 5, { people: [AREAS.whitefield] });
    expect(list.every((i) => !i.travel)).toBe(true);
  });
});
