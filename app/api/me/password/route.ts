import { z } from 'zod';
import { HttpError, ok, parseBody, requireUser } from '@/lib/http';

const input = z.object({ password: z.string().min(6) }).strict();
const accountChanged = 'Your signed-in account changed. Request a new reset link before changing a password.';
const signInAgain = 'Your session expired or could not be verified. Sign in again or request a new reset link.';
const uncertain = 'We could not confirm whether your password changed. Try signing in with the new password before requesting another reset.';

function appOrigin(req: Request) {
  try {
    const configured = process.env.NEXT_PUBLIC_SITE_URL;
    if (configured) {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      return url.origin;
    }
    // A reverse proxy may use an internal req.url while preserving standard
    // Host. Never use caller-supplied forwarded-host/proto as an auth allowlist.
    const host = req.headers.get('host');
    if (!host) return new URL(req.url).origin;
    const parsed = new URL('https://' + host);
    if (/[\s,%/@?#\\]/.test(host) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    return new URL((local ? new URL(req.url).protocol : 'https:') + '//' + host).origin;
  } catch {
    throw new HttpError(503, 'Password updates are unavailable until the app public URL is configured correctly.');
  }
}

function reply(body: unknown, status = 200) {
  const response = ok(body, status);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

// Cookie-only, owner-bound update. No bearer-token extraction, admin access,
// session refresh, cookie persistence, or automatic provider resubmission.
export async function POST(req: Request) {
  try {
    if (req.headers.get('origin') !== appOrigin(req) || req.headers.get('sec-fetch-site') === 'cross-site') {
      throw new HttpError(403, 'Open password reset from this app and try again.');
    }
    if (req.headers.has('authorization')) throw new HttpError(400, 'Use the signed-in browser session to reset your password.');
    if (!req.headers.get('X-Contact-Owner')?.trim()) throw new HttpError(409, accountChanged);
    const { password } = await parseBody(req, input);
    const { supabase, user } = await requireUser(req, { writeCookies: false, allowRefresh: false });
    let result;
    try {
      result = await supabase.auth.updateUser({ password });
    } catch {
      // Never pass provider/request objects to handle() or console.error: they
      // can contain password/session material, and transport loss is ambiguous.
      return reply({ error: uncertain, code: 'password_update_uncertain' }, 502);
    }
    if (result.error) {
      if ([401, 403].includes(result.error.status ?? 0)) return reply({ error: signInAgain, code: 'password_session_expired' }, 401);
      if ([400, 422].includes(result.error.status ?? 0)) return reply({ error: 'The password was rejected. Choose another password or request a new reset link.', code: 'password_update_rejected' }, 400);
      return reply({ error: uncertain, code: 'password_update_uncertain' }, 502);
    }
    if (result.data?.user?.id !== user.id) return reply({ error: uncertain, code: 'password_update_uncertain' }, 502);
    return reply({ updated: true });
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) return reply({ error: signInAgain, code: 'password_session_expired' }, 401);
      if (error.status === 409) return reply({ error: accountChanged, code: 'password_owner_changed' }, 409);
      return reply({ error: error.message, code: error.status === 400 ? 'password_update_rejected' : 'password_update_unavailable' }, error.status);
    }
    // Setup and verification failed before an update, without logging secrets.
    return reply({ error: 'Password reset is temporarily unavailable. Refresh this page or try again later.', code: 'password_update_unavailable' }, 503);
  }
}
