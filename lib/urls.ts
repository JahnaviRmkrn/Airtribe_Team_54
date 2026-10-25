// NEXT_PUBLIC_SITE_URL (prod URL) wins over the request origin; trailing slash tolerated.
export const roomUrl = (req: Request, token: string) =>
  `${(process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin).replace(/\/+$/, '')}/m/${token}`;

// Turns an untrusted ?next= value into a same-origin path, or '/'.
// Resolving first catches javascript:, //host, /\host and similar tricks.
export function safeNext(next: string | null | undefined, origin: string): string {
  if (!next) return '/';
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin || (u.protocol !== 'http:' && u.protocol !== 'https:')) return '/';
    // A same-origin absolute URL (or dot-segment path) can normalize to a
    // pathname starting with //, which becomes off-origin when used again as
    // a relative redirect. Validate the path we return as well as the input.
    if (u.pathname.startsWith('//')) return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

function originUrl(value: string): URL {
  // Require an origin, not credentials, paths, escaped hosts, or URL-parser
  // repairs such as https:host and backslash separators. Allow one root slash.
  if (!/^https?:\/\/[^/\\?#\s,%@]+\/?$/i.test(value)) throw new Error('Invalid public origin');
  try {
    return new URL(value);
  } catch {
    // Do not include configuration or attacker-supplied values in errors.
    throw new Error('Invalid public origin');
  }
}

// A configured canonical origin wins, including behind a reverse proxy. With
// no configuration, retain the proxy fallback for preview/local deployments.
// That fallback requires a trusted ingress to overwrite forwarding/Host headers;
// syntax validation alone cannot establish that a valid host belongs to this app.
export function publicOrigin(req: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return originUrl(configured).origin;

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host === null) return originUrl(new URL(req.url).origin).origin;
  if (/[\s,%/@?#\\]/.test(host)) throw new Error('Invalid public origin');
  const parsed = originUrl(`https://${host}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  const forwarded = req.headers.get('x-forwarded-proto')?.split(',').map((value) => value.trim().toLowerCase());
  if (forwarded?.some((value) => value !== 'http' && value !== 'https')) throw new Error('Invalid public origin');
  const proto = forwarded?.[0] ?? (local ? 'http' : 'https');
  return originUrl(`${proto}://${host}`).origin;
}
