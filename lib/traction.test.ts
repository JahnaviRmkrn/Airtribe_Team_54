import { describe, expect, it } from 'vitest';
import { buildLedger, type LedgerAttendee } from './traction';

const meetups = [
  { id: 'real', organizer_email: 'demo@muop.win' },
  { id: 'smoke', organizer_email: 'smoke-123@example.com' },
  { id: 'nobody', organizer_email: null },
];
const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 6, min)).toISOString();
// Avoid accidental collisions in the existing seeded-guest heuristic unless
// a test specifically exercises it; real timestamps can also coincide.
let tick = 0;
const guest = (id: string, o: Partial<LedgerAttendee> = {}): LedgerAttendee => {
  const t = new Date(Date.UTC(2026, 9, 24, 6, 1, ++tick)).toISOString();
  return { id, meetup_id: 'real', guest_name: 'Priya', preferences: {}, availability: [], joined_at: t, updated_at: t, ...o };
};
const opts = { testDomains: ['example.com'], teamNames: ['Jahnavi', 'Arvind'] };

describe('buildLedger', () => {
  it('counts a completion only after join + share + vote', () => {
    const l = buildLedger(
      meetups,
      [
        guest('a', { preferences: { area: 'Indiranagar' }, updated_at: at(2) }),
        guest('b', { guest_name: 'Ravi', availability: ['sat-am'] }), // shared, no vote
        guest('c', { guest_name: 'Sam' }), // joined only
      ],
      [{ attendee_id: 'a', created_at: at(3) }],
      opts,
    );
    expect(l).toMatchObject({ joined: 3, shared: 2, completed: 1, rooms: 1 });
  });

  it('a vote without shared preferences is not a completion', () => {
    const l = buildLedger(meetups, [guest('a')], [{ attendee_id: 'a', created_at: at(2) }], opts);
    expect(l.completed).toBe(0);
  });

  it('separates known test traffic from unknown rooms and organizers', () => {
    const l = buildLedger(
      meetups,
      [
        guest('t', { meetup_id: 'smoke', preferences: { area: 'x' } }),
        guest('u', { meetup_id: 'gone', preferences: { area: 'x' } }),
        guest('n', { meetup_id: 'nobody', preferences: { area: 'x' } }),
        guest('j', { guest_name: 'jahnavi R', preferences: { area: 'x' } }),
      ],
      [{ attendee_id: 't', created_at: at(2) }, { attendee_id: 'j', created_at: at(2) }],
      opts,
    );
    expect(l).toMatchObject({ joined: 0, completed: 0, excluded: { test: 1, team: 1, seeded: 0, unverified: 2 } });
  });

  it('keeps explicit exclusions as test traffic even when the organizer is unknown', () => {
    const l = buildLedger(meetups, [guest('x', { meetup_id: 'gone' })], [], { ...opts, excludeIds: ['x'] });
    expect(l.excluded).toEqual({ test: 1, team: 0, seeded: 0, unverified: 0 });
  });

  it('preserves configured test-domain exclusions, ignoring case and whitespace', () => {
    const l = buildLedger([{ id: 'real', organizer_email: ' Tester@MuopDemo.dev ' }], [guest('x')], [], {
      ...opts, testDomains: [' MUOPDEMO.DEV '],
    });
    expect(l.excluded).toEqual({ test: 1, team: 0, seeded: 0, unverified: 0 });
  });

  it('counts duplicate attendee IDs once without inventing a seeded collision', () => {
    const a = guest('a', { preferences: { food: ['veg'] } });
    const l = buildLedger(meetups, [a, { ...a }], [{ attendee_id: 'a', created_at: at(3) }], opts);
    expect(l).toMatchObject({ joined: 1, shared: 1, completed: 1, excluded: { seeded: 0 } });
    expect(l.timeline.map((e) => e.step)).toEqual(['voted', 'joined']);
  });

  it('does not change totals or timeline when a guest is renamed or updated_at changes', () => {
    const a = guest('a', { preferences: { food: ['veg'] }, updated_at: at(2) });
    const votes = [{ attendee_id: 'a', created_at: at(3) }];
    const original = buildLedger(meetups, [a], votes, opts);
    const renamed = buildLedger(meetups, [{ ...a, guest_name: 'Ravi', updated_at: at(10) }], votes, opts);
    expect(renamed).toEqual(original);
    expect(original.timeline.map((e) => e.at)).toEqual([at(3), a.joined_at]);
  });

  it('excludes bulk-inserted (seeded) guests and listed internal test ids', () => {
    const l = buildLedger(
      meetups,
      [
        guest('s1', { guest_name: 'Rohit', joined_at: at(4) }),
        guest('s2', { guest_name: 'Navya', joined_at: at(4) }),
        guest('x', { guest_name: 'Tester', joined_at: at(5) }),
        guest('r', { guest_name: 'Andy', joined_at: at(6) }),
      ],
      [],
      { ...opts, excludeIds: ['x'] },
    );
    expect(l).toMatchObject({ joined: 1, excluded: { seeded: 2, test: 1 } });
  });

  it('ignores visits before `since`', () => {
    const l = buildLedger(meetups, [guest('a', { joined_at: at(0) }), guest('b', { joined_at: at(10) })], [], { ...opts, since: at(5) });
    expect(l.joined).toBe(1);
  });

  it('timeline is newest first and carries no names', () => {
    const l = buildLedger(
      meetups,
      [guest('a', { preferences: { food: ['veg'] }, updated_at: at(2) })],
      [{ attendee_id: 'a', created_at: at(3) }],
      opts,
    );
    expect(l.timeline.map((e) => e.step)).toEqual(['voted', 'joined']);
    expect(JSON.stringify(l.timeline)).not.toContain('Priya');
  });
});
