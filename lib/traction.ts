// Traction ledger: who actually used muop, counted the way the event asks
// (real people outside the team completing the core action), not page views
// or sign-ups. Pure function: no I/O, easy to test.
//
// Core action = a guest joins a meetup room, shares preferences or
// availability, and votes on a place. Each step is counted separately so a
// half-finished visit is never reported as a completion.

export type LedgerAttendee = {
  id: string;
  meetup_id: string;
  guest_name: string;
  preferences: unknown;
  availability: unknown;
  joined_at: string;
  updated_at: string;
};
export type LedgerVote = { attendee_id: string; created_at: string };
export type LedgerMeetup = { id: string; organizer_email: string | null };

export type LedgerOptions = {
  // Organisers on these email domains are test accounts (smoke/UI tests use example.com).
  testDomains: string[];
  // Guest first names belonging to the team; their visits are shown but not counted.
  teamNames: string[];
  // Attendee ids known to be internal tests that can't be detected otherwise.
  excludeIds?: string[];
  since?: string;
};

export type LedgerStep = 'joined' | 'shared' | 'voted';
export type LedgerEvent = { at: string; room: number; guest: number; step: LedgerStep };

export type Ledger = {
  since: string | null;
  joined: number;
  shared: number;
  completed: number;
  rooms: number;
  excluded: { test: number; team: number; seeded: number };
  timeline: LedgerEvent[];
};

const norm = (s: string) => s.trim().toLowerCase();
const firstName = (s: string) => norm(s).split(/\s+/)[0] ?? '';

function hasContent(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some((x) => (Array.isArray(x) ? x.length > 0 : x != null && x !== ''));
  }
  return false;
}

export function buildLedger(
  meetups: LedgerMeetup[],
  attendees: LedgerAttendee[],
  votes: LedgerVote[],
  opts: LedgerOptions,
  timelineLimit = 40,
): Ledger {
  const testDomains = opts.testDomains.map(norm).filter(Boolean);
  const team = new Set(opts.teamNames.map(firstName).filter(Boolean));
  const since = opts.since ? Date.parse(opts.since) : NaN;
  const isTestRoom = new Map(
    meetups.map((m) => {
      const domain = norm(m.organizer_email ?? '').split('@')[1] ?? '';
      return [m.id, testDomains.includes(domain)];
    }),
  );
  const voteAt = new Map(votes.map((v) => [v.attendee_id, v.created_at]));

  // Rooms and guests get stable small numbers instead of names or tokens: the
  // page is public, so it must not reveal who joined or how to reach a room.
  const roomNo = new Map<string, number>();
  const counted: LedgerAttendee[] = [];
  const excluded = { test: 0, team: 0, seeded: 0 };
  const skip = new Set(opts.excludeIds ?? []);
  // Seed scripts insert a room's guests in one transaction, so they share the
  // exact same joined_at (to the microsecond). Real joins never collide.
  const sameInstant = new Map<string, number>();
  attendees.forEach((a) => sameInstant.set(a.joined_at, (sameInstant.get(a.joined_at) ?? 0) + 1));
  const ordered = attendees
    .filter((a) => isNaN(since) || Date.parse(a.joined_at) >= since)
    .sort((a, b) => Date.parse(a.joined_at) - Date.parse(b.joined_at));

  for (const a of ordered) {
    if (isTestRoom.get(a.meetup_id) ?? true) { excluded.test++; continue; } // unknown room = not countable
    if (skip.has(a.id)) { excluded.test++; continue; }
    if ((sameInstant.get(a.joined_at) ?? 0) > 1) { excluded.seeded++; continue; }
    if (team.has(firstName(a.guest_name))) { excluded.team++; continue; }
    counted.push(a);
    if (!roomNo.has(a.meetup_id)) roomNo.set(a.meetup_id, roomNo.size + 1);
  }

  const events: LedgerEvent[] = [];
  let shared = 0;
  let completed = 0;
  counted.forEach((a, i) => {
    const room = roomNo.get(a.meetup_id)!;
    const guest = i + 1;
    events.push({ at: a.joined_at, room, guest, step: 'joined' });
    const didShare = hasContent(a.preferences) || hasContent(a.availability);
    if (didShare) {
      shared++;
      events.push({ at: a.updated_at, room, guest, step: 'shared' });
    }
    const v = voteAt.get(a.id);
    if (v) events.push({ at: v, room, guest, step: 'voted' });
    if (didShare && v) completed++;
  });

  events.sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  return {
    since: opts.since ?? null,
    joined: counted.length,
    shared,
    completed,
    rooms: roomNo.size,
    excluded,
    timeline: events.slice(0, timelineLimit),
  };
}
