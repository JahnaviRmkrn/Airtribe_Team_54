import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/organizer/assistant.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const response = (body) => ({ status: 200, ok: true, json: async () => body });
const alice = { id: 'alice-id', name: 'Alice Jones', category: 'personal' };
const tc = (name, args, id = name) => ({ id, name, arguments: JSON.stringify(args) });

function harness(fetcher, controls = []) {
  const listeners = new Map(), navigation = [];
  let hash = '#/dashboard', owner = 'owner-a';
  const window = {
    OrganizerAccount: { currentOwner: () => owner },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); return true; },
  };
  const location = {
    origin: 'https://example.test',
    get href() { return this.origin + '/' + hash; },
    get hash() { return hash; },
    set hash(next) {
      if (next === hash) return;
      const event = { type: 'hashchange', oldURL: this.origin + '/' + hash, newURL: this.origin + '/' + next };
      hash = next;
      // A browser updates location synchronously but delivers hashchange in a
      // later task, after subsequent tool calls may already have begun.
      navigation.push(new Promise((resolve) => setTimeout(() => { window.dispatchEvent(event); resolve(); }, 0)));
    },
  };
  const fetch = vi.fn(async (url, opts) => {
    const result = fetcher(url, opts);
    if (result !== undefined) return result;
    if (url === '/api/me/contacts' && !opts.method) return response({ contacts: [alice] });
    throw new Error('Unexpected synthetic request: ' + url);
  });
  const document = { getElementById: () => null, querySelectorAll: (selector) => selector.includes('#app button') ? controls : [] };
  vm.runInNewContext(source, { window, location, document, fetch, AbortController, Event, HashChangeEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } } });
  return { assistant: window.Assistant, window, location, fetch, setOwner: (value) => { owner = value; }, drainNavigation: () => Promise.all(navigation) };
}

const cases = [
  ['navigate', { page: 'meetups' }, 'create_meetup', { title: 'Brunch' }, '/api/me/meetups', 'POST', { meetup: { title: 'Brunch' } }],
  ['open_contact', { name: 'Alice' }, 'update_contact', { name: 'Alice', notes: 'New note' }, '/api/me/contacts/alice-id', 'PATCH', { contact: alice }],
];

