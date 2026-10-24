import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { adminClient } from './supabase/admin';
import { HttpError } from './http';
import { shortlist, type GuestPreferences, type Venue } from './shortlist';

export type MeetupRow = {
  id: string;
  organizer_id: string;
  title: string;
  activity: string;
  area: string | null;
  starts_at: string | null;
  budget: number | null;
  status: 'open' | 'closed';
  room_token: string;
  expires_at: string;
  final_venue_id: string | null;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = sha256;
const cookieName = (meetupId: string) => `guest_${meetupId}`;

// Looks up a room by token. Expired rooms 404 (as if they never existed).
export async function getRoom(token: string): Promise<MeetupRow> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(404, 'Room not found');
  const { data, error } = await adminClient()
    .from('meetups')
    .select('id, organizer_id, title, activity, area, starts_at, budget, status, room_token, expires_at, final_venue_id')
    .eq('room_token', token)
    .maybeSingle();
  if (error) throw new HttpError(500, 'Lookup failed');
  if (!data || new Date(data.expires_at) < new Date()) throw new HttpError(404, 'Room not found');
  return data as MeetupRow;
}

export function requireOpen(room: MeetupRow) {
  if (room.status !== 'open') throw new HttpError(410, 'This meetup room is closed');
}

export async function setGuestCookie(room: MeetupRow, secret: string) {
  (await cookies()).set(cookieName(room.id), secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: new Date(room.expires_at),
  });
}

// Identifies the current guest from their cookie (or `X-Guest-Secret` header,
// handy for curl and for testing several guests from one browser).
export async function currentGuest(req: Request, room: MeetupRow): Promise<{ id: string } | null> {
  const secret = req.headers.get('x-guest-secret') ?? (await cookies()).get(cookieName(room.id))?.value;
  if (!secret) return null;
  const hash = sha256(secret);
  const { data } = await adminClient()
    .from('meetup_attendees')
    .select('id, secret_hash')
    .eq('meetup_id', room.id)
    .eq('secret_hash', hash)
    .maybeSingle();
  if (!data) return null;
  const a = Buffer.from(data.secret_hash), b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b) ? { id: data.id } : null;
}

export async function requireGuest(req: Request, room: MeetupRow) {
  const g = await currentGuest(req, room);
  if (!g) throw new HttpError(401, 'Join this room first');
  return g;
}

// Public view of a room: only meetup details, attendees, shortlist and votes.
// Never organizer identity, contacts, notes, or guest secrets.
export async function roomView(req: Request, room: MeetupRow, isOrganizer = false) {
  const db = adminClient();
  const [{ data: attendees }, { data: votes }, { data: venues }, me] = await Promise.all([
    db.from('meetup_attendees').select('id, guest_name, preferences, availability, joined_at').eq('meetup_id', room.id).order('joined_at'),
    db.from('venue_votes').select('venue_id, attendee_id').eq('meetup_id', room.id),
    db.from('venues').select('id, name, area, city, activity_types, tags, price_per_person, details, source_type'),
    currentGuest(req, room),
  ]);

  const list = shortlist(
    { activity: room.activity, area: room.area, budget: room.budget },
    (attendees ?? []).map((a) => a.preferences as GuestPreferences),
    (venues ?? []) as Venue[],
  );

  const counts: Record<string, number> = {};
  for (const v of votes ?? []) counts[v.venue_id] = (counts[v.venue_id] ?? 0) + 1;
  const leading = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const finalVenue = room.final_venue_id ? (venues ?? []).find((v) => v.id === room.final_venue_id) ?? null : null;

  return {
    meetup: {
      title: room.title,
      activity: room.activity,
      area: room.area,
      starts_at: room.starts_at,
      budget: room.budget,
      status: room.status,
      expires_at: room.expires_at,
      final_venue: finalVenue,
    },
    attendees: attendees ?? [],
    shortlist: list,
    shortlist_note: list.length
      ? 'Sample suggestions from a seeded list, not verified listings. Check prices and availability before booking.'
      : 'Not enough preferences yet to suggest places. Add your area, budget or food/activity preferences.',
    votes: counts,
    leading_venue_id: leading?.[0] ?? null,
    me: me ? { attendee_id: me.id, voted_venue_id: (votes ?? []).find((v) => v.attendee_id === me.id)?.venue_id ?? null } : null,
    is_organizer: isOrganizer,
  };
}
