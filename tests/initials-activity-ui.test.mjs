import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Pull single helpers out of the shipped browser scripts and run them in isolation.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const pick = (source, pattern) => {
  const match = source.match(pattern);
  if (!match) throw new Error('helper not found: ' + pattern);
  return match[0];
};
const initialsFrom = (path) => vm.runInNewContext(pick(read(path), /const initials = \(name\) => .*;/).replace(/^const initials = /, '').replace(/;$/, ''));
const organizer = read('../public/organizer/app.js');
const suggestedActivity = vm.runInNewContext(
  pick(organizer, /const ACTIVITIES = .*;/) + '\n' + pick(organizer, /function suggestedActivity\([\s\S]*?\n\}/) + '\nsuggestedActivity',
);

describe('avatar initials', () => {
  for (const path of ['../public/organizer/app.js', '../public/room/room.js', '../public/room/meet.js']) {
    const initials = initialsFrom(path);
    it(`skips brackets and punctuation (${path.split('/').pop()})`, () => {
      expect(initials('Arvind (A)')).toBe('AA');
      expect(initials('Priya Raman')).toBe('PR');
      expect(initials('  "Sam"  ')).toBe('S');
      expect(initials('Dr. Kiran Rao')).toBe('DK');
      expect(initials('अरविंद राज')).toBe('अर');
      expect(initials('(?)')).toBe('?');
      expect(initials('')).toBe('?');
      expect(initials(null)).toBe('?');
    });
  }
});

describe('new meetup activity default', () => {
  it('uses a kind named in the title', () => {
    expect(suggestedActivity("A's brunch", '')).toBe('brunch');
    expect(suggestedActivity('Friday DRINKS', '2026-10-30T11:00')).toBe('drinks');
    expect(suggestedActivity('Coffee catch-up', '2026-10-30T20:00')).toBe('coffee');
  });
  it('does not match a kind inside another word', () => {
    expect(suggestedActivity('Dinnerware shopping', '')).toBe('dinner');
    expect(suggestedActivity('Coffeehouse tour', '2026-10-30T20:00')).toBe('dinner');
  });
  it('falls back to the time of day', () => {
    expect(suggestedActivity('Catch-up with Priya', '2026-10-27T11:00')).toBe('brunch');
    expect(suggestedActivity('Catch-up with Priya', '2026-10-27T15:30')).toBe('coffee');
    expect(suggestedActivity('Catch-up with Priya', '2026-10-27T19:00')).toBe('dinner');
    expect(suggestedActivity('Catch-up with Priya', '2026-10-27T02:00')).toBe('dinner');
  });
  it('defaults to dinner with no title hint or time', () => {
    expect(suggestedActivity('', '')).toBe('dinner');
  });
});
