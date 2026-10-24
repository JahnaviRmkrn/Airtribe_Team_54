import { meetupUpdate } from '@/lib/schemas';
import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';
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
  const body = await parseBody(req, meetupUpdate);
  // Rescheduling recomputes room expiry with the same rule as creation.
  const patch = body.starts_at !== undefined ? { ...body, expires_at: roomExpiry(body.starts_at) } : body;
  const { data, error } = await supabase.from('meetups').update(patch).eq('id', id).select('*').single();
  dbError(error);
  return ok({ meetup: { ...data, room_url: roomUrl(req, data.room_token) } });
});

export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const { data, error } = await supabase.from('meetups').delete().eq('id', id).select('id').single();
  dbError(error);
  return ok({ deleted: data!.id });
});
