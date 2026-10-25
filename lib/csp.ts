// Content-Security-Policy for muop. Two policies:
// - APP (static organizer/room apps in public/): these build HTML from user
//   data, so scripts are allowlisted files only - no inline scripts, no
//   inline event handlers, no eval, no blob: - which turns a missed escape
//   into inert markup instead of script (and keeps the desktop bridge safe).
// - NEXT (React pages): Next's bootstrap needs inline scripts; React escapes
//   output, so these keep 'unsafe-inline' for scripts but share every other limit.
// The Supabase origin comes from the build env (local stack or hosted).

const supabase = (() => {
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || '');
    return [u.origin, `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`];
  } catch {
    return [];
  }
})();

const base = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
  'media-src': ["'self'", 'blob:', 'mediastream:'],
  'connect-src': [
    "'self'",
    ...supabase,
    'https://generativelanguage.googleapis.com',
    'wss://generativelanguage.googleapis.com',
    'https://*.elevenlabs.io',
    'wss://*.elevenlabs.io',
    'wss://*.livekit.cloud',
  ],
  'worker-src': ["'self'"],
  'frame-src': ["'none'"],
};

const scripts = {
  // Exact pinned paths (CSP only prefix-matches paths ending in '/'); bump these with the URLs in voice.js, app.js and meet.js.
  app: [
    "'self'",
    'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/',
    'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
    'https://unpkg.com/leaflet@1.9.4/',
  ],
  next: ["'self'", "'unsafe-inline'"],
};

const render = (policy: Record<string, string[]>) =>
  Object.entries(policy).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');

export const APP_CSP = render({ ...base, 'script-src': scripts.app });
export const NEXT_CSP = render({ ...base, 'script-src': scripts.next });
