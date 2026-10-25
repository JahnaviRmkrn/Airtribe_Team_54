import { NextResponse } from 'next/server';
import { handle } from '@/lib/http';
import { mintLiveToken } from '@/lib/live-token';
import { limitRoom, limitUser } from '@/lib/ratelimit';
import { getRoom, requireGuest, requireOpen } from '@/lib/room';

// Anonymous guests get short-lived tokens: a token is paid Gemini time on our key.
const GUEST_TOKEN_TTL_MIN = 10;

type Ctx = { params: Promise<{ token: string }> };

// GET /api/rooms/:token/voice-token  (joined guest only) -> { token, model, voice }
// Gemini Live token for the room's voice helper. Guests are anonymous, so a
// joined-guest cookie, an open room and per-IP, per-guest and per-room limits
// are all required, and the token itself is locked to one model and audio
// output (lib/live-token.ts), so it can't be reused as a general Gemini key.
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { token } = await params;
  await limitRoom(req, 'guestVoice', token);
  const room = await getRoom(token);
  requireOpen(room);
  const me = await requireGuest(req, room);
  // The guest secret works from any IP, so also cap per guest and per room.
  await limitUser('guestVoiceGuest', `attendee:${me.id}`);
  await limitUser('guestVoiceRoom', `room:${room.id}`);
  return NextResponse.json(await mintLiveToken(GUEST_TOKEN_TTL_MIN), { headers: { 'Cache-Control': 'no-store' } });
});
