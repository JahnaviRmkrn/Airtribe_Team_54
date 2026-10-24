import { extractBody } from '@/lib/extract';
import { extract } from '@/lib/extract-llm';
import { handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';

// POST /api/extract  body: { transcript }  (signed-in user)
// -> { contacts: [<=5 {name, category, interests, preferred_frequency_days?}],
//      goals: {personal, professional, community} (total 100), source, saved: false }
// Stateless: never writes to the DB. The organizer's confirm screen shows the
// result for editing and only the user's explicit Confirm saves anything.
// Sign-in is required so this can't be used as a free LLM proxy.
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  await limitUser('extract', user.id);
  if (Number(req.headers.get('content-length') ?? 0) > 100_000) throw new HttpError(413, 'Transcript is too long');
  const { transcript } = await parseBody(req, extractBody);
  return ok({ ...(await extract(transcript)), saved: false });
});
