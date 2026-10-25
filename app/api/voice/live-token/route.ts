import { NextResponse } from 'next/server';
import { handle, requireUser } from '@/lib/http';
import { mintLiveToken } from '@/lib/live-token';
import { limitUser } from '@/lib/ratelimit';

// GET /api/voice/live-token  (signed-in user) -> { token, model, voice }
// Mints a single-use Gemini Live ephemeral token so the browser can talk to the
// Live API directly (low latency) without ever seeing GEMINI_API_KEY. The token
// is locked to our Live model with audio output (see lib/live-token.ts).
// 503 when Gemini isn't configured, so voice.js falls back to the next option.
export const GET = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  await limitUser('voice', user.id);
  return NextResponse.json(await mintLiveToken(), { headers: { 'Cache-Control': 'no-store' } });
});
