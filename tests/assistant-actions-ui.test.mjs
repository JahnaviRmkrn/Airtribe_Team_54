import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/organizer/assistant.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const response = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
function harness({ fetch: fetcher, controls = [], inputs = [], people = [], meetups = [] } = {}) {
  const events = new Map();
  const links = [];
  const location = { hash: '#/contacts', origin: 'https://example.test', href: '' };
  const window = { confirm: vi.fn(() => true), dispatchEvent: vi.fn(), addEventListener: (type, fn) => {
    if (!events.has(type)) events.set(type, []); events.get(type).push(fn);
  }, speechSynthesis: { cancel: vi.fn(), getVoices: () => [], speak: vi.fn() } };
  const document = { getElementById: () => null, querySelectorAll: (s) => s.includes('#app button') ? controls : s.includes('#app input') ? inputs : [],
    createElement: () => { const link = { style: {}, click: vi.fn(), remove: vi.fn() }; links.push(link); return link; },
    body: { appendChild: vi.fn() } };
  const fetch = vi.fn(async (url, options) => {
    if (fetcher) { const r = fetcher(url, options); if (r !== undefined) return r; }
    if (url === '/api/me/contacts' && !options.method) return response({ contacts: people });
    if (url === '/api/me/meetups' && !options.method) return response({ meetups });
    throw new Error('Unexpected request: ' + url);
  });
  const clipboard = { writeText: vi.fn(async () => {}) };
  vm.runInNewContext(source, { window, document, location, fetch, navigator: { clipboard }, Event, HashChangeEvent: class {}, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, AbortController });
  const leave = () => { location.hash = '#/dashboard'; for (const fn of events.get('hashchange') || []) fn(); };
  return { assistant: window.Assistant, window, location, fetch, links, clipboard, leave };
}
const control = (text, extra = {}) => ({ innerText: text, offsetWidth: 10, click: vi.fn(), id: '', dataset: {}, getAttribute: () => null, ...extra });
const alice = { id: 'alice-id', name: 'Alice Jones', category: 'personal', email: 'alice@example.test' };
const meetup = { title: 'Brunch', room_token: 'owned-token' };

