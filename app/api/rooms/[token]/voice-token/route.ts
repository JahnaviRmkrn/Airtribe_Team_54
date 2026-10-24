import { NextResponse } from 'next/server';
import { handle } from '@/lib/http';
import { mintLiveToken } from '@/lib/live-token';
import { limitRoom } from '@/lib/ratelimit';
import { getRoom, requireGuest, requireOpen } from '@/lib/room';

type Ctx = { params: Promise<{ token: string }> };

// GET /api/rooms/:token/voice-token  (joined guest only) -> { token, model, voice }
// Gemini Live token for the room's voice helper. Guests are anonymous, so a
// joined-guest cookie, an open room and a per-IP-per-room limit are all
// required: the room link alone can't be used to burn Gemini spend.
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'guestVoice', token);
  const room = await getRoom(token);
  requireOpen(room);
  await requireGuest(req, room);
  return NextResponse.json(await mintLiveToken(), { headers: { 'Cache-Control': 'no-store' } });
});
