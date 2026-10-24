import 'server-only';
import { assistantBody, fromChatResponse, toChatRequest } from '@/lib/assistant';
import { handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';

// POST /api/assistant  body: { messages, context, tools, instructions }  (signed-in user)
// -> { reply, tool_calls: [{ id, name, arguments }] }
// Text fallback for the voice assistant. DeepSeek picks which of the declared
// tools to call; the browser runs them with the user's own session and posts
// the results back as role "tool" messages. Never touches the database.
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  await limitUser('assistant', user.id);
  if (Number(req.headers.get('content-length') ?? 0) > 200_000) throw new HttpError(413, 'Request is too large');
  const body = await parseBody(req, assistantBody);
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new HttpError(503, 'Assistant is not configured');
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(toChatRequest(body, process.env.DEEPSEEK_MODEL || 'deepseek-chat')),
      signal: AbortSignal.timeout(25_000),
      cache: 'no-store',
    });
  } catch {
    throw new HttpError(502, 'Could not reach the assistant model');
  }
  if (!res.ok) throw new HttpError(502, `Assistant model returned ${res.status}`);
  return ok(fromChatResponse(await res.json().catch(() => null), body));
});
