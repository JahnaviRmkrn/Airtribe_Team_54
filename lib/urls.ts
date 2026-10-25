// NEXT_PUBLIC_SITE_URL (prod URL) wins over the request origin; trailing slash tolerated.
export const roomUrl = (req: Request, token: string) =>
  `${(process.env.NEXT_PUBLIC_SITE_URL || publicOrigin(req)).replace(/\/+$/, '')}/m/${token}`;

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

// Hosts a request may be served from besides NEXT_PUBLIC_SITE_URL itself:
// local dev, preview deploys and the quick-tunnel / tailnet backup URLs.
// Extra exact hosts: ALLOWED_HOSTS=a.example,b.example
const HOST_SUFFIXES = ['.vercel.app', '.trycloudflare.com', '.ts.net'];
const HOST_SHAPE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

function siteOrigin(): string | null {
  try {
    return process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL).origin : null;
  } catch {
    return null;
  }
}

function hostAllowed(host: string, site: string | null): boolean {
  if (!HOST_SHAPE.test(host)) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  if (name === 'localhost' || name === '127.0.0.1') return true;
  if (site && name === new URL(site).hostname) return true;
  if (HOST_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return (process.env.ALLOWED_HOSTS ?? '').split(',').some((h) => h.trim().toLowerCase() === name);
}

// Public origin of this request, used for post-login and signout redirects.
// Behind a reverse proxy (cloudflared, Tailscale Funnel) req.url carries the
// internal address (localhost:3000), so the Host header is used instead: the
// edge sets it for the hostname it routed. X-Forwarded-Host is NOT trusted:
// Cloudflare and most proxies pass a client-sent value straight through, so it
// could steer a redirect to any domain. A Host that isn't on the allow-list
// falls back to NEXT_PUBLIC_SITE_URL (or the URL we were called on).
export function publicOrigin(req: Request): string {
  const site = siteOrigin();
  const fallback = site ?? new URL(req.url).origin;
  const host = req.headers.get('host')?.trim();
  if (!host || !hostAllowed(host, site)) return fallback;
  const local = /^(localhost|127\.0\.0\.1)(:|$)/i.test(host);
  const fwd = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = fwd === 'http' || fwd === 'https' ? fwd : local ? 'http' : 'https';
  return `${proto}://${host}`;
}
