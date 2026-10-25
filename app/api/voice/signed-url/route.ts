import { NextResponse } from 'next/server';
import { handle, HttpError, requireUser } from '@/lib/http';
import { limitLlm } from '@/lib/ratelimit';

// GET /api/voice/signed-url  (signed-in user) -> { signed_url }
// Mints a short-lived ElevenLabs conversation URL for the onboarding agent.
// ELEVENLABS_API_KEY stays on the server; the browser only gets the signed URL.
// 503 when ElevenLabs isn't configured, so the UI can fall back to typing.
export const GET = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  await limitLlm(req, 'voice', user.id);
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!agentId || !apiKey) throw new HttpError(503, 'Voice is not configured');

  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { 'xi-api-key': apiKey }, signal: AbortSignal.timeout(10_000), cache: 'no-store' },
    );
  } catch {
    throw new HttpError(502, 'Could not reach ElevenLabs');
  }
  if (!res.ok) throw new HttpError(502, `ElevenLabs refused the request (${res.status})`);
  const data = await res.json().catch(() => null);
  const url = data?.signed_url;
  if (typeof url !== 'string' || !url.startsWith('wss://')) throw new HttpError(502, 'Unexpected response from ElevenLabs');
  return NextResponse.json({ signed_url: url }, { headers: { 'Cache-Control': 'no-store' } });
});
