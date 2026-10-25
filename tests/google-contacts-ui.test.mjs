import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/organizer/google-contacts.js', import.meta.url), 'utf8');
const row = (index, extra = {}) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, name: `Person ${index}`, email: `person${index}@example.test`, duplicate: false, ...extra });
const ready = (contacts = [row(1)], extra = {}) => ({ configured: true, ready: true, loaded: true, contacts, has_more: false, skipped: 0, truncated: false, ...extra });

function browser(initial, handler) {
  let generation = 0;
  const nodes = new Map(); const selections = new Map(); const categories = new Map();
  const node = () => ({ textContent: '', value: '', disabled: false, checked: false, dataset: {} });
  let html = '';
  const host = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; nodes.clear(); selections.clear(); categories.clear(); nodes.set('app', host);
      for (const match of value.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const item = node(); item.tagName = match[1]; item.disabled = /\bdisabled\b/.test(match[0]); nodes.set(match[2], item);
      }
      for (const match of value.matchAll(/<input[^>]*data-gc-select="([^"]+)"[^>]*>/g)) {
        const item = node(); item.dataset.gcSelect = match[1]; item.dataset.duplicate = /data-duplicate="true"/.test(match[0]) ? 'true' : 'false';
        item.checked = /\bchecked\b/.test(match[0]); selections.set(match[1], item);
      }
      for (const match of value.matchAll(/<select[^>]*data-gc-category="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const item = node(); item.dataset.gcCategory = match[1]; item.dataset.duplicate = /data-duplicate="true"/.test(match[0]) ? 'true' : 'false';
        item.value = match[2].match(/<option value="([^"]+)" selected/)?.[1] || 'personal'; categories.set(match[1], item);
      }
    },
  };
  nodes.set('app', host);
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-gc-select]') return [...selections.values()];
      if (selector === '[data-gc-category]') return [...categories.values()];
      return [...nodes.values()].filter((n) => n.tagName === 'button').concat([...selections.values()], [...categories.values()]);
    },
    querySelector(selector) { return categories.get(selector.match(/data-gc-category="([^"]+)"/)?.[1]) || null; },
  };
  const calls = [];
  const api = async (path, options) => { calls.push({ path, options }); return handler ? handler(path, options) : structuredClone(initial); };
  const context = vm.createContext({
    window: {}, document, URL, URLSearchParams, Map, Set,
    location: { pathname: '/organizer/', hash: '#/google-contacts', search: '', assign: vi.fn() }, history: { replaceState: vi.fn() },
    api, AuthError: class extends Error {}, CATEGORIES: ['personal', 'professional', 'community'], catLabel: (c) => c,
    el: (id) => nodes.get(id) || null,
    esc: (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    renderLoading: () => ++generation, stale: (nav) => nav !== generation,
    renderError: (error) => { host.innerHTML = `<p>${error.message}</p>`; },
  });
  vm.runInContext(source, context);
  return {
    context, nodes, selections, categories, host, calls,
    view: context.window.GoogleContacts.view,
    select(id) { const n = selections.get(id); n.checked = true; n.onchange(); },
    leave() { generation++; host.innerHTML = '<h1>Other page</h1>'; },
  };
}