describe('assistant-owned navigation with asynchronous browser hashchange', () => {
  it.each(cases)('does not cancel a sent mutation after %s in the same text round', async (navigationTool, navigationArgs, mutationTool, mutationArgs, path, method, receipt) => {
    const sent = deferred(), result = deferred(); let rounds = 0;
    const h = harness((url, opts) => {
      if (url === '/api/assistant') return response(++rounds === 1 ? { tool_calls: [tc(navigationTool, navigationArgs), tc(mutationTool, mutationArgs)] } : { reply: 'Saved.' });
      if (url === path && opts.method === method) { sent.resolve(); return result.promise; }
    });
    const pending = h.assistant.ask('Open the page and save my change', [], { speakReply: false });
    await sent.promise; await h.drainNavigation(); result.resolve(response(receipt));
    const actual = await pending;
    expect(actual.cancelled).not.toBe(true);
    expect(actual.actions.at(-1).result.ok).toBe(true);
    expect(h.fetch.mock.calls.filter(([url, opts]) => url === path && opts.method === method)).toHaveLength(1);
  });

  it.each(cases)('continues the next model round after its own %s navigation', async (navigationTool, navigationArgs, mutationTool, mutationArgs, path, method, receipt) => {
    const requested = deferred(), model = deferred(); let rounds = 0;
    const h = harness((url, opts) => {
      if (url === '/api/assistant') {
        if (++rounds === 1) return response({ tool_calls: [tc(navigationTool, navigationArgs)] });
        if (rounds === 2) { requested.resolve(); return model.promise; }
        return response({ reply: 'Saved.' });
      }
      if (url === path && opts.method === method) return response(receipt);
    });
    const pending = h.assistant.ask('Open the page and save my change', [], { speakReply: false });
    await requested.promise; await h.drainNavigation();
    model.resolve(response({ tool_calls: [tc(mutationTool, mutationArgs)] }));
    const actual = await pending;
    expect(actual.cancelled).not.toBe(true);
    expect(actual.actions.at(-1).result.ok).toBe(true);
    expect(h.fetch.mock.calls.filter(([url, opts]) => url === path && opts.method === method)).toHaveLength(1);
  });

  it('continues after a reviewed synchronous navigation click', async () => {
    const sent = deferred(), saved = deferred(); let rounds = 0;
    const button = { innerText: 'People', offsetWidth: 10, dataset: {}, getAttribute: (key) => key === 'href' ? '#/contacts' : null, click: () => { h.location.hash = '#/contacts'; } };
    const h = harness((url, opts) => {
      if (url === '/api/assistant') return response(++rounds === 1 ? { tool_calls: [tc('click', { label: 'People' }), tc('update_contact', { name: 'Alice', notes: 'New note' })] } : { reply: 'Saved.' });
      if (opts.method === 'PATCH') { sent.resolve(); return saved.promise; }
    }, [button]);
    const pending = h.assistant.ask('Open People and update Alice', [], { speakReply: false });
    await sent.promise; await h.drainNavigation(); saved.resolve(response({ contact: alice }));
    expect((await pending).actions.at(-1).result.ok).toBe(true);
  });

  it('consumes multiple queued own transitions exactly once', async () => {
    const requested = deferred(), model = deferred(); let rounds = 0;
    const h = harness((url) => {
      if (url === '/api/assistant') {
        if (++rounds === 1) return response({ tool_calls: [tc('navigate', { page: 'meetups' }), tc('navigate', { page: 'contacts' }, 'navigate-again')] });
        requested.resolve(); return model.promise;
      }
    });
    const pending = h.assistant.ask('Open both pages', [], { speakReply: false });
    await requested.promise; await h.drainNavigation(); model.resolve(response({ reply: 'Opened.' }));
    expect((await pending).cancelled).not.toBe(true);
  });

  it('still cancels an older lookup immediately when a different assistant tool navigates', async () => {
    const lookup = deferred(); const h = harness((url) => url === '/api/me/contacts' ? lookup.promise : undefined);
    const pending = h.assistant.call('update_contact', { name: 'Alice', notes: 'Stale note' });
    await h.assistant.call('navigate', { page: 'meetups' });
    lookup.resolve(response({ contacts: [alice] }));
    expect((await pending).cancelled).toBe(true);
    expect(h.fetch.mock.calls.some(([, opts]) => opts.method === 'PATCH')).toBe(false);
    await h.drainNavigation();
  });

  it('does not exempt manual navigation away and back while an own transition is queued', async () => {
    const requested = deferred(), model = deferred(); let rounds = 0;
    const h = harness((url) => {
      if (url === '/api/assistant') {
        if (++rounds === 1) return response({ tool_calls: [tc('navigate', { page: 'contacts' })] });
        requested.resolve(); return model.promise;
      }
    });
    const pending = h.assistant.ask('Open People and update Alice', [], { speakReply: false });
    await requested.promise;
    h.location.hash = '#/meetups'; h.location.hash = '#/contacts';
    await h.drainNavigation(); model.resolve(response({ tool_calls: [tc('update_contact', { name: 'Alice', notes: 'Stale note' })] }));
    expect((await pending).cancelled).toBe(true);
    expect(h.fetch.mock.calls.some(([url]) => url === '/api/me/contacts')).toBe(false);
  });

  it('does not exempt a synthetic refresh event without the matching navigation URLs', async () => {
    const model = deferred(); const h = harness((url) => url === '/api/assistant' ? model.promise : undefined);
    const pending = h.assistant.ask('Update Alice', [], { speakReply: false });
    h.window.dispatchEvent({ type: 'hashchange' });
    model.resolve(response({ tool_calls: [tc('update_contact', { name: 'Alice', notes: 'Stale note' })] }));
    expect((await pending).cancelled).toBe(true);
    expect(h.fetch.mock.calls.some(([url]) => url === '/api/me/contacts')).toBe(false);
  });

  it('does not invent a pending event for a same-hash navigation', async () => {
    const lookup = deferred(); const h = harness((url, opts) => {
      if (url === '/api/me/contacts') return lookup.promise;
      if (opts.method === 'PATCH') return response({ contact: alice });
    });
    const pending = h.assistant.call('update_contact', { name: 'Alice', notes: 'New note' });
    await h.assistant.call('navigate', { page: 'dashboard' });
    await h.drainNavigation(); lookup.resolve(response({ contacts: [alice] }));
    expect((await pending).ok).toBe(true);
  });

  it.each(['owner change', 'abort'])('preserves %s cancellation while an owned transition is queued', async (reason) => {
    const requested = deferred(), model = deferred(), controller = new AbortController(); let rounds = 0;
    const h = harness((url) => {
      if (url === '/api/assistant') {
        if (++rounds === 1) return response({ tool_calls: [tc('navigate', { page: 'contacts' })] });
        requested.resolve(); return model.promise;
      }
    });
    const pending = h.assistant.ask('Open People and update Alice', [], { speakReply: false, signal: controller.signal });
    await requested.promise;
    if (reason === 'owner change') h.setOwner('owner-b'); else controller.abort();
    await h.drainNavigation(); model.resolve(response({ tool_calls: [tc('update_contact', { name: 'Alice', notes: 'Stale note' })] }));
    expect((await pending).cancelled).toBe(true);
    expect(h.fetch.mock.calls.some(([url]) => url === '/api/me/contacts')).toBe(false);
  });

  it('still cancels a lookup on manual navigation before the queued hashchange fires', async () => {
    const lookup = deferred();
    const h = harness((url) => url === '/api/me/contacts' ? lookup.promise : undefined);
    const pending = h.assistant.call('update_contact', { name: 'Alice', notes: 'Stale note' });
    h.location.hash = '#/meetups'; lookup.resolve(response({ contacts: [alice] }));
    expect((await pending).cancelled).toBe(true);
    expect(h.fetch.mock.calls.some(([, opts]) => opts.method === 'PATCH')).toBe(false);
    await h.drainNavigation();
  });

  it('still cancels a model response after manual navigation away and back', async () => {
    const model = deferred();
    const h = harness((url) => url === '/api/assistant' ? model.promise : undefined);
    const pending = h.assistant.ask('Update Alice', [], { speakReply: false });
    h.location.hash = '#/meetups'; h.location.hash = '#/dashboard';
    await h.drainNavigation();
    model.resolve(response({ tool_calls: [tc('update_contact', { name: 'Alice', notes: 'Stale note' })] }));
    expect((await pending).cancelled).toBe(true);
    expect(h.fetch.mock.calls.some(([url]) => url === '/api/me/contacts')).toBe(false);
  });
});
