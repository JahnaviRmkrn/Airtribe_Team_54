import { describe, expect, it } from 'vitest';
import { baseSecurityHeaders, contentSecurityPolicy, NEXT_PAGE_SOURCE, STATIC_PAGE_SOURCES } from './security-headers';

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(name + ' '))?.split(' ').slice(1) ?? [];
const env = { supabaseUrl: 'https://api.muop.win' };

describe('static-page CSP (organizer + guest room: renders guest text)', () => {
  const csp = contentSecurityPolicy('static', env);

  it('has no unsafe-inline / unsafe-eval for scripts', () => {
    const scripts = directive(csp, 'script-src');
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain('*');
  });

  it('allows exactly the pinned CDNs the pages load, plus blob: for the mic worklet', () => {
    expect(directive(csp, 'script-src').sort()).toEqual(["'self'", 'blob:', 'https://cdn.jsdelivr.net', 'https://unpkg.com'].sort());
  });

  it('allows same-origin fetches, Supabase (https + realtime wss), Gemini Live and ElevenLabs', () => {
    const connect = directive(csp, 'connect-src');
    expect(connect).toEqual(expect.arrayContaining(["'self'", 'https://api.muop.win', 'wss://api.muop.win', 'wss://generativelanguage.googleapis.com', 'wss://api.elevenlabs.io']));
  });

  it('draws QR codes in the browser: no external QR image service is allowed', () => {
    expect(csp.toLowerCase()).not.toMatch(/qrserver|chart\.googleapis|quickchart|qr\./);
    expect(directive(csp, 'img-src')).toEqual(expect.arrayContaining(['data:', 'blob:']));
  });

  it('locks framing, plugins, base and form targets', () => {
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'form-action')).toEqual(["'self'"]);
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
  });

  it('allows map tiles and fonts', () => {
    expect(directive(csp, 'img-src')).toContain('https://*.tile.openstreetmap.org');
    expect(directive(csp, 'font-src')).toContain('https://fonts.gstatic.com');
    expect(directive(csp, 'style-src')).toContain('https://fonts.googleapis.com');
  });
});

describe('Next-page CSP', () => {
  it('needs inline scripts for Next bootstrap but no CDN origins, and no eval in production', () => {
    const scripts = directive(contentSecurityPolicy('next', env), 'script-src');
    expect(scripts).toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain('https://unpkg.com');
  });

  it('allows eval and websockets only in dev', () => {
    const dev = contentSecurityPolicy('next', { ...env, dev: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(contentSecurityPolicy('next', env), 'connect-src').join(' ')).not.toContain('localhost');
  });

  it('tolerates a missing or invalid Supabase URL', () => {
    expect(() => contentSecurityPolicy('next', {})).not.toThrow();
    expect(directive(contentSecurityPolicy('next', { supabaseUrl: 'not a url' }), 'connect-src')).toContain("'self'");
  });
});

describe('base headers', () => {
  const h = Object.fromEntries(baseSecurityHeaders.map((x) => [x.key, x.value]));

  it('sets the standard hardening headers', () => {
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d{7,}; includeSubDomains/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('allows the microphone (voice) and geolocation (room button) for our own origin only', () => {
    const p = h['Permissions-Policy'];
    expect(p).toContain('microphone=(self)');
    expect(p).toContain('geolocation=(self)');
    expect(p).toContain('camera=()');
    expect(p).not.toMatch(/=\*/);
  });
});

describe('header sources', () => {
  it('static and Next sources do not overlap, so no path gets two CSPs', () => {
    const re = new RegExp('^' + NEXT_PAGE_SOURCE + '$');
    for (const p of ['/organizer', '/organizer/index.html', '/room/room.js', '/m/abcdefabcdefabcdefabcdef']) {
      expect(re.test(p), p).toBe(false);
    }
    for (const p of ['/', '/login', '/traction', '/api/me/dashboard', '/auth/callback', '/privacy.html']) {
      expect(re.test(p), p).toBe(true);
    }
    expect(STATIC_PAGE_SOURCES).toContain('/m/:token');
  });
});
