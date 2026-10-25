// Security headers for next.config.ts. Pure functions so they can be unit-tested.
//
// Two CSP flavours, because the app has two kinds of page:
//  - STATIC pages (public/organizer, public/room, served at /organizer and
//    /m/:token): plain files with no inline <script>. They render user and guest
//    text, so they get the strict policy: script-src has NO 'unsafe-inline'.
//  - NEXT pages (/, /login, /traction, ...): Next.js emits inline bootstrap
//    scripts, so script-src needs 'unsafe-inline' there. These pages render
//    through React (escaped by default) and show no guest-supplied HTML.
//
// Third parties, all pinned with SRI in the page code:
//  unpkg.com        Leaflet (guest room map; tiles come from openstreetmap.org)
//  cdn.jsdelivr.net qrcode-generator (organiser QR) and the ElevenLabs web SDK
//  Google fonts     css on fonts.googleapis.com, files on fonts.gstatic.com
//  Gemini Live      wss://generativelanguage.googleapis.com (ephemeral token)
//  ElevenLabs       wss://api.elevenlabs.io (signed URL)
// QR codes are drawn in the browser; no QR image service is contacted.

type Env = { supabaseUrl?: string; dev?: boolean };

function supabaseSources(url?: string): string[] {
  if (!url) return [];
  try {
    const u = new URL(url);
    const ws = (u.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + u.host;
    return [u.origin, ws];
  } catch {
    return [];
  }
}

export function contentSecurityPolicy(kind: 'static' | 'next', env: Env = {}): string {
  const scripts =
    kind === 'static'
      // blob: = the AudioWorklet that live.js builds from a Blob for mic capture.
      ? ["'self'", 'blob:', 'https://unpkg.com', 'https://cdn.jsdelivr.net']
      : ["'self'", "'unsafe-inline'", ...(env.dev ? ["'unsafe-eval'"] : [])];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scripts,
    // Inline style="" attributes are used by the UI and by Leaflet.
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com'],
    'connect-src': [
      "'self'",
      ...supabaseSources(env.supabaseUrl),
      'https://generativelanguage.googleapis.com',
      'wss://generativelanguage.googleapis.com',
      'https://api.elevenlabs.io',
      'wss://api.elevenlabs.io',
      ...(env.dev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : []),
    ],
    'media-src': ["'self'", 'blob:', 'data:'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

// Sent on every response.
export const baseSecurityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Voice features use the microphone and the room's "use my location" button
  // uses geolocation, both from our own pages only. Everything else is off.
  {
    key: 'Permissions-Policy',
    value: 'microphone=(self), geolocation=(self), camera=(), payment=(), usb=(), bluetooth=(), serial=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()',
  },
];

// Paths served as plain static files (see rewrites in next.config.ts).
export const STATIC_PAGE_SOURCES = ['/organizer', '/organizer/:path*', '/room/:path*', '/m/:token'];
// Everything else is rendered by Next. Disjoint from the list above on purpose,
// so a path never receives two Content-Security-Policy headers.
export const NEXT_PAGE_SOURCE = '/((?!organizer|room/|m/|_next/static|_next/image).*)';
