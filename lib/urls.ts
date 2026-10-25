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
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

// Public origin of this request. Behind a reverse proxy (cloudflared, Tailscale
// Funnel) req.url carries the internal address (localhost:3000), so prefer the
// forwarded/Host headers or the post-login redirect lands on localhost.
export function publicOrigin(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host) return new URL(req.url).origin;
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || (local ? 'http' : 'https');
  return `${proto}://${host}`;
}
