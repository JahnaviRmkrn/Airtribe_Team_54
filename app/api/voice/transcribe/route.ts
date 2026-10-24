import { handle, HttpError, ok, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { audioMime, MAX_AUDIO_BYTES, transcribe, TranscribeError } from '@/lib/transcribe';

// GET  /api/voice/transcribe -> { available }  (is Gemini voice configured?)
// POST /api/voice/transcribe  body: raw audio (Content-Type audio/webm|ogg|mp4|...)
//   -> { transcript }   (signed-in user)
// Stateless: the clip is sent to Gemini and dropped, never stored. The organizer
// passes the transcript to /api/extract, and only the user's Confirm saves anything.
export const GET = handle(async (req: Request) => {
  await requireUser(req);
  return ok({ available: Boolean(process.env.GEMINI_API_KEY) });
});

export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  await limitUser('transcribe', user.id);
  const mime = audioMime(req.headers.get('content-type'));
  if (!mime) throw new HttpError(415, 'Send the recording as audio (webm, ogg or mp4)');
  if (Number(req.headers.get('content-length') ?? 0) > MAX_AUDIO_BYTES) throw new HttpError(413, 'Recording is too long');
  const audio = await req.arrayBuffer();
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, 'Recording is too long');
  if (audio.byteLength < 1000) throw new HttpError(400, 'Recording is empty - hold on a little longer');
  try {
    return ok({ transcript: await transcribe(audio, mime) });
  } catch (e) {
    if (e instanceof TranscribeError) throw new HttpError(e.status, e.message);
    throw e;
  }
});
