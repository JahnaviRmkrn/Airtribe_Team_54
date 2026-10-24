import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

function boot(hostname = 'demo.vercel.app') {
  const window = {} as { vaq?: [string, unknown][]; team54Track?: (name: string) => void };
  const scripts: { src?: string }[] = [];
  vm.runInNewContext(readFileSync('public/product-analytics.js', 'utf8'), {
    window, URL, location: { hostname },
    document: { createElement: () => ({}), head: { appendChild: (s: { src?: string }) => scripts.push(s) } },
  });
  return { window, scripts };
}

describe('static-page analytics privacy', () => {
  it('redacts room capabilities and query/fragment secrets', () => {
    const { window, scripts } = boot();
    const filter = window.vaq![0][1] as (e: { url: string; type: string }) => { url: string } | null;
    expect(filter({ type: 'event', url: 'https://demo.vercel.app/m/secret-token?code=secret#/contacts/123' })?.url).toBe('https://demo.vercel.app/m/room');
    expect(filter({ type: 'pageview', url: 'https://demo.vercel.app/organizer/?key=secret#/contacts/123' })?.url).toBe('https://demo.vercel.app/organizer/');
    expect(filter({ type: 'pageview', url: 'https://demo.vercel.app/auth/callback?code=secret' })).toBeNull();
    expect(scripts[0].src).toBe('/_vercel/insights/script.js');
  });
  it('only queues allowed event names without user data', () => {
    const { window } = boot();
    window.team54Track!('guest_joined');
    window.team54Track!('meetup_created');
    window.team54Track!('arbitrary private text');
    expect(window.vaq!.slice(1)).toEqual([['event', { name: 'guest_joined' }], ['event', { name: 'meetup_created' }]]);
  });
  it('does not emit local-development events', () => {
    expect(boot('localhost').scripts).toEqual([]);
    expect(boot('127.0.0.1').window.vaq).toBeUndefined();
  });
});
