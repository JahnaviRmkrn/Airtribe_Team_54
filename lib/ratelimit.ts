import 'server-only';
import { adminClient } from './supabase/admin';
import { HttpError } from './http';

export type Limit = { max: number; windowSeconds: number };

// Presets for the public room API. Each preset name is also its bucket.
export const LIMITS = {
  view: { max: 120, windowSeconds: 60 }, // room page polls every 3-5 s
  join: { max: 10, windowSeconds: 60 },
  joinHourly: { max: 60, windowSeconds: 3600 }, // per IP across all rooms
  write: { max: 30, windowSeconds: 60 }, // vote, unvote, PATCH me
  organizer: { max: 30, windowSeconds: 60 }, // confirm, close
  pay: { max: 10, windowSeconds: 60 },
} satisfies Record<string, Limit>;
export type Preset = keyof typeof LIMITS;

// WARNING: x-forwarded-for is client-controlled unless a proxy overwrites it.
// Vercel sets it to the real client IP; behind another host, check that the
// proxy strips incoming values, or limits can be dodged by spoofing the header.
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return xff || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export function rateLimitKey(req: Request, bucket: string, extraKey?: string): string {
  // Tokens are <= 100 chars when valid; cap junk so keys stay small.
  return [bucket, clientIp(req), extraKey?.slice(0, 100)].filter(Boolean).join(':');
}

// Counts a hit and throws 429 once over the limit for this window.
export async function rateLimit(req: Request, bucket: string, { max, windowSeconds }: Limit, extraKey?: string) {
  const { data, error } = await adminClient().rpc('hit_rate_limit', {
    p_key: rateLimitKey(req, bucket, extraKey),
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  // Fail open: a limiter outage must not take the demo down with it.
  if (error) {
    console.error('rate limit check failed', error);
    return;
  }
  if (data === false) throw new HttpError(429, 'Too many requests, slow down');
}

// One-liner for room routes, e.g. `await limitRoom(req, 'pay', token);`
export const limitRoom = (req: Request, preset: Preset, token: string) => rateLimit(req, preset, LIMITS[preset], token);
