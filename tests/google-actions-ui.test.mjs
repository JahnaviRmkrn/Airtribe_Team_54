import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const humanClick = { isTrusted: true }; // Simulated browser-generated pointer or keyboard activation.
const source = readFileSync(new URL('../public/organizer/google-actions.js', import.meta.url), 'utf8');
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const action = (state = 'preview') => ({ id: '44444444-4444-4444-8444-444444444444', previewHash: 'a'.repeat(64), createdAt: '2026-10-25T04:00:00.000Z', state, preview: { kind: 'gmail', from: 'sender@example.test', to: ['person@example.test'], subject: 'Hello', body: 'Explicit text' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// DOM-shaped fixture, not a browser: exercise the shipped handlers without
// actual HTTP, Google accounts, external navigation or application boot.
function harness(api, purpose = 'gmail') {
  let current = true; const nodes = new Map(), focus = [];
  const document = { body: {}, getElementById: (id) => nodes.get(id) || null };
  document.activeElement = document.body;
  const make = () => ({ value: '', textContent: '', disabled: false, querySelectorAll: () => [...nodes.values()].filter((n) => n.control) });
  const app = make(); let html = '';
  app.contains = (node) => [...nodes.values()].includes(node);
  Object.defineProperty(app, 'innerHTML', { get: () => html, set(value) {
    if (app.contains(document.activeElement)) document.activeElement = document.body;
    html = value; nodes.clear(); nodes.set('app', app);
    for (const match of value.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node = make(); node.disabled = /\bdisabled(?:[=\s]|$)/.test(match[2]); node.control = ['input', 'select', 'textarea', 'button'].includes(match[1]);
      node.value = match[2].match(/\bvalue="([^"]*)"/)?.[1] || '';
      if (match[1] === 'textarea') node.value = value.slice(match.index + match[0].length).split('</textarea>')[0];
      node.focus = () => { document.activeElement = node; focus.push(match[3]); };
      nodes.set(match[3], node);
    }
  } });
  nodes.set('app', app);
  const location = { assign: vi.fn() };
  const window = {};
  vm.runInNewContext(source, { window, document, location, URL, Intl });
  const render = () => window.GoogleActions.render(purpose, { api, esc: escape, isCurrent: () => current });
  return { render, app, document, focus, node: (id) => nodes.get(id), leave: () => { current = false; }, location };
}
async function composing(api) {
  const h = harness(api); await h.render(); await h.node('ga-compose').onclick();
  h.node('ga-from').value = 'sender@example.test'; h.node('ga-to').value = 'person@example.test'; h.node('ga-subject').value = 'Hello'; h.node('ga-body').value = 'Explicit text';
  return h;
}
const readyApi = (post) => vi.fn(async (_url, options) => options ? post(JSON.parse(options.body)) : ({ enabled: true, connected: true, actions: [] }));
const submit = (h) => h.node('ga-form').onsubmit({ preventDefault() {} });

describe('shipped explicit Google action UI', () => {
  it('does not let programmatic click bypass the Calendar confirmation', async () => {
    const saved = { ...action(), preview: { kind: 'calendar', title: 'Meetup', localStart: '2026-11-01T10:00', endLocal: '2026-11-01T11:00', timeZone: 'UTC', durationMinutes: 60, start: '2026-11-01T10:00:00Z', end: '2026-11-01T11:00:00Z', attendees: [] } };
    const api = vi.fn(async (_url, options) => options ? { action: saved } : { enabled: true, connected: true, actions: [saved] });
    const h = harness(api, 'calendar'); await h.render(); await h.node('ga-history-0').onclick();
    expect(h.app.innerHTML).toContain('Create a Google Calendar event: Review saved preview</h1>');
    expect(h.document.activeElement).toBe(h.node('ga-step-heading'));
    await h.node('ga-confirm').onclick({ isTrusted: false });
    expect(api.mock.calls.filter(([, o]) => o)).toHaveLength(0);
    expect(h.node('ga-error').textContent).toMatch(/yourself|manual/i);
    await h.node('ga-confirm').onclick(humanClick);
    expect(api.mock.calls.filter(([, o]) => o)).toHaveLength(1);
  });
  it('requires a fresh human activation to start Google consent', async () => {
    const api = vi.fn(async () => ({ enabled: true, connected: false, actions: [] }));
    const h = harness(api); await h.render(); await h.node('ga-connect').onclick({ isTrusted: false });
    expect(api).toHaveBeenCalledTimes(1); expect(h.location.assign).not.toHaveBeenCalled();
  });
  it('shows disabled setup without connect/compose controls', async () => {
    const api = vi.fn(async () => ({ enabled: false, connected: false, actions: [], message: 'Setup pending' }));
    const h = harness(api); await h.render();
    expect(h.app.innerHTML).toContain('Setup pending'); expect(h.node('ga-connect')).toBeUndefined(); expect(h.node('ga-compose')).toBeUndefined(); expect(api).toHaveBeenCalledTimes(1);
  });
  it('preview and cancel do not confirm or call any hidden communication', async () => {
    const api = readyApi((body) => ({ action: action(body.operation === 'cancel' ? 'cancelled' : 'preview') }));
    const h = await composing(api); await submit(h);
    expect(h.node('ga-confirm')).toBeDefined(); await h.node('ga-cancel').onclick();
    expect(api.mock.calls.filter(([, o]) => o).map(([, o]) => JSON.parse(o.body).operation)).toEqual(['preview', 'cancel']);
    expect(h.app.innerHTML).toContain('Nothing was sent or created');
  });
  it('Back to edit cancels the immutable preview and demands a fresh review', async () => {
    const api = readyApi((body) => ({ action: action(body.operation === 'cancel' ? 'cancelled' : 'preview') }));
    const h = await composing(api); await submit(h); await h.node('ga-edit').onclick();
    expect(h.node('ga-form')).toBeDefined(); expect(h.node('ga-confirm')).toBeUndefined();
    h.node('ga-body').value = 'Changed'; await submit(h);
    const calls = api.mock.calls.filter(([, o]) => o).map(([, o]) => JSON.parse(o.body));
    expect(calls.map((c) => c.operation)).toEqual(['preview', 'cancel', 'preview']); expect(calls[2].draft.body).toBe('Changed');
  });
  it('guards synchronous repeated preview submissions', async () => {
    const wait = deferred(); const api = readyApi(() => wait.promise);
    const h = await composing(api); const first = submit(h); const second = submit(h);
    expect(api.mock.calls.filter(([, o]) => o)).toHaveLength(1); expect(h.node('ga-preview').disabled).toBe(true);
    wait.resolve({ action: action() }); await Promise.all([first, second]); expect(h.node('ga-confirm')).toBeDefined();
  });
  it('requires sender acknowledgment before enabling or invoking Gmail confirmation', async () => {
    const api = readyApi(() => ({ action: action() })); const h = await composing(api); await submit(h);
    expect(h.node('ga-confirm').disabled).toBe(true); await h.node('ga-confirm').onclick(humanClick);
    expect(api.mock.calls.filter(([, o]) => o && JSON.parse(o.body).operation === 'confirm')).toHaveLength(0);
  });
  it('guards repeated confirms and sends only the saved ID/digest, never mutable draft data', async () => {
    const wait = deferred(); const api = readyApi((body) => body.operation === 'confirm' ? wait.promise : { action: action() });
    const h = await composing(api); await submit(h);
    h.node('ga-sender-check').checked = true; h.node('ga-sender-check').onchange();
    const button = h.node('ga-confirm'); const first = button.onclick(humanClick); const second = button.onclick(humanClick);
    expect(button.disabled).toBe(true); const confirmations = api.mock.calls.filter(([, o]) => o && JSON.parse(o.body).operation === 'confirm');
    expect(confirmations).toHaveLength(1); expect(JSON.parse(confirmations[0][1].body)).toEqual({ operation: 'confirm', id: action().id, previewHash: action().previewHash, confirmed: true, senderAcknowledged: true });
    wait.resolve({ action: action('completed') }); await Promise.all([first, second]); expect(h.app.innerHTML).toContain('Google accepted this email');
    expect(h.document.activeElement).toBe(h.node('ga-step-heading')); expect(h.focus).not.toContain('ga-confirm');
  });
  it('a lost confirm response removes resend controls and offers status checking only', async () => {
    const api = readyApi((body) => { if (body.operation === 'confirm') throw new Error('Lost response'); return { action: action() }; });
    const h = await composing(api); await submit(h); h.node('ga-sender-check').checked = true; h.node('ga-sender-check').onchange(); await h.node('ga-confirm').onclick(humanClick);
    expect(h.app.innerHTML).toContain('The outcome is unknown'); expect(h.node('ga-confirm')).toBeUndefined(); expect(h.node('ga-check')).toBeDefined(); expect(h.node('ga-reconcile')).toBeUndefined();
    expect(h.document.activeElement).toBe(h.node('ga-step-heading')); expect(h.focus).not.toContain('ga-confirm');
  });
  it('ignores delayed preview success after navigation and performs no confirm', async () => {
    const wait = deferred(); const api = readyApi(() => wait.promise);
    const h = await composing(api); const pending = submit(h); h.leave(); h.app.innerHTML = '<p>Another page</p>';
    wait.resolve({ action: action() }); await pending;
    expect(h.app.innerHTML).toBe('<p>Another page</p>'); expect(api.mock.calls.filter(([, o]) => o)).toHaveLength(1);
  });
  it('escapes all server preview fields before placing them in HTML', async () => {
    const bad = action(); bad.preview.subject = '<img src=x onerror=alert(1)>'; bad.preview.body = '<script>bad()</script>';
    const h = harness(vi.fn(async () => ({ enabled: true, connected: true, actions: [bad] })));
    await h.render(); await h.node('ga-history-0').onclick();
    expect(h.app.innerHTML).toContain('&lt;img'); expect(h.app.innerHTML).toContain('&lt;script&gt;'); expect(h.app.innerHTML).not.toContain('<script>');
  });
  it('only Calendar offers explicit read-only event reconciliation for unknown outcomes', async () => {
    const a = { ...action('uncertain'), preview: null };
    const api = vi.fn(async (_url, options) => options ? { action: a } : { enabled: true, connected: true, actions: [a] });
    const h = harness(api, 'calendar'); await h.render(); await h.node('ga-history-0').onclick(); await h.node('ga-reconcile').onclick();
    expect(api.mock.calls.filter(([, o]) => o).map(([, o]) => JSON.parse(o.body))).toEqual([{ operation: 'reconcile', id: a.id }]);
    expect(h.node('ga-confirm')).toBeUndefined();
  });
  it('rejects unexpected authorization destinations without navigating', async () => {
    const api = readyApi(() => ({ authorizationUrl: 'https://evil.test/steal' }));
    const h = harness(api); await h.render(); await h.node('ga-connect').onclick(humanClick);
    expect(h.location.assign).not.toHaveBeenCalled(); expect(h.node('ga-error').textContent).toContain('Unexpected Google connection destination');
  });
});


describe('Google action deliberate-step focus', () => {
  it('focuses a labelled non-tab-stop heading for compose, preview, edit and cancellation, never Confirm', async () => {
    const api = readyApi((body) => ({ action: action(body.operation === 'cancel' ? 'cancelled' : 'preview') }));
    const h = await composing(api);
    expect(h.app.innerHTML).toContain('<h1 id="ga-step-heading" tabindex="-1">Send with Gmail: Compose draft</h1>');
    expect(h.document.activeElement).toBe(h.node('ga-step-heading'));
    await submit(h); expect(h.app.innerHTML).toContain('Send with Gmail: Review saved preview</h1>');
    expect(h.document.activeElement).toBe(h.node('ga-step-heading')); expect(h.node('ga-confirm').disabled).toBe(true);
    await h.node('ga-edit').onclick(); expect(h.app.innerHTML).toContain('Send with Gmail: Compose draft</h1>');
    await submit(h); await h.node('ga-cancel').onclick();
    expect(h.app.innerHTML).toContain('Send with Gmail: Saved action status</h1>');
    expect(h.focus.every((id) => id === 'ga-step-heading')).toBe(true);
  });
  it('does not focus a loading frame or steal focus on initial deferred status', async () => {
    const wait = deferred(), h = harness(() => wait.promise);
    const pending = h.render(); expect(h.focus).toEqual([]);
    const elsewhere = {}; h.document.activeElement = elsewhere;
    wait.resolve({ enabled: true, connected: true, actions: [] }); await pending;
    expect(h.focus).toEqual([]); expect(h.document.activeElement).toBe(elsewhere);
  });
  it.each(['success', 'failure'])('does not steal focus after navigation while preview %s is pending', async (outcome) => {
    const wait = deferred(), h = await composing(readyApi(() => wait.promise));
    h.node('ga-preview').focus(); const before = [...h.focus], pending = submit(h);
    expect(h.focus).toEqual(before);
    h.leave(); h.app.innerHTML = '<p>Another page</p>';
    if (outcome === 'failure') wait.reject(new Error('Old error')); else wait.resolve({ action: action() });
    await pending; expect(h.focus).toEqual(before); expect(h.app.innerHTML).toBe('<p>Another page</p>');
  });
  it('focuses the preview heading only after the pending request completes with retained focus intent', async () => {
    const wait = deferred(), h = await composing(readyApi(() => wait.promise));
    h.node('ga-preview').focus(); const before = h.focus.length, pending = submit(h);
    expect(h.focus).toHaveLength(before); expect(h.node('ga-preview').disabled).toBe(true);
    // Native disabling may move focus to body. It is not a new focus destination.
    h.document.activeElement = h.document.body;
    wait.resolve({ action: action() }); await pending;
    expect(h.focus.slice(before)).toEqual(['ga-step-heading']); expect(h.document.activeElement).toBe(h.node('ga-step-heading'));
  });
  it('does not steal focus when the user leaves the pending form without navigating', async () => {
    const wait = deferred(), h = await composing(readyApi(() => wait.promise));
    h.node('ga-preview').focus(); const before = h.focus.length, pending = submit(h);
    const elsewhere = {}; h.document.activeElement = elsewhere;
    wait.resolve({ action: action() }); await pending;
    expect(h.focus).toHaveLength(before); expect(h.document.activeElement).toBe(elsewhere);
  });
  it('does not refocus a delayed saved-status result after focus moved to another live control', async () => {
    const wait = deferred();
    const api = vi.fn(async (url) => url.includes('?id=') ? wait.promise : { enabled: true, connected: true, actions: [action('completed')] });
    const h = harness(api); await h.render(); h.node('ga-history-0').focus(); await h.node('ga-history-0').onclick();
    h.node('ga-check').focus(); const pending = h.node('ga-check').onclick(); h.node('ga-home').focus(); const before = h.focus.length;
    wait.resolve({ action: action('completed') }); await pending;
    expect(h.focus).toHaveLength(before);
  });
  it('restores the connection heading after deliberate Back, never a consequential button', async () => {
    const h = await composing(readyApi(() => ({ action: action() })));
    h.node('ga-abandon').focus(); await h.node('ga-abandon').onclick();
    expect(h.app.innerHTML).toContain('Send with Gmail: Connection and saved actions</h1>');
    expect(h.document.activeElement).toBe(h.node('ga-step-heading'));
  });
  it('drops old frame focus after a newer render generation takes ownership', async () => {
    const wait = deferred(); let requests = 0;
    const h = harness(() => ++requests === 1 ? wait.promise : Promise.resolve({ enabled: false, message: 'New view', actions: [] }));
    const old = h.render(); await h.render(); const before = [...h.focus];
    wait.resolve({ enabled: true, connected: true, actions: [] }); await old;
    expect(h.app.innerHTML).toContain('New view'); expect(h.focus).toEqual(before);
  });
});
