import 'server-only';

// Voice onboarding without ElevenLabs: the browser records a clip and the
// server asks Gemini for a verbatim transcript, which then goes through the
// usual /api/extract pre-fill. GEMINI_API_KEY stays on the server.
// Gemini models get "high demand" 503s, so try the configured model first and
// fall back to the next one on 429/5xx.

const TIMEOUT_MS = 45_000;
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // ~4 min of opus, well past the 30 s ask

// What browsers record: Chrome/Edge webm, Firefox ogg, Safari mp4. All verified with Gemini.
const MIME = /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav|aac|flac)$/;
export const audioMime = (contentType: string | null) => {
  const base = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return MIME.test(base) ? base : null;
};

const PROMPT =
  'Transcribe this audio verbatim. The speaker is describing people they want to stay in touch with ' +
  '(names, how they know them, interests) and how they want to split their time. ' +
  'Output only the transcript text, no labels or commentary. If there is no speech, output nothing.';

const models = () =>
  [...new Set([process.env.GEMINI_VOICE_MODEL || 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest'])];

export class TranscribeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function transcribe(audio: ArrayBuffer, mime: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new TranscribeError('Voice is not configured', 503);
  const data = Buffer.from(audio).toString('base64');
  let last = 'no model answered';
  for (const model of models()) {
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        // Key in a header, not the query string, so it never lands in URL logs.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: mime, data } }, { text: PROMPT }] }],
          generationConfig: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      last = `${model} returned ${res.status}`;
      continue;
    }
    if (!res.ok) throw new TranscribeError(`Transcription failed (${res.status})`, 502);
    const body = await res.json().catch(() => null);
    const text = body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('').trim();
    return typeof text === 'string' ? text : '';
  }
  console.warn('transcribe: every Gemini model failed:', last);
  throw new TranscribeError('Voice service is busy - try again or type instead', 503);
}