describe('assistant action boundaries in the shipped browser asset', () => {
  it('requires both explicit confirmation and the real dialog before deleting', async () => {
    const h = harness({ people: [alice], fetch: (url, opts) => opts.method === 'DELETE' ? response(null, 204) : undefined });
    expect((await h.assistant.call('delete_contact', { name: 'Alice', confirmed: false })).error).toMatch(/confirm/);
    expect(h.fetch).not.toHaveBeenCalled();
    h.window.confirm.mockReturnValue(false);
    expect((await h.assistant.call('delete_contact', { name: 'Alice', confirmed: true })).error).toMatch(/cancelled/);
    expect(h.fetch.mock.calls.filter(([, o]) => o.method === 'DELETE')).toHaveLength(0);
  });
  it.each(['Confirm and create event', 'Confirm and send email', 'Confirm', 'Close meetup'])('cannot use generic click to activate the human confirmation: %s', async (label) => {
    const button = control(label);
    const h = harness({ controls: [button] });
    const result = await h.assistant.call('click', { label });
    expect(result.error).toMatch(/confirm|yourself|manually/i);
    expect(button.click).not.toHaveBeenCalled();
  });
  it.each(['ga-connect', 'ga-confirm', 'gc-connect', 'gc-save'])('blocks protected control %s even if its displayed label changes', async (id) => {
    const button = control('Continue', { id }); const h = harness({ controls: [button] });
    expect((await h.assistant.call('click', { label: 'Continue' })).error).toMatch(/yourself|manual|confirm/i);
    expect(button.click).not.toHaveBeenCalled();
  });
  it('rejects ambiguous exact and partial control matches instead of choosing the first', async () => {
    const first = control('Save', { id: 'e-save' }), second = control('Save', { id: 'me-goals-save' });
    const h = harness({ controls: [first, second] });
    expect((await h.assistant.call('click', { label: 'Save' })).error).toMatch(/match|which/i);
    expect((await h.assistant.call('click', { label: 'Sa' })).error).toMatch(/match|which/i);
    expect(first.click).not.toHaveBeenCalled(); expect(second.click).not.toHaveBeenCalled();
  });
  it('allows known local editing/navigation controls but not an unreviewed arbitrary button', async () => {
    const local = control('Save', { id: 'e-save' }), unknown = control('Do something');
    const h = harness({ controls: [local, unknown] });
    expect((await h.assistant.call('click', { label: 'Save' })).ok).toBe(true); expect(local.click).toHaveBeenCalledTimes(1);
    expect((await h.assistant.call('click', { label: 'Do something' })).error).toMatch(/manual|yourself/i); expect(unknown.click).not.toHaveBeenCalled();
  });
  it.each(['checkbox', 'radio', 'password', 'file', 'hidden', 'submit'])('does not use fill_field to change a %s or confirmation input', async (type) => {
    const input = control('', { type, placeholder: 'Confirmation', value: '', dispatchEvent: vi.fn() });
    const h = harness({ inputs: [input] });
    expect((await h.assistant.call('fill_field', { field: 'Confirmation', value: 'yes' })).error).toBeTruthy();
    expect(input.value).toBe(''); expect(input.dispatchEvent).not.toHaveBeenCalled();
  });
  it('does not silently save an email address merely to open a mail-app draft', async () => {
    const h = harness({ people: [{ ...alice, email: null }] });
    await h.assistant.call('email_contact', { name: 'Alice', email: 'new@example.test', subject: 'Hello', body: 'Coffee?' });
    expect(h.fetch.mock.calls.every(([, opts]) => !opts.method)).toBe(true);
    expect(h.links[0].href).toContain('mailto:new@example.test');
  });
  it('does not report clicking a disabled control as success', async () => {
    const button = control('Save', { disabled: true });
    const h = harness({ controls: [button] });
    expect((await h.assistant.call('click', { label: 'Save' })).error).toBeTruthy();
    expect(button.click).not.toHaveBeenCalled();
  });
  it('rejects empty target names instead of selecting the only owned contact', async () => {
    const h = harness({ people: [alice] });
    expect((await h.assistant.call('open_contact', { name: '' })).error).toBeTruthy();
    expect(h.location.hash).toBe('#/contacts');
  });
  it('does not guess between matching meetup titles', async () => {
    const h = harness({ meetups: [meetup, { title: 'Brunch with work', room_token: 'other-owned' }] });
    expect((await h.assistant.call('copy_meetup_link', { title: 'Brun' })).error).toMatch(/match|which/i);
    expect(h.clipboard.writeText).not.toHaveBeenCalled();
  });
  it('does not silently pick the first of two invite recipients with the same partial name', async () => {
    const h = harness({ people: [alice, { ...alice, id: 'other-id', name: 'Alice Smith' }], meetups: [meetup] });
    expect((await h.assistant.call('email_meetup_invite', { title: 'Brunch', to: ['Alice'] })).error).toMatch(/match|which/i);
    expect(h.links).toHaveLength(0);
  });
  it('does not mutate a contact when navigation occurs during name resolution', async () => {
    const pending = deferred();
    const h = harness({ fetch: (url, opts) => !opts.method ? pending.promise : response({ contact: alice }) });
    const call = h.assistant.call('update_contact', { name: 'Alice', notes: 'New note' });
    h.leave(); pending.resolve(response({ contacts: [alice] }));
    expect((await call).error).toMatch(/cancel|page|changed/i);
    expect(h.fetch.mock.calls.filter(([, o]) => o.method === 'PATCH')).toHaveLength(0);
  });
  it('keeps email drafting as a mail-app handoff, with no send endpoint', async () => {
    const h = harness({ people: [alice] });
    await h.assistant.call('email_contact', { name: 'Alice', subject: 'Hello', body: 'Coffee?' });
    expect(h.links[0].href).toContain('mailto:alice@example.test?subject=Hello&body=Coffee%3F');
    expect(h.fetch.mock.calls.every(([, o]) => !o.method)).toBe(true);
  });
  it('does not automatically repeat a mutation after its response is lost', async () => {
    let rounds = 0;
    const h = harness({ fetch: (url) => {
      if (url === '/api/assistant') return response(++rounds < 3 ? { tool_calls: [{ id: 'call-' + rounds, name: 'create_meetup', arguments: '{"title":"Brunch"}' }] } : { reply: 'Done' });
      if (url === '/api/me/meetups') throw new Error('Lost connection after request');
    } });
    const result = await h.assistant.ask('Create brunch', [], { speakReply: false });
    expect(h.fetch.mock.calls.filter(([u]) => u === '/api/me/meetups')).toHaveLength(1);
    expect(JSON.stringify(result)).toMatch(/unknown|uncertain|check/i);
  });
  it('cancels an older text tool lookup when a new request supersedes it', async () => {
    const pending = deferred(); let modelCalls = 0;
    const h = harness({ fetch: (url, opts) => {
      if (url === '/api/assistant') return response(++modelCalls === 1 ? { tool_calls: [{ id: 'a', name: 'update_contact', arguments: '{"name":"Alice","notes":"Old request"}' }] } : { reply: 'No changes requested.' });
      if (url === '/api/me/contacts') return pending.promise;
      if (opts.method === 'PATCH') return response({ contact: alice });
    } });
    const older = h.assistant.ask('Update Alice', [], { speakReply: false });
    for (let i = 0; i < 15; i++) await Promise.resolve();
    await h.assistant.ask('Actually, do nothing', [], { speakReply: false });
    pending.resolve(response({ contacts: [alice] })); await older;
    expect(h.fetch.mock.calls.filter(([, opts]) => opts.method === 'PATCH')).toHaveLength(0);
  });
  it('does not execute delayed model tools after navigation', async () => {
    const pending = deferred();
    const h = harness({ fetch: (url) => url === '/api/assistant' ? pending.promise : response({ meetup }) });
    const asked = h.assistant.ask('Create brunch', [], { speakReply: false });
    h.leave(); pending.resolve(response({ tool_calls: [{ id: 'a', name: 'create_meetup', arguments: '{"title":"Brunch"}' }] }));
    await asked;
    expect(h.fetch.mock.calls.filter(([u]) => u === '/api/me/meetups')).toHaveLength(0);
  });
});

describe('separate Sheets document boundary', () => {
  it('keeps the assistant in the organizer document, not the Sheets React page', () => {
    const organizer = readFileSync(new URL('../public/organizer/index.html', import.meta.url), 'utf8');
    const router = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8');
    const sheets = ['../app/layout.tsx', '../app/integrations/google-sheets/page.tsx', '../app/integrations/google-sheets/SheetsClient.tsx']
      .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
    expect(organizer).toContain('<script src="/organizer/assistant.js">');
    expect(router).toContain('<a href="/integrations/google-sheets">');
    expect(sheets).not.toMatch(/organizer\/(?:assistant|live)\.js|window\.Assistant|<iframe/);
  });
});
