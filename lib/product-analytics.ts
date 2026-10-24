import 'server-only';
import { track } from '@vercel/analytics/server';

// No user properties, names, room URLs, transcript content or credentials.
// Analytics failure must never make a committed product action look failed.
export async function trackProductEvent(event: 'meetup_created' | 'guest_joined') {
  if (process.env.VERCEL_ENV !== 'production') return;
  try {
    // Explicit minimal headers avoid forwarding token-bearing referer URLs.
    await track(event, {}, { headers: { 'user-agent': 'Team54-server' } });
  } catch {
    console.warn('Product analytics unavailable');
  }
}
