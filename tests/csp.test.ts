import { describe, expect, it } from 'vitest';
import { APP_CSP, NEXT_CSP } from '../lib/csp';

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(name + ' ')) ?? '';

describe('content security policy', () => {
  it('static apps allow no inline scripts, eval or blob: scripts', () => {
    const scripts = directive(APP_CSP, 'script-src');
    expect(scripts).not.toMatch(/unsafe-inline|unsafe-eval|blob:|data:|\*/);
    expect(scripts).toContain("'self'");
  });

  it('third-party scripts are pinned to exact versions', () => {
    for (const src of directive(APP_CSP, 'script-src').split(' ').slice(2).filter((s) => !s.includes('cloudflareinsights'))) expect(src).toMatch(/@\d+\.\d+\.\d+\//);
  });

  it('both policies forbid framing, plugins and base-tag hijacks', () => {
    for (const csp of [APP_CSP, NEXT_CSP]) {
      expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
      expect(directive(csp, 'object-src')).toBe("object-src 'none'");
      expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    }
  });

  it('only the pinned Leaflet path is allowed from unpkg', () => {
    for (const name of ['img-src', 'style-src']) expect(directive(APP_CSP, name)).not.toMatch(/https:\/\/unpkg\.com(\s|$)/);
  });

  it('allows only the Cloudflare analytics beacon path, not the whole host', () => {
    for (const csp of [APP_CSP, NEXT_CSP]) {
      expect(directive(csp, 'script-src')).toContain('https://static.cloudflareinsights.com/beacon.min.js/');
      expect(directive(csp, 'script-src')).not.toMatch(/static\.cloudflareinsights\.com(\s|;|$)/);
    }
  });
});
