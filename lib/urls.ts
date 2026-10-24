export const roomUrl = (req: Request, token: string) =>
  `${process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin}/m/${token}`;

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
