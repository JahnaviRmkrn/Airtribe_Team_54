import { handle, ok } from '@/lib/http';
import { getRoom, roomView } from '@/lib/room';
import { userClient } from '@/lib/supabase/server';
import { limitRoom } from '@/lib/ratelimit';

type Ctx = { params: Promise<{ token: string }> };

// GET /api/rooms/:token -> public room view (no login needed).
// Poll this every few seconds for "live" updates.
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'view', token);
  const room = await getRoom(token);
  const { data } = await (await userClient(req)).auth.getUser();
  return ok(await roomView(req, room, data.user?.id === room.organizer_id));
});
