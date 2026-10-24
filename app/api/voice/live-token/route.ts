import { NextResponse } from 'next/server';
import { handle, HttpError, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';

// GET /api/voice/live-token  (signed-in user) -> { token, model, voice }
// Mints a single-use Gemini Live ephemeral token so the browser can talk to the
// Live API directly (low latency) without ever seeing GEMINI_API_KEY. The token
// must open its session within 60 s and expires after 30 min.
// 503 when Gemini isn't configured, so voice.js falls back to the next option.
export const GET = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  await limitUser('voice', user.id);
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpError(503, 'Voice is not configured');

  const now = Date.now();
  let res: Response;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch {
    throw new HttpError(502, 'Could not reach Gemini');
  }
  if (!res.ok) throw new HttpError(502, `Gemini refused the token request (${res.status})`);
  const data = await res.json().catch(() => null);
  if (typeof data?.name !== 'string') throw new HttpError(502, 'Unexpected response from Gemini');
  return NextResponse.json(
    { token: data.name, model: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live', voice: process.env.GEMINI_LIVE_VOICE || 'Aoede' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
