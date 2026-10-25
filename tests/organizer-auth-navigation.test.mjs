import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Run the shipped script with synthetic responses only, including real view
// callbacks. No session, auth provider, or network service is involved.
const shipped = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8');
const source = shipped.replace(/\nboot\(\);\s*$/, '');
const owner = '11111111-1111-4111-8111-111111111111';
const meetup = {
  id: owner, title: 'Coffee', activity: 'coffee', area: '', starts_at: null,
  budget: null, notes: '', status: 'open', updated_at: '2026-10-25T05:00:00.123456+00:00',
};
const editHash = '#/meetups/' + meetup.id + '/edit';
const response = (body = {}, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const store = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};
function setup({ fetch = async () => response({ meetup }), hash = editHash, autoBoot = false } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      let value = '';
      nodes.set(id, {
        innerHTML: '', textContent: '', disabled: false, hidden: false,
        get value() { return value; }, set value(next) { value = String(next); },
        addEventListener() {}, setAttribute() {}, removeAttribute() {},
        querySelectorAll() { return []; }, classList: { add() {}, remove() {}, toggle() {} },
      });
    }
    return nodes.get(id);
  };
  const localStorage = store(), sessionStorage = store(), calls = [];
  const context = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [] },
    window: { localStorage, sessionStorage }, localStorage, sessionStorage, crypto: webcrypto,
    location: { origin: 'https://example.test', hash },
    fetch: (path, opts) => { calls.push({ path, opts }); return fetch(path, opts); },
  });
  const result = vm.runInContext(autoBoot ? shipped : source, context);
  const run = (code) => vm.runInContext(code, context);
  if (!autoBoot) run(`contactCreateOwner = '${owner}'; contactCreateRetryEnabled = true;`);
  return { context, calls, node, run, result, AuthError: run('AuthError') };
}