describe('Google Contacts selection UI', () => {
  it.each(['#/google-contacts', '#/gmail', '#/calendar'])('preserves the %s callback route for a new account without an onboarding flag', async (hash) => {
    const appSource = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8').replace(/\nboot\(\);\s*$/, '');
    const context = vm.createContext({ window: {}, location: { hash }, localStorage: { getItem: () => null }, destination: null });
    vm.runInContext(appSource, context);
    vm.runInContext("renderLoading = () => 0; api = async () => ({ is_empty: true }); installFlash = () => {}; route = () => {}; go = (hash) => { destination = hash; };", context);
    await vm.runInContext('boot()', context);
    expect(context.destination).toBeNull();
  });
  it('shows setup-needed without making a connection or importing', async () => {
    const app = browser({ configured: false, ready: false }); await app.view();
    expect(app.host.innerHTML).toContain('administrator setup');
    expect(app.nodes.get('gc-connect').disabled).toBe(true);
    expect(app.calls.map((call) => call.path)).toEqual(['/api/me/integrations/google/contacts']);
  });
  it('renders an unchecked, escaped preview with existing people disabled', async () => {
    const app = browser(ready([row(1, { name: '<img src=x onerror=alert(1)>' }), row(2, { duplicate: true })])); await app.view();
    expect(app.host.innerHTML).toContain('&lt;img'); expect(app.host.innerHTML).not.toContain('<img');
    expect(app.selections.get(row(1).id).checked).toBe(false);
    expect(app.selections.get(row(2).id).disabled).toBe(true);
    expect(app.nodes.get('gc-save').disabled).toBe(true);
    expect(app.calls).toHaveLength(1);
  });
  it('enforces five selected contacts and sends only IDs and explicitly chosen categories', async () => {
    let imported;
    const state = ready(Array.from({ length: 6 }, (_, i) => row(i + 1)));
    const app = browser(state, async (path, options) => {
      if (path.endsWith('/import')) { imported = JSON.parse(options.body); return { added: 5, skipped: 0 }; }
      return structuredClone(state);
    });
    await app.view();
    app.categories.get(row(1).id).value = 'professional';
    for (let i = 1; i <= 6; i++) app.select(row(i).id);
    expect(app.nodes.get('gc-count').textContent).toBe('5 selected (up to 5 per import)');
    expect(app.selections.get(row(6).id).checked).toBe(false);
    await app.nodes.get('gc-save').onclick();
    expect(imported.selections).toHaveLength(5);
    expect(imported.selections[0]).toEqual({ id: row(1).id, category: 'professional' });
    expect(JSON.stringify(imported)).not.toMatch(/Person|example.test/);
  });
  it('retains checked rows/categories through loading more pages without selecting new rows', async () => {
    const initial = ready([row(1)], { has_more: true });
    const app = browser(initial, async (path) => path.endsWith('/preview') ? ready([row(1), row(2)]) : structuredClone(initial));
    await app.view(); app.select(row(1).id);
    app.categories.get(row(1).id).value = 'community'; app.categories.get(row(1).id).onchange();
    await app.nodes.get('gc-more').onclick();
    expect(app.selections.get(row(1).id).checked).toBe(true); expect(app.categories.get(row(1).id).value).toBe('community');
    expect(app.selections.get(row(2).id).checked).toBe(false);
  });
  it('suppresses repeated clicks and allows safe retry with the same selection after an error', async () => {
    let respond; let count = 0;
    const app = browser(ready(), async (path) => {
      if (!path.endsWith('/import')) return ready();
      count++;
      if (count === 1) return new Promise((_resolve, reject) => { respond = reject; });
      return { added: 1, skipped: 0 };
    });
    await app.view(); app.select(row(1).id);
    const button = app.nodes.get('gc-save'); const first = button.onclick();
    await button.onclick(); expect(count).toBe(1); expect(button.disabled).toBe(true);
    respond(new Error('Temporary problem')); await first;
    expect(button.disabled).toBe(false); expect(app.nodes.get('gc-error').textContent).toBe('Temporary problem');
    expect(app.selections.get(row(1).id).checked).toBe(true);
    await button.onclick(); expect(count).toBe(2); expect(app.nodes.get('gc-message').textContent || app.host.innerHTML).toContain('1 imported');
  });
  it('cancellation clears preview and selection without deleting imported contacts', async () => {
    const app = browser(ready(), async (path) => path.endsWith('/cancel') ? { disconnected: true } : ready());
    await app.view(); app.select(row(1).id); await app.nodes.get('gc-cancel').onclick();
    expect(app.host.innerHTML).toContain('Temporary access and the preview were cleared');
    expect(app.host.innerHTML).not.toContain('person1@example.test');
    expect(app.calls.filter((call) => call.path.endsWith('/cancel'))).toHaveLength(1);
    expect(app.calls.some((call) => call.options?.method === 'DELETE')).toBe(false);
  });
  it('late preview response cannot overwrite a newer navigation', async () => {
    let respond;
    const app = browser(ready(), async (path) => path.endsWith('/preview') ? new Promise((resolve) => { respond = resolve; }) : ready([row(1)], { has_more: true }));
    await app.view(); const pending = app.nodes.get('gc-more').onclick(); app.leave(); respond(ready([row(1), row(2)])); await pending;
    expect(app.host.innerHTML).toBe('<h1>Other page</h1>');
  });
  it('keeps the flow recoverable after denial and removes callback status from history', async () => {
    const app = browser({ configured: true, ready: false });
    app.context.location.search = '?google_import=denied'; await app.view();
    expect(app.host.innerHTML).toContain('permission was declined');
    expect(app.context.history.replaceState).toHaveBeenCalledWith(null, '', '/organizer/#/google-contacts');
    expect(app.nodes.get('gc-connect').disabled).toBe(false);
  });
  it('never navigates to an arbitrary authorization URL returned by a bad response', async () => {
    const app = browser({}, async (path) => path.endsWith('/start') ? { authorization_url: 'https://evil.test/steal' } : { configured: true, ready: false });
    await app.view(); await app.nodes.get('gc-connect').onclick();
    expect(app.context.location.assign).not.toHaveBeenCalled();
    expect(app.nodes.get('gc-error').textContent).toContain('unavailable');
  });
});
