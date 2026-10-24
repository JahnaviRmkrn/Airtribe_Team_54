// Rooms stay reachable for 14 days, or until two days after the meetup if later.
export const roomExpiry = (startsAt?: string | null) =>
  new Date(Math.max(Date.now() + 14 * 86_400_000, startsAt ? Date.parse(startsAt) + 2 * 86_400_000 : 0)).toISOString();