describe('organizer authentication navigation ownership', () => {
  it.each(['GET', 'PATCH'])('does not let an abandoned meetup editor %s redirect the Contacts view', async (method) => {
    const pending = deferred();
    const app = setup({ fetch: (path, opts) => {
      if (path === '/api/me/contacts') return response({ contacts: [] });
      if (method === 'GET' || opts.method === 'PATCH') return pending.promise;
      return response({ meetup });
    } });
    app.context.id = meetup.id;
    let oldRequest;
    if (method === 'GET') oldRequest = app.run('meetupEditView(id)');
    else {
      await app.run('meetupEditView(id)');
      app.node('me-title').value = 'Changed title';
      oldRequest = app.node('me-form').onsubmit({ preventDefault() {} });
      await app.node('me-form').onsubmit({ preventDefault() {} });
    }
    app.context.location.hash = '#/contacts';
    await app.run('contactsView()');
    const contactsPage = app.node('app').innerHTML;
    expect(contactsPage).toContain('<h1>Contacts</h1>');
    pending.resolve(response({}, 401));
    await oldRequest;
    expect(app.context.location.href).toBeUndefined();
    expect(app.context.location.hash).toBe('#/contacts');
    expect(app.node('app').innerHTML).toBe(contactsPage);
    expect(app.run('meetupNotice')).toBe('');
    expect(app.calls.filter(({ opts }) => opts.method === 'PATCH')).toHaveLength(method === 'PATCH' ? 1 : 0);
  });

  it.each(['GET', 'PATCH'].flatMap((method) => ['hash only', 'same hash, new generation', 'away and back'].map((navigation) => [method, navigation])))('throws AuthError without redirecting stale %s after %s', async (method, navigation) => {
    const pending = deferred();
    const app = setup({ fetch: () => pending.promise });
    app.context.options = { method };
    const request = app.run("api('/api/me/meetups/' + contactCreateOwner, options)");
    const rejected = expect(request).rejects.toBeInstanceOf(app.AuthError);
    if (navigation === 'hash only') app.context.location.hash = '#/contacts';
    else if (navigation === 'same hash, new generation') app.run('renderLoading()');
    else {
      app.context.location.hash = '#/contacts'; app.run('renderLoading()');
      app.context.location.hash = editHash; app.run('renderLoading()');
    }
    pending.resolve(response({}, 401));
    await rejected;
    expect(app.context.location.href).toBeUndefined();
    expect(app.calls).toHaveLength(1);
  });

  it.each(['GET', 'PATCH', 'POST'])('still redirects a current %s 401 and throws AuthError', async (method) => {
    const app = setup({ fetch: async () => response({}, 401) });
    app.context.options = { method };
    await expect(app.run("api('/api/me/meetups', options)")).rejects.toBeInstanceOf(app.AuthError);
    expect(app.context.location.href).toBe('/login?next=' + encodeURIComponent('/organizer/' + editHash));
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0].opts.credentials).toBe('include');
  });

  it('still redirects when a new view independently receives a 401 after an old request was ignored', async () => {
    const oldResponse = deferred(), newResponse = deferred();
    const app = setup({ fetch: (path) => path === '/api/me/contacts' ? newResponse.promise : oldResponse.promise });
    const oldRequest = app.run("api('/api/me/meetups')");
    const oldRejected = expect(oldRequest).rejects.toBeInstanceOf(app.AuthError);
    app.context.location.hash = '#/contacts'; app.run('renderLoading()');
    const newRequest = app.run("api('/api/me/contacts')");
    const newRejected = expect(newRequest).rejects.toBeInstanceOf(app.AuthError);
    oldResponse.resolve(response({}, 401)); await oldRejected;
    expect(app.context.location.href).toBeUndefined();
    newResponse.resolve(response({}, 401)); await newRejected;
    expect(app.context.location.href).toBe('/login?next=' + encodeURIComponent('/organizer/#/contacts'));
    expect(app.calls).toHaveLength(2);
  });

  it.each(['', '#/contacts', '#//evil.test/', '#/meetups/a/edit?next=https://evil.test/&label=A%20B'])('keeps the login and return path same-origin for hash %s', async (hash) => {
    const app = setup({ hash, fetch: async () => response({ next: 'https://evil.test/' }, 401) });
    await expect(app.run("api('/api/me')")).rejects.toBeInstanceOf(app.AuthError);
    const login = new URL(app.context.location.href, app.context.location.origin);
    const next = login.searchParams.get('next');
    expect(login.origin).toBe('https://example.test');
    expect(login.pathname).toBe('/login');
    expect(next).toBe('/organizer/' + hash);
    const target = new URL(next, login);
    expect(target.origin).toBe('https://example.test');
    expect(target.pathname).toBe('/organizer/');
    expect([...login.searchParams.keys()]).toEqual(['next']);
  });

  it.each([400, 409, 410])('preserves non-auth error codes and status %i', async (status) => {
    const app = setup({ fetch: async () => response({ error: 'Keep this error', code: 'contact_input_rejected' }, status) });
    await expect(app.run("api('/api/me/contacts', { method: 'POST' })")).rejects.toMatchObject({
      message: 'Keep this error', code: 'contact_input_rejected', status,
    });
    expect(app.context.location.href).toBeUndefined();
  });

  it('preserves an interrupted contact write and its original retry key across a stale 401', async () => {
    const pending = deferred(); let attempt = 0;
    const app = setup({ hash: '#/contacts', fetch: async () => {
      attempt++;
      if (attempt === 1) throw new Error('Response lost after commit');
      if (attempt === 2) return pending.promise;
      return response({ contacts: [{ id: owner, name: 'Alice' }], created_ids: [owner] }, 201);
    } });
    app.context.body = { name: 'Alice', category: 'personal', interests: [], notes: '' };
    app.context.action = {};
    const create = () => app.run("createContactsOnce('add', body, action)");
    await expect(create()).rejects.toThrow('Response lost after commit');
    const originalKey = app.calls[0].opts.headers['Idempotency-Key'];
    const retry = create();
    const rejected = expect(retry).rejects.toBeInstanceOf(app.AuthError);
    app.context.location.hash = '#/meetups'; app.run('renderLoading()');
    pending.resolve(response({}, 401)); await rejected;
    expect(app.context.location.href).toBeUndefined();
    expect(app.run("pendingContactIntent('add').key")).toBe(originalKey);
    expect(app.run("pendingContactIntent('add').attempts")).toBe(2);
    expect(app.calls).toHaveLength(2); // No automatic retry or new write.
    app.context.location.hash = '#/contacts'; app.run('renderLoading()');
    await create();
    expect(app.calls.map(({ opts }) => opts.headers['Idempotency-Key'])).toEqual([originalKey, originalKey, originalKey]);
    expect(app.calls.map(({ opts }) => opts.body)).toEqual(Array(3).fill(JSON.stringify(app.context.body)));
  });

  it('keeps automatic boot authentication failure handling and the direct-entry return destination', async () => {
    const app = setup({ hash: '#/calendar', autoBoot: true, fetch: async () => response({}, 401) });
    await app.result;
    expect(app.calls.map(({ path }) => path)).toEqual(['/api/me/dashboard', '/api/me']);
    expect(app.context.location.href).toBe('/login?next=' + encodeURIComponent('/organizer/#/calendar'));
    expect(app.run('contactCreateOwner')).toBeNull();
    expect(app.run('contactCreateRetryEnabled')).toBe(false);
    expect(app.node('app').innerHTML).toContain('Loading...');
    expect(app.node('app').innerHTML).not.toContain('Try again');
    expect(app.context.window.onhashchange).toBeUndefined();
  });

  it.each(['/api/me/dashboard', '/api/me'].flatMap((authPath) => [200, 401, 503].map((otherStatus) => [authPath, otherStatus])))('redirects a boot %s 401 after a hash change with the other read returning %i', async (authPath, otherStatus) => {
    const requests = new Map(['/api/me/dashboard', '/api/me'].map((path) => [path, deferred()]));
    const app = setup({ autoBoot: true, fetch: (path) => requests.get(path).promise });
    expect(app.context.window.onhashchange).toBeUndefined();
    expect(app.node('app').innerHTML).toContain('Loading...');
    app.context.location.hash = '#/contacts?next=https://evil.test/&label=A%20B';
    const otherPath = authPath === '/api/me' ? '/api/me/dashboard' : '/api/me';
    requests.get(otherPath).resolve(response({ user: { id: owner }, is_empty: false, error: 'Temporarily unavailable' }, otherStatus));
    await requests.get(otherPath).promise;
    if (otherStatus === 503) {
      await app.result;
      expect(app.node('app').innerHTML).toContain('Try again');
    }
    requests.get(authPath).resolve(response({}, 401));
    await app.result;
    // Promise.all can finish on the other error first. Let this auth response
    // settle too, rather than assuming boot's rejected promise awaited it.
    await requests.get(authPath).promise;
    expect(app.context.location.href).toBe('/login?next=' + encodeURIComponent('/organizer/' + app.context.location.hash));
    const login = new URL(app.context.location.href, app.context.location.origin);
    expect(new URL(login.searchParams.get('next'), login).origin).toBe(app.context.location.origin);
    expect(app.run('contactCreateOwner')).toBeNull();
    expect(app.run('contactCreateRetryEnabled')).toBe(false);
    expect(app.context.window.onhashchange).toBeUndefined();
    expect(app.calls.map(({ path }) => path)).toEqual(['/api/me/dashboard', '/api/me']);
    for (const { opts } of app.calls) expect(Object.keys(opts).sort()).toEqual(['credentials', 'headers']);
  });

  it.each([200, 503])('keeps a boot redirect when the other read finishes later with %i', async (status) => {
    const auth = deferred(), other = deferred();
    const app = setup({ autoBoot: true, fetch: (path) => path === '/api/me' ? auth.promise : other.promise });
    app.context.location.hash = '#/calendar';
    auth.resolve(response({}, 401)); await app.result;
    const login = '/login?next=' + encodeURIComponent('/organizer/#/calendar');
    expect(app.context.location.href).toBe(login);
    other.resolve(response({ is_empty: false, error: 'Unavailable' }, status));
    await other.promise;
    expect(app.context.location.href).toBe(login);
    expect(app.context.window.onhashchange).toBeUndefined();
    expect(app.calls).toHaveLength(2);
  });

  it('still installs routing at the latest hash after successful boot reads', async () => {
    const pending = deferred();
    const app = setup({ autoBoot: true, fetch: (path) => path === '/api/me/contacts' ? response({ contacts: [] }) : pending.promise });
    app.context.MutationObserver = class { observe() {} };
    app.context.location.hash = '#/contacts';
    pending.resolve(response({ user: { id: owner }, capabilities: { contact_create_retry: true }, is_empty: false }));
    await app.result;
    expect(app.context.location.href).toBeUndefined();
    expect(app.context.window.onhashchange).toBeTypeOf('function');
    expect(app.run('contactCreateOwner')).toBe(owner);
    expect(app.run('contactCreateRetryEnabled')).toBe(true);
    expect(app.calls.map(({ path }) => path)).toEqual(['/api/me/dashboard', '/api/me', '/api/me/contacts']);
  });

  it('does not let obsolete boot reads redirect after a newer navigation generation', async () => {
    const pending = deferred();
    const app = setup({ autoBoot: true, fetch: () => pending.promise });
    app.context.location.hash = '#/contacts'; app.run("renderLoading('New view')");
    pending.resolve(response({}, 401)); await app.result;
    expect(app.context.location.href).toBeUndefined();
    expect(app.node('app').innerHTML).toContain('New view');
    expect(app.calls).toHaveLength(2);
  });
});
