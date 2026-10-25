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
  extract: { max: 10, windowSeconds: 60 }, // per signed-in user (LLM spend)
  assistant: { max: 30, windowSeconds: 60 }, // per signed-in user (LLM spend, several rounds per command)
  guestVoice: { max: 20, windowSeconds: 600 }, // per IP per room: cheap pre-auth filter for the room voice helper
  guestVoiceGuest: { max: 5, windowSeconds: 600 }, // per joined guest (the secret is portable across IPs)
  guestVoiceRoom: { max: 30, windowSeconds: 600 }, // per room across everyone
  voice: { max: 50, windowSeconds: 600 }, // per signed-in user (Gemini Live / transcribe sessions; demo-friendly)
  draft: { max: 20, windowSeconds: 60 }, // per signed-in user (LLM spend)
  transcribe: { max: 10, windowSeconds: 60 }, // per signed-in user (Gemini audio)
  // Per client IP across ALL rooms / tokens: random-token probing and signup-farmed accounts
  // can't dodge the per-token and per-user buckets by spreading out. Generous for shared NATs.
  roomIp: { max: 1200, windowSeconds: 60 },
  llmIp: { max: 300, windowSeconds: 600 },
} satisfies Record<string, Limit>;
export type Preset = keyof typeof LIMITS;

// Real client IP, from the header the platform's edge sets rather than one the
// client can send. A client can put anything in the FIRST x-forwarded-for entry
// (Cloudflare and most proxies append to it), so it is never trusted:
//  - Vercel overwrites x-real-ip / x-vercel-forwarded-for;
//  - Cloudflare (tunnel) sets cf-connecting-ip and overwrites any client value;
//  - otherwise the LAST x-forwarded-for entry, the one our nearest proxy added.
// IPv6 clients are bucketed by /64 so one host can't rotate through its whole prefix.
export function clientIp(req: Request): string {
  const h = (name: string) => req.headers.get(name)?.trim() || undefined;
  const xff = h('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean);
  const ip = process.env.VERCEL
    ? h('x-vercel-forwarded-for')?.split(',')[0]?.trim() || h('x-real-ip') || xff?.at(-1)
    : h('cf-connecting-ip') || xff?.at(-1) || h('x-real-ip');
  return ip ? ipBucket(ip) : 'unknown';
}

export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip.slice(0, 45);
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4) return v4[1];
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
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
export const limitRoom = (req: Request, preset: Preset, token: string) =>
  Promise.all([rateLimit(req, preset, LIMITS[preset], token), rateLimit(req, 'roomIp', LIMITS.roomIp)]).then(() => undefined);

// Per signed-in user (any IP), for routes that spend paid API credit.
export async function limitUser(preset: Preset, userId: string) {
  const { max, windowSeconds } = LIMITS[preset];
  const { data, error } = await adminClient().rpc('hit_rate_limit', {
    p_key: `${preset}:user:${userId}`,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  if (error) {
    console.error('rate limit check failed', error);
    return;
  }
  if (data === false) throw new HttpError(429, 'Too many requests, slow down');
}

// LLM / voice routes: per signed-in user AND per client IP, so free accounts
// created in bulk from one address can't multiply the spend.
export const limitLlm = (req: Request, preset: Preset, userId: string) =>
  Promise.all([limitUser(preset, userId), rateLimit(req, 'llmIp', LIMITS.llmIp)]).then(() => undefined);
