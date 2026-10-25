import { loadSmsCreds } from '@/lib/channels';
import { handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { sendSms, smsTestBody } from '@/lib/sms-gateway';

// POST /api/me/sms/test  { to }
// "Send test SMS to myself". Fixed text and 3 per hour, because the number is
// typed in rather than picked from the organiser's contacts.
export const POST = handle(async (req: Request) => {
  const { user } = await requireUser(req);
  const body = await parseBody(req, smsTestBody);
  await limitUser('smsTest', user.id);
  const creds = await loadSmsCreds(user.id);
  if (!creds) throw new HttpError(409, 'Link SMS first');
  await sendSms(creds, body.to, 'muop test: your SMS gateway is linked.');
  return ok({ sent: true });
});
