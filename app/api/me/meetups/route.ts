import { meetupCreate } from '@/lib/schemas';
import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';
import { roomUrl } from '@/lib/urls';
import { roomExpiry } from '@/lib/expiry';
import { compareReadTimestamps, withCompleteReads } from '@/lib/complete-read';

// GET /api/me/meetups -> the organizer's meetups
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  return ok(await withCompleteReads(req, async (read) => {
    const data = await read((after, signal, pageRows, verifyEmpty) => {
      let q = supabase.from('meetups').select('*', verifyEmpty ? { count: 'exact', head: true } : undefined)
        .order('id').limit(pageRows).abortSignal(signal);
      if (after) q = q.gt('id', after);
      return q;
    }, (row) => row.id);
    data.sort((a, b) => compareReadTimestamps(b.created_at, a.created_at) || a.id.localeCompare(b.id));
    return { meetups: data.map((m) => ({ ...m, room_url: roomUrl(req, m.room_token) })) };
  }));
});

// POST /api/me/meetups -> creates a room with an unguessable token + share link.
// Nothing is sent to anyone: the organizer copies the link.
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const body = await parseBody(req, meetupCreate);
  const expires_at = roomExpiry(body.starts_at);
  const { data, error } = await supabase
    .from('meetups')
    .insert({ ...body, organizer_id: user.id, expires_at })
    .select('*')
    .single();
  dbError(error);
  const room_url = roomUrl(req, data.room_token);
  // Shared invitation text cannot infer the recipient's device timezone.
  // Label Bengaluru's zone explicitly; stored instants and device-local UI stay unchanged.
  const when = data.starts_at ? ` on ${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(data.starts_at))} IST (Asia/Kolkata)` : '';
  return ok(
    {
      meetup: { ...data, room_url },
      invite_text: `Join "${data.title}"${when}! Add your preferences and vote on a place: ${room_url}`,
    },
    201,
  );
});
