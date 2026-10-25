import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the shipped room renderers without booting polling, using a browser,
// or issuing network requests. The page's initial request is omitted only here.
const source = readFileSync(new URL('../public/room/room.js', import.meta.url), 'utf8')
  .replace(/\nif \(!TOKEN\) \{[\s\S]*$/, '');

function room(initialView) {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) {
        const classes = new Set();
        nodes.set(id, {
          innerHTML: '', textContent: '', querySelectorAll: () => [],
          classList: {
            contains: (name) => classes.has(name),
            toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
          },
        });
      }
      return nodes.get(id);
    },
  };
  const context = vm.createContext({
    document, location: { pathname: '/m/test-room-token-123456' }, window: {},
    fetch: () => { throw new Error('Unexpected room network request'); },
  });
  vm.runInContext(source, context);
  const setView = (next) => {
    context.nextView = next;
    vm.runInContext('view = nextView', context);
  };
  setView(initialView);
  return {
    document, setView,
    run: (script) => vm.runInContext(script, context),
    html: (id) => document.getElementById(id).innerHTML,
  };
}

const venueA = { id: 'venue-a', name: 'Cafe A', area: 'Central', price_per_person: 500 };
const venueB = { id: 'venue-b', name: 'Cafe B', area: 'Central', price_per_person: 800 };
const roomView = ({ status = 'open', finalVenue = null, organizer = true, me = { attendee_id: 'guest-a', voted_venue_id: venueA.id } } = {}) => ({
  meetup: { status, final_venue: finalVenue },
  is_organizer: organizer,
  me,
  attendees: [],
  shortlist: [venueA, venueB].map((venue) => ({ venue })),
  votes: { [venueA.id]: 1, [venueB.id]: 2 },
  leading_venue_id: venueB.id,
});

describe('room availability tally', () => {
  it('counts mixed-case and padded copies once per guest, keeping the first readable label', () => {
    const app = room({ attendees: [{ availability: ['  Sat lunch  ', 'sat lunch', ' SAT LUNCH ', '', '  '] }] });
    expect(app.run('tallySlots()')).toEqual([{ slot: 'Sat lunch', count: 1 }]);
    app.run('renderSlots()');
    expect(app.html('slots')).toContain('<span class="slot-name">Sat lunch</span>');
    expect(app.html('slots')).toContain('<span class="slot-n">1</span>');
  });

  it('counts different guests independently and orders slots by attendance then label', () => {
    const app = room({ attendees: [
      { availability: ['Sat lunch', 'sat lunch', 'Sun brunch', 'Fri evening'] },
      { availability: [' SAT LUNCH ', 'sun brunch', ' SUN BRUNCH '] },
      { availability: ['sat lunch', 'Fri evening'] },
    ] });
    expect(app.run('tallySlots()')).toEqual([
      { slot: 'Sat lunch', count: 3 },
      { slot: 'Fri evening', count: 2 },
      { slot: 'Sun brunch', count: 2 },
    ]);
  });

  it('ignores missing and blank availability and preserves the empty state', () => {
    const app = room({ attendees: [{}, { availability: [] }, { availability: [' ', ''] }] });
    expect(app.run('tallySlots()')).toEqual([]);
    app.run('renderSlots()');
    expect(app.html('slots')).toContain('Once people share availability');
  });
});

describe('room confirmation and voting controls', () => {
  it.each([
    ['open organizer, unconfirmed', 'open', true, null, true, true],
    ['open guest, unconfirmed', 'open', false, null, false, true],
    ['closed organizer, unconfirmed', 'closed', true, null, false, false],
    ['closed guest, unconfirmed', 'closed', false, null, false, false],
    ['open organizer, confirmed', 'open', true, venueA, false, false],
    ['open organizer, confirmed leader', 'open', true, venueB, false, false],
    ['open guest, confirmed', 'open', false, venueA, false, false],
    ['closed organizer, confirmed', 'closed', true, venueA, false, false],
    ['closed guest, confirmed', 'closed', false, venueA, false, false],
  ])('renders only permitted controls for %s', (_label, status, organizer, finalVenue, canConfirm, canVote) => {
    const app = room(roomView({ status, organizer, finalVenue }));
    app.run('renderOrganizer(); renderShortlist()');
    expect(app.html('org-panel').includes('data-confirm=')).toBe(canConfirm);
    expect(app.html('shortlist').includes('data-confirm=')).toBe(canConfirm);
    expect(app.html('shortlist').includes('data-vote=')).toBe(canVote);
    expect(app.html('shortlist').includes('data-unvote=')).toBe(canVote);
    expect(app.html('org-panel').includes('id="org-close"')).toBe(organizer && status === 'open');
    expect(app.document.getElementById('org-panel').classList.contains('hidden')).toBe(!organizer);
    if (canConfirm) {
      expect(app.html('org-panel')).toContain('data-confirm="venue-b"');
      expect(app.html('shortlist').match(/data-confirm=/g)).toHaveLength(2);
    }
    if (finalVenue) {
      expect(app.html('shortlist')).toContain('Confirmed</span>');
      expect(app.html('shortlist')).not.toContain('Leading</span>');
    }
  });

  it('removes both confirmation paths and vote controls after a confirmed refresh', () => {
    const app = room(roomView());
    app.run('renderOrganizer(); renderShortlist()');
    expect(app.html('org-panel')).toContain('data-confirm="venue-b"');
    expect(app.html('shortlist')).toContain('data-confirm="venue-a"');
    app.setView(roomView({ finalVenue: venueA }));
    app.run('renderOrganizer(); renderShortlist()');
    expect(app.html('org-panel')).not.toContain('data-confirm=');
    expect(app.html('shortlist')).not.toMatch(/data-(?:confirm|vote|unvote)=/);
    expect(app.html('shortlist')).toContain('Confirmed</span>');
    expect(app.html('org-panel')).toContain('id="org-close"');
  });

  it('does not offer another venue when the final venue is absent from the shortlist', () => {
    const app = room(roomView({ finalVenue: { id: 'other-venue', name: 'Other cafe' } }));
    app.run('renderOrganizer(); renderShortlist()');
    expect(app.html('org-panel')).not.toContain('data-confirm=');
    expect(app.html('shortlist')).not.toMatch(/data-(?:confirm|vote|unvote)=/);
  });

  it('keeps voting available to an unvoted guest without showing organizer controls', () => {
    const app = room(roomView({ organizer: false, me: { attendee_id: 'guest-a', voted_venue_id: null } }));
    app.run('renderOrganizer(); renderShortlist()');
    expect(app.html('shortlist').match(/data-vote=/g)).toHaveLength(2);
    expect(app.html('shortlist')).not.toMatch(/data-(?:confirm|unvote)=/);
    expect(app.document.getElementById('org-panel').classList.contains('hidden')).toBe(true);
  });

  it('does not offer votes or confirmation to an unjoined visitor', () => {
    const app = room(roomView({ organizer: false, me: null }));
    app.run('renderOrganizer(); renderShortlist()');
    expect(app.html('org-panel')).not.toContain('data-confirm=');
    expect(app.html('shortlist')).not.toMatch(/data-(?:confirm|vote|unvote)=/);
  });
});
