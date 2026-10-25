import { guestUpdate } from '@/lib/schemas';
import { handle, HttpError, ok, parseBody } from '@/lib/http';
import { getRoom, requireGuest, requireOpen, roomView, roomWriteError } from '@/lib/room';
import { adminClient } from '@/lib/supabase/admin';
import { LIMITS, limitRoom, rateLimit } from '@/lib/ratelimit';

type Ctx = { params: Promise<{ token: string }> };

// GET /api/rooms/:token/me -> the current guest's own entry
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await rateLimit(req, 'me', LIMITS.view, token);
  const room = await getRoom(token);
  const me = await requireGuest(req, room);
  const { data, error } = await adminClient()
    .from('meetup_attendees')
    .select('id, guest_name, preferences, availability, joined_at')
    .eq('id', me.id)
    .eq('meetup_id', room.id)
    .single();
  if (error || !data) throw new HttpError(503, 'Could not load your preferences, please retry');
  return ok({ attendee: data });
});

// PATCH /api/rooms/:token/me -> a guest edits only their own name/preferences
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'write', token);
  const room = await getRoom(token);
  requireOpen(room);
  const me = await requireGuest(req, room);
  const body = await parseBody(req, guestUpdate);
  let retainedPreferences: string | undefined;
  // The room view never returns exact coordinates, so a preferences save that
  // omits `location` keeps the stored one; `location: null` stops sharing.
  if (body.preferences) {
    const prefs: Record<string, unknown> = { ...body.preferences };
    if (prefs.location === undefined) {
      const { data: cur, error } = await adminClient().from('meetup_attendees').select('preferences').eq('id', me.id).eq('meetup_id', room.id).single();
      // An unavailable read is not proof that this guest stopped sharing.
      // Do not replace their preferences unless the retained value is known.
      if (error || !cur) throw new HttpError(503, 'Could not load your preferences, please retry');
      retainedPreferences = JSON.stringify(cur.preferences);
      const kept = (cur?.preferences as Record<string, unknown> | null)?.location;
      if (kept) prefs.location = kept;
    } else if (prefs.location === null) {
      delete prefs.location;
    }
    body.preferences = prefs as typeof body.preferences;
  }
  let update = adminClient().from('meetup_attendees').update(body).eq('id', me.id).eq('meetup_id', room.id);
  // A second request may have stopped sharing since our read. Compare the
  // JSONB snapshot atomically instead of restoring a superseded location.
  if (retainedPreferences !== undefined) update = update.eq('preferences', retainedPreferences);
  const { data: updated, error } = await update.select('id').maybeSingle();
  roomWriteError(error, 'Could not update');
  if (!updated) throw new HttpError(409, 'Your preferences changed. Reload and try again.');
  return ok(await roomView(req, room));
});
