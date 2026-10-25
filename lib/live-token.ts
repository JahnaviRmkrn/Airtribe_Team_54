import 'server-only';
import { HttpError } from './http';

// Mints a single-use Gemini Live ephemeral token so a browser can talk to the
// Live API directly without ever seeing GEMINI_API_KEY. The token must open
// its session within 60 s, expires after 30 min, and only works for our Live
// model with audio output.
export async function mintLiveToken(): Promise<{ token: string; model: string; voice: string }> {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
  const voice = process.env.GEMINI_LIVE_VOICE || 'Aoede';
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
        // Lock the token to our Live model and audio output: without this a
        // holder could open any model/config on our key for 30 minutes.
        bidiGenerateContentSetup: { model: 'models/' + model, generationConfig: { responseModalities: ['AUDIO'] } },
        // Lock only these; the browser still sends its own instructions and tools.
        fieldMask: 'model,generationConfig.responseModalities',
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
  return { token: data.name, model, voice };
}
