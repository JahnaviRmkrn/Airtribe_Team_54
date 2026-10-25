import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingHeader } from '../app/components/landing-header';

const { getUser, redirect } = vi.hoisted(() => ({
  getUser: vi.fn(),
  redirect: vi.fn(() => { throw new Error('redirected'); }),
}));
vi.mock('@/lib/supabase/server', () => ({ userClient: async () => ({ auth: { getUser } }) }));
vi.mock('next/navigation', () => ({ redirect }));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: null } });
});

describe('discoverable landing-page login', () => {
  it('keeps a clearly named login entry outside the collapsed mobile navigation', () => {
    const html = renderToStaticMarkup(<LandingHeader />);
    const navigation = html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0];
    const actions = html.slice(html.indexOf('</nav>') + '</nav>'.length);
    expect(navigation).toContain('id="landing-navigation"');
    expect(navigation).not.toContain('href="/login"');
    expect(actions).toMatch(/class="nav-cta" href="\/login">Log in /);
    expect(actions).toContain('aria-expanded="false"');
    expect(actions).toContain('aria-controls="landing-navigation"');
  });

  it('offers separate login and account-creation actions in the hero', async () => {
    const { default: Home } = await import('../app/page');
    const html = renderToStaticMarkup(await Home());
    expect(html).toMatch(/class="button-primary hero-cta" href="\/login">Log in to muop /);
    expect(html).toMatch(/class="text-link" href="\/login\?mode=signup">New here\? Create account /);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('retains the signed-in redirect rather than showing login to authenticated users', async () => {
    const { default: Home } = await import('../app/page');
    getUser.mockResolvedValue({ data: { user: { id: 'fixture-user' } } });
    await expect(Home()).rejects.toThrow('redirected');
    expect(redirect).toHaveBeenCalledWith('/organizer');
  });

  it('does not hide the mobile hero account choice or header actions', () => {
    const css = readFileSync(new URL('../app/home.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.home \.header-actions\s*\{[^}]*display:flex/);
    expect(css).not.toMatch(/\.home \.header-actions\s*\{[^}]*display:none/);
    expect(css).not.toMatch(/\.home \.hero-actions \.text-link\s*\{[^}]*display:none/);
    expect(css).toMatch(/\.home \.site-header \.nav-cta\s*\{[^}]*min-height:44px/);
  });
});
