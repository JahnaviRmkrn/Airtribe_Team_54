import { saveSmsCreds } from '@/lib/channels';
import { handle, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { checkLocalUrl, smsLinkBody } from '@/lib/sms-gateway';

// POST /api/me/sms/link  { accept: true, mode: 'cloud'|'local', url?, username, password }
// Stores the SMS Gateway for Android credentials sealed with AES-256-GCM.
// They are write-only: no endpoint ever returns them.
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  const body = await parseBody(req, smsLinkBody);
  await limitUser('smsLink', user.id);
  if (body.mode === 'local') checkLocalUrl(body.url ?? '');
  await saveSmsCreds(user.id, {
    mode: body.mode,
    url: body.mode === 'local' ? body.url : undefined,
    username: body.username,
    password: body.password,
  });
  return ok({ linked: true, mode: body.mode });
});
