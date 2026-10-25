import { meetupUpdate } from '@/lib/schemas';
import { dbError, handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { roomUrl } from '@/lib/urls';
import { roomExpiry } from '@/lib/expiry';

type Ctx = { params: Promise<{ id: string }> };

// GET /api/me/meetups/:id -> meetup + attendees + votes (organizer only, via RLS)
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const { data: meetup, error } = await supabase.from('meetups').select('*').eq('id', id).single();
  dbError(error);
  const [{ data: attendees }, { data: votes }] = await Promise.all([
    supabase.from('meetup_attendees').select('id, guest_name, preferences, availability, joined_at').eq('meetup_id', id),
    supabase.from('venue_votes').select('venue_id, attendee_id').eq('meetup_id', id),
  ]);
  return ok({ meetup: { ...meetup, room_url: roomUrl(req, meetup.room_token) }, attendees, votes });
});

// PATCH /api/me/meetups/:id -> edit details, close (status: 'closed'), or set final_venue_id
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const { expected_updated_at, ...body } = await parseBody(req, meetupUpdate);
  if (!Object.keys(body).length) throw new HttpError(400, 'No meetup changes supplied');
  const editsDetails = ['title', 'activity', 'area', 'starts_at', 'budget', 'notes']
    .some((field) => Object.hasOwn(body, field));
  // Rescheduling recomputes room expiry with the same rule as creation.
  const patch = body.starts_at !== undefined ? { ...body, expires_at: roomExpiry(body.starts_at) } : body;
  let query = supabase.from('meetups').update(patch).eq('id', id);
  // These predicates are checked atomically with UPDATE, not a read-then-write
  // check. RLS still scopes both the update and conflict lookup to the owner.
  if (editsDetails) query = query.eq('status', 'open');
  if (expected_updated_at) query = query.eq('updated_at', expected_updated_at);
  const { data, error } = await query.select('*').maybeSingle();
  dbError(error);
  if (!data) {
    const { data: current, error: readError } = await supabase.from('meetups')
      .select('id, status').eq('id', id).maybeSingle();
    dbError(readError);
    if (!current) throw new HttpError(404, 'Not found');
    if (editsDetails && current.status !== 'open') throw new HttpError(410, 'This meetup room is closed');
    throw new HttpError(409, 'This meetup changed since you opened it. Reload the latest details before saving.');
  }
  return ok({ meetup: { ...data, room_url: roomUrl(req, data.room_token) } });
});

export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const { data, error } = await supabase.from('meetups').delete().eq('id', id).select('id').single();
  dbError(error);
  return ok({ deleted: data!.id });
});
