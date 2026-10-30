import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { adminClient } from './supabase/admin';
import { HttpError } from './http';
import { amountPaise } from './pinelabs';
import { checkoutConfigured } from './checkout-config';
import { settleView, type SettleConfig, type SettlementRow } from './settle';
import { shortlist, type GuestPreferences, type Venue } from './shortlist';
import { areaCoords, centroid, isLatLng, nearestArea, roundTo, travel, type LatLng } from './geo';

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
export const roomColumns = 'id, organizer_id, title, activity, area, starts_at, budget, status, room_token, expires_at, final_venue_id';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');
export const hashSecret = sha256;
const cookieName = (meetupId: string) => `guest_${meetupId}`;

// Looks up a room by token. Expired rooms 404 (as if they never existed).
export async function getRoom(token: string): Promise<MeetupRow> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(404, 'Room not found');
  const { data, error } = await adminClient()
    .from('meetups')
    .select(roomColumns)
    .eq('room_token', token)
    .maybeSingle();
  if (error) throw new HttpError(500, 'Lookup failed');
  if (!data || new Date(data.expires_at) < new Date()) throw new HttpError(404, 'Room not found');
  return data as MeetupRow;
}

// Maps errors raised by the room-state triggers (see review_fixes migration).
export function roomWriteError(error: { message: string } | null, fallback: string) {
  if (!error) return;
  if (error.message.includes('room_closed')) throw new HttpError(410, 'This meetup room is closed');
  if (error.message.includes('room_full')) throw new HttpError(429, 'Room is full');
  if (error.message.includes('venue_confirmed')) throw new HttpError(409, 'The organiser has already confirmed a venue');
  throw new HttpError(400, fallback);
}

export function requireOpen(room: MeetupRow) {
  if (room.status !== 'open' || new Date(room.expires_at) < new Date()) throw new HttpError(410, 'This meetup room is closed');
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

// Settle-up config and claims. Before the settle-up migration is applied the
// columns do not exist: rooms keep working, just without settle-up.
const missingSchema = (error: { code?: string } | null) =>
  !!error && ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code ?? '');
async function loadSettle(meetupId: string): Promise<{ cfg: SettleConfig | null; rows: SettlementRow[] }> {
  const db = adminClient();
  const [{ data: cfg, error: cErr }, { data: rows, error: rErr }] = await Promise.all([
    db.from('meetups').select('upi_vpa, upi_payee, settle_amount_paise').eq('id', meetupId).maybeSingle(),
    db.from('meetup_settlements').select('attendee_id, status, amount_paise').eq('meetup_id', meetupId),
  ]);
  if (missingSchema(cErr) || missingSchema(rErr)) return { cfg: null, rows: [] };
  if (cErr || rErr) throw new HttpError(503, 'Could not load room, please retry');
  return { cfg: cfg as SettleConfig | null, rows: (rows ?? []) as SettlementRow[] };
}

// Public view of a room: only meetup details, attendees, shortlist and votes.
// Never organizer identity, contacts, notes, guest secrets or payment details.
// Settle-up (organiser's payee name and UPI ID) goes only to joined guests and the organiser.
export async function roomView(req: Request, room: MeetupRow, isOrganizer = false) {
  const db = adminClient();
  const [{ data: attendees, error: aErr }, { data: votes, error: vErr }, { data: venues, error: venErr }, { data: payments, error: pErr }, me] = await Promise.all([
    db.from('meetup_attendees').select('id, guest_name, preferences, availability, joined_at').eq('meetup_id', room.id).order('joined_at'),
    db.from('venue_votes').select('venue_id, attendee_id').eq('meetup_id', room.id),
    db.from('venues').select('id, name, area, city, activity_types, tags, price_per_person, details, source_type'),
    db.from('meetup_payments').select('attendee_id, status').eq('meetup_id', room.id),
    currentGuest(req, room),
  ]);
  const settle = await loadSettle(room.id);
  // Never build a room (and shortlist) from partial data.
  if (aErr || vErr || venErr || pErr) throw new HttpError(503, 'Could not load room, please retry');

  // Meet in the middle: each guest's shared location, else the area they typed.
  const starts = (attendees ?? []).map((a) => {
    const p = (a.preferences ?? {}) as GuestPreferences;
    return isLatLng(p.location) ? { lat: p.location.lat, lng: p.location.lng } : areaCoords(p.area);
  });
  const people = starts.filter((s): s is LatLng => !!s);
  const middle = people.length >= 2 ? centroid(people) : null;

  const list = shortlist(
    { activity: room.activity, area: room.area, budget: room.budget },
    (attendees ?? []).map((a) => a.preferences as GuestPreferences),
    (venues ?? []) as Venue[],
    5,
    { people },
  );

  const counts: Record<string, number> = {};
  for (const v of votes ?? []) counts[v.venue_id] = (counts[v.venue_id] ?? 0) + 1;
  const leading = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const finalVenue = room.final_venue_id ? (venues ?? []).find((v) => v.id === room.final_venue_id) ?? null : null;
  // Payment status per attendee only; order ids and checkout links stay server-side.
  const paymentStatus: Record<string, string> = {};
  for (const p of payments ?? []) paymentStatus[p.attendee_id] = p.status;

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
    // Exact coordinates never leave the server: guests see a label, and the map gets ~1 km pins.
    attendees: (attendees ?? []).map((a) => {
      const p = (a.preferences ?? {}) as GuestPreferences;
      if (!p.location) return a;
      const { location, ...rest } = p;
      return { ...a, preferences: { ...rest, location: { label: location.label || 'Shared location' } } };
    }),
    meeting_point: middle
      ? {
          ...roundTo(middle, 3),
          near: nearestArea(middle).area,
          people: people.length,
          ...travel(middle, people),
          pins: (attendees ?? []).flatMap((a, i) => (starts[i] ? [{ name: a.guest_name, ...roundTo(starts[i]!, 2) }] : [])),
        }
      : { people: people.length },
    shortlist: list.map((s) => {
      const c = areaCoords(s.venue.area);
      return c ? { ...s, venue: { ...s.venue, lat: c.lat, lng: c.lng } } : s;
    }),
    shortlist_note: list.length
      ? 'Sample suggestions from a seeded list, not verified listings. Check prices and availability before booking.'
      : 'Not enough preferences yet to suggest places. Add your area, budget or food/activity preferences.',
    votes: counts,
    payments: paymentStatus,
    amount_due_paise: amountPaise(finalVenue?.price_per_person),
    // false = no card checkout on this deployment; the room hides the Pine Labs card.
    checkout_configured: checkoutConfigured(),
    settle_up: settleView(settle.cfg, settle.rows, { title: room.title, canSee: !!me || isOrganizer }),
    leading_venue_id: leading?.[0] ?? null,
    me: me ? { attendee_id: me.id, voted_venue_id: (votes ?? []).find((v) => v.attendee_id === me.id)?.venue_id ?? null } : null,
    is_organizer: isOrganizer,
  };
}
