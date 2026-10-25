import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static guards over the source tree: cheap to run, and they fail loudly when a
// new route or client file forgets a security rule.
const root = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === '.next') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const rel = (p: string) => relative(root, p);
const read = (p: string) => readFileSync(p, 'utf8');

const routes = walk(join(root, 'app/api')).filter((p) => p.endsWith('route.ts'));

describe('API routes', () => {
  it('every /api/me/* route requires a signed-in user', () => {
    const me = routes.filter((p) => rel(p).startsWith('app/api/me/'));
    expect(me.length).toBeGreaterThan(5);
    for (const p of me) expect(read(p), rel(p)).toMatch(/requireUser\(/);
  });

  it('every non-room route requires a signed-in user', () => {
    for (const p of routes.filter((p) => !rel(p).startsWith('app/api/rooms/'))) {
      expect(read(p), rel(p)).toMatch(/requireUser\(/);
    }
  });

  it('every LLM / voice route is rate limited per user and per IP', () => {
    const spend = ['extract', 'assistant', 'voice/live-token', 'voice/signed-url', 'voice/transcribe', 'me/contacts/[id]/draft'];
    for (const name of spend) {
      const p = routes.find((r) => rel(r).startsWith('app/api/' + name));
      expect(p, name).toBeTruthy();
      expect(read(p!), name).toMatch(/limitLlm\(/);
    }
  });

  it('every public room route is rate limited', () => {
    for (const p of routes.filter((p) => rel(p).startsWith('app/api/rooms/'))) {
      expect(read(p), rel(p)).toMatch(/limitRoom\(|rateLimit\(/);
    }
  });

  it('no route reads the request body without a size cap', () => {
    for (const p of routes) {
      expect(read(p), rel(p)).not.toMatch(/req\.(json|text|arrayBuffer|blob)\(/);
    }
  });
});

describe('secret boundaries', () => {
  const files = ['app', 'lib'].flatMap((d) => walk(join(root, d))).filter((p) => /\.(ts|tsx)$/.test(p) && !p.endsWith('.test.ts'));

  it('only server-only modules and route handlers import the service-role client', () => {
    for (const p of files) {
      const src = read(p);
      if (!/supabase\/admin['"]/.test(src) || rel(p) === 'lib/supabase/admin.ts') continue;
      const ok = /app\/api\//.test(rel(p)) || /app\/traction\//.test(rel(p)) || src.includes("import 'server-only'");
      expect(ok, `${rel(p)} imports the admin client`).toBe(true);
    }
  });

  it('the admin client and secret-holding libs are marked server-only', () => {
    for (const f of ['lib/supabase/admin.ts', 'lib/pinelabs.ts', 'lib/live-token.ts', 'lib/room.ts', 'lib/ratelimit.ts', 'lib/transcribe.ts']) {
      expect(read(join(root, f)), f).toContain("import 'server-only'");
    }
  });

  it('client code never mentions a server-only secret', () => {
    // Reads of server env vars, the admin client, or key-shaped literals (service-role JWT, sk- keys).
    const secrets =
      /process\.env\.(?!NEXT_PUBLIC_|NODE_ENV)|supabase\/admin|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|\bsk-[A-Za-z0-9]{20,}|\bao_sk_/;
    const client = [
      ...files.filter((p) => /^['"]use client['"]/m.test(read(p))),
      ...walk(join(root, 'public')).filter((p) => p.endsWith('.js') || p.endsWith('.html')),
    ];
    expect(client.length).toBeGreaterThan(5);
    for (const p of client) expect(read(p), rel(p)).not.toMatch(secrets);
  });

  it('only NEXT_PUBLIC_ env vars that are meant to be public exist', () => {
    const allowed = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']);
    for (const p of files) {
      for (const m of read(p).matchAll(/NEXT_PUBLIC_[A-Z_]+/g)) expect(allowed.has(m[0]), `${rel(p)}: ${m[0]}`).toBe(true);
    }
  });
});

describe('static pages', () => {
  it('have no inline scripts or inline event handlers (the strict CSP depends on it)', () => {
    for (const p of walk(join(root, 'public')).filter((p) => p.endsWith('.html'))) {
      const src = read(p);
      expect(src, rel(p)).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(src, rel(p)).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });
});
