// Deterministic venue shortlist. Pure function: no I/O, easy to test.
import { areaCoords, travel, type LatLng } from './geo';
// Returns [] when there is not enough signal, rather than inventing results.

export type Venue = {
  id: string;
  name: string;
  area: string;
  city?: string;
  activity_types: string[];
  tags: string[];
  price_per_person: number | null;
  details?: string | null;
  source_type: string;
};

export type GuestPreferences = {
  budget_min?: number;
  budget_max?: number;
  area?: string;
  location?: { lat: number; lng: number; label?: string };
  food?: string[];
  activities?: string[];
};

export type MeetupInput = {
  activity?: string | null;
  area?: string | null;
  budget?: number | null;
};

export type ShortlistItem = {
  venue: Venue;
  score: number;
  reasons: string[];
  label: string;
  travel?: { max_km: number; avg_km: number }; // from everyone who shared where they are
};

// Up to this many km for the longest trip still earns distance points.
const FAIR_KM = 25;

const norm = (s: string) => s.trim().toLowerCase();

export function shortlist(
  meetup: MeetupInput,
  prefs: GuestPreferences[],
  venues: Venue[],
  limit = 5,
  opts: { people?: LatLng[] } = {},
): ShortlistItem[] {
  // Meet in the middle: with 2+ known starting points, rank by the longest trip.
  const people = (opts.people ?? []).filter(Boolean);
  const byDistance = people.length >= 2;
  const activity = meetup.activity ? norm(meetup.activity) : null;
  const areas = new Map<string, number>();
  const bump = (a?: string | null) => {
    if (a && a.trim()) areas.set(norm(a), (areas.get(norm(a)) ?? 0) + 1);
  };
  bump(meetup.area);
  prefs.forEach((p) => bump(p.area));

  const wantedTags = new Set(
    prefs.flatMap((p) => [...(p.food ?? []), ...(p.activities ?? [])]).map(norm),
  );
  const budgets = prefs.filter((p) => p.budget_max != null || p.budget_min != null);

  // Nothing to match on at all -> honest empty result.
  if (!activity && areas.size === 0 && wantedTags.size === 0 && budgets.length === 0 && meetup.budget == null && !byDistance) {
    return [];
  }

  const headcount = Math.max(prefs.length, 1);
  const out: ShortlistItem[] = [];

  for (const v of venues) {
    const reasons: string[] = [];
    let score = 0;
    let relevant = false;

    if (activity) {
      if (v.activity_types.map(norm).includes(activity)) {
        score += 3;
        relevant = true;
        reasons.push(`Good for ${activity}`);
      } else {
        continue; // wrong kind of place for this meetup
      }
    }

    const areaVotes = areas.get(norm(v.area)) ?? 0;
    if (areaVotes > 0) {
      score += 2 * (areaVotes / (headcount + (meetup.area ? 1 : 0)));
      relevant = true;
      // The organiser's area is weighted like a vote, but the reason only
      // counts guests: "preferred by 1" with nobody in the room reads as a bug.
      const organiserPick = !!meetup.area && norm(meetup.area) === norm(v.area);
      const guestVotes = areaVotes - (organiserPick ? 1 : 0);
      const who = [organiserPick ? "organiser's pick" : '', guestVotes ? `preferred by ${guestVotes}` : ''].filter(Boolean).join(', ');
      reasons.push(`In ${v.area} (${who})`);
    }

    const matched = v.tags.filter((t) => wantedTags.has(norm(t)));
    if (matched.length) {
      score += Math.min(matched.length, 3);
      relevant = true;
      reasons.push(`Matches ${matched.join(', ')}`);
    }

    if (v.price_per_person != null) {
      const price = v.price_per_person;
      if (meetup.budget != null) {
        if (price > meetup.budget) continue; // over the organiser's budget
        score += 1;
        reasons.push(`Within organiser budget (~₹${price}/person)`);
      }
      if (budgets.length) {
        const fits = budgets.filter(
          (p) => (p.budget_min == null || price >= p.budget_min * 0.5) && (p.budget_max == null || price <= p.budget_max),
        ).length;
        if (fits === 0) continue; // too expensive for everyone who set a budget
        score += 2 * (fits / budgets.length) - 1;
        reasons.push(`Fits budget for ${fits}/${budgets.length}`);
      }
    }

    let trip: ShortlistItem['travel'];
    const spot = byDistance ? areaCoords(v.area) : null;
    if (spot) {
      trip = travel(spot, people);
      score += 3 * Math.max(0, 1 - trip.max_km / FAIR_KM);
      relevant = true;
      reasons.push(`Max ${trip.max_km} km for anyone (avg ${trip.avg_km} km)`);
    }

    if (relevant && score > 0) {
      out.push({ venue: v, score: Math.round(score * 100) / 100, reasons, label: 'Sample suggestion', ...(trip ? { travel: trip } : {}) });
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.venue.name.localeCompare(b.venue.name))
    .slice(0, limit);
}
