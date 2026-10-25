import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Execute the shipped UI with synthetic API responses only. Replacing the page
// creates fresh goal controls, so an accidental full-page retry loses the draft
// here just as it would in the browser. This is not browser or live-service QA.
const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8').replace(/\nboot\(\);\s*$/, '');
const owner = '11111111-1111-4111-8111-111111111111';
const activityPath = '/api/me/interactions?limit=100';
const account = { user: { email: 'alice@example.test' } };
const dashboard = { goals: { personal: 60, professional: 20, community: 20 }, contact_counts: { personal: 2 } };
const activity = { interactions: [{ contact: { name: 'Bob', category: 'personal' }, type: 'check_in', notes: 'Synthetic note' }] };
const response = (body = {}, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function setup({ history = () => response(activity), save = () => response() } = {}) {
  const nodes = new Map(), calls = [];
  let goals = [], pageWrites = 0;
  function makeNode(id, className = '') {
    let html = '', children = [];
    const classes = new Set(className.split(' '));
    const node = {
      textContent: '', disabled: false,
      classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) },
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        if (id === 'app') { pageWrites++; nodes.clear(); nodes.set('app', node); goals = []; }
        for (const child of children) if (nodes.get(child.id) === child.node) nodes.delete(child.id);
        children = [];
        for (const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
          children.push({ id: match[1], node: makeNode(match[1], match[0].match(/class="([^"]*)"/)?.[1]) });
        }
        if (id === 'app') goals = [...value.matchAll(/<input[^>]*class="me-goal-input"[^>]*data-cat="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)]
          .map((match) => ({ dataset: { cat: match[1] }, value: match[2], disabled: false }));
      },
    };
    nodes.set(id, node);
    return node;
  }
  makeNode('app');
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id) || null, querySelectorAll: (selector) => selector === '.me-goal-input' ? goals : [] },
    location: { origin: 'https://example.test', hash: '#/profile' }, window: {},
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: (path, opts) => {
      calls.push({ path, opts });
      if (path === activityPath) return history();
      if (path === '/api/me/goals') return save(opts);
      return response(path === '/api/me' ? account : dashboard);
    },
  });
  const run = (code) => vm.runInContext(code, context);
  run(source); run(`contactCreateOwner = '${owner}';`);
  return { context, calls, run, node: (id) => nodes.get(id), goals: () => goals, pageWrites: () => pageWrites,
    load: () => run('profileView()'), retry: () => nodes.get('me-activity-retry').onclick(),
  };
}

describe('Profile activity error recovery', () => {
  it('shows a retryable activity failure rather than claiming nothing was logged', async () => {
    const app = setup({ history: () => response({ error: 'Synthetic history timeout' }, 503) });
    await app.load();
    expect(app.node('app').innerHTML).toContain('alice@example.test');
    expect(app.node('app').innerHTML).toContain('Personal</strong> · 60%');
    expect(app.node('app').innerHTML).not.toContain('Nothing logged yet');
    expect(app.node('me-activity-log').innerHTML).toContain('Could not load activity');
    expect(app.node('me-activity-log').innerHTML).toContain('Synthetic history timeout');
    expect(app.node('me-activity-retry').onclick).toBeTypeOf('function');
  });

  it.each(['network failure', 'invalid JSON'])('does not show empty history on %s', async (failure) => {
    const app = setup({ history: () => failure === 'network failure'
      ? Promise.reject(new Error('Synthetic connection lost'))
      : { ...response(), json: async () => { throw new Error('Synthetic invalid JSON'); } } });
    await app.load();
    expect(app.node('me-activity-log').innerHTML).toContain('Could not load activity');
    expect(app.node('me-activity-log').innerHTML).not.toContain('Nothing logged yet');
  });

  it.each([['empty', { interactions: [] }], ['populated', activity]])('renders a successful %s activity response', async (kind, data) => {
    const app = setup({ history: () => response(data) }); await app.load();
    expect(app.node('me-activity-log').innerHTML).toContain(kind === 'empty' ? 'Nothing logged yet' : 'Bob');
    expect(app.node('me-activity-retry')).toBeUndefined();
  });

  it('makes profile and goals usable while the initial activity request is pending', async () => {
    const pending = deferred(), started = deferred();
    const app = setup({ history: () => { started.resolve(); return pending.promise; } });
    const load = app.load();
    await started.promise;
    expect(app.node('app').innerHTML).toContain('alice@example.test');
    expect(app.node('me-activity-log').innerHTML).toContain('Loading activity');
    app.node('me-edit-goals').onclick();
    expect(app.node('me-goals-form').classList.contains('hidden')).toBe(false);
    const inputs = app.goals(), pageWrites = app.pageWrites();
    inputs[0].value = '55'; inputs[0].oninput();
    pending.resolve(response(activity)); await load;
    expect(app.goals()).toBe(inputs);
    expect(inputs[0].value).toBe('55');
    expect(app.pageWrites()).toBe(pageWrites);
    expect(app.node('me-activity-log').innerHTML).toContain('Bob');
  });

  it.each(['empty', 'populated', 'failed'])('retries only activity, preserving the goals draft and preventing duplicate reads (%s)', async (outcome) => {
    const pending = deferred(); let attempt = 0;
    const app = setup({ history: () => ++attempt === 1 ? response({ error: 'Unavailable' }, 503) : pending.promise });
    await app.load();
    app.node('me-edit-goals').onclick();
    const inputs = app.goals(), form = app.node('me-goals-form'), pageWrites = app.pageWrites();
    inputs.forEach((input, i) => { input.value = ['50', '25', '25'][i]; input.oninput(); });
    const retry = app.node('me-activity-retry').onclick;
    const loading = retry(); await retry();
    expect(attempt).toBe(2);
    expect(app.node('me-activity-retry')).toBeUndefined();
    expect(app.node('me-activity-log').innerHTML).toContain('Loading activity');
    pending.resolve(outcome === 'failed' ? response({ error: 'Still unavailable' }, 503)
      : response(outcome === 'empty' ? { interactions: [] } : activity));
    await loading;
    expect(app.pageWrites()).toBe(pageWrites);
    expect(app.goals()).toBe(inputs);
    expect(app.node('me-goals-form')).toBe(form);
    expect(form.classList.contains('hidden')).toBe(false);
    expect(inputs.map((input) => input.value)).toEqual(['50', '25', '25']);
    expect(app.node('me-goals-total').textContent).toBe(100);
    expect(app.node('me-goals-save').disabled).toBe(false);
    expect(app.calls.map(({ path }) => path)).toEqual(['/api/me', '/api/me/dashboard', activityPath, activityPath]);
    expect(app.node('me-activity-log').innerHTML).toContain(outcome === 'failed' ? 'Still unavailable'
      : outcome === 'empty' ? 'Nothing logged yet' : 'Bob');
    if (outcome === 'failed') expect(app.node('me-activity-retry').onclick).toBeTypeOf('function');
  });

  it('keeps an in-flight goal save locked and owner-scoped while retrying activity', async () => {
    const saved = deferred(), history = deferred(); let attempt = 0;
    const app = setup({ history: () => ++attempt === 1 ? response({ error: 'Unavailable' }, 503) : history.promise, save: () => saved.promise });
    await app.load(); app.node('me-edit-goals').onclick();
    app.goals().forEach((input, i) => { input.value = ['50', '25', '25'][i]; });
    const save = app.node('me-goals-save').onclick, pendingSave = save();
    const retry = app.retry();
    history.resolve(response(activity)); await retry;
    await save(); app.node('me-goals-cancel').onclick();
    const writes = app.calls.filter(({ path }) => path === '/api/me/goals');
    expect(writes).toHaveLength(1);
    expect(writes[0].opts.headers['X-Contact-Owner']).toBe(owner);
    expect(writes[0].opts.method).toBe('PUT');
    expect(JSON.parse(writes[0].opts.body)).toEqual({ personal: 50, professional: 25, community: 25 });
    expect(app.node('me-goals-save').disabled).toBe(true);
    expect(app.node('me-goals-cancel').disabled).toBe(true);
    expect(app.goals().every((input) => input.disabled)).toBe(true);
    expect(app.node('me-goals-form').classList.contains('hidden')).toBe(false);
    saved.resolve(response({ error: 'Synthetic goal save failed' }, 503)); await pendingSave;
    expect(app.node('me-goals-error').textContent).toBe('Synthetic goal save failed');
    expect(app.node('me-goals-save').disabled).toBe(false);
    expect(app.goals().map((input) => input.value)).toEqual(['50', '25', '25']);
  });

  it.each([200, 503, 401])('ignores goal-save results (%i) and callbacks after a hash change before routing', async (status) => {
    const saved = deferred();
    const app = setup({ save: () => saved.promise }); await app.load();
    app.node('me-edit-goals').onclick();
    const save = app.node('me-goals-save').onclick, saving = save(), pageWrites = app.pageWrites();
    app.context.location.hash = '#/contacts';
    await save(); app.node('me-goals-cancel').onclick();
    saved.resolve(response({ error: 'Abandoned save' }, status)); await saving;
    await save();
    expect(app.pageWrites()).toBe(pageWrites);
    expect(app.calls.filter(({ path }) => path === '/api/me/goals')).toHaveLength(1);
    expect(app.node('me-goals-error').textContent).toBe('');
    expect(app.context.location.href).toBeUndefined();
  });

  it('escapes activity errors and records, and describes the newest-100 limit honestly', async () => {
    const attack = '<img src=x onerror=alert(1)>'; let attempt = 0;
    const app = setup({ history: () => ++attempt === 1 ? response({ error: attack }, 503)
      : response({ interactions: [{ contact: { name: attack, category: attack }, type: attack, notes: attack, occurred_at: attack }] }) });
    await app.load();
    expect(app.node('me-activity-log').innerHTML).toContain('&lt;img');
    expect(app.node('me-activity-log').innerHTML).not.toContain('<img');
    await app.retry();
    expect(app.node('me-activity-log').innerHTML).toContain('&lt;img');
    expect(app.node('me-activity-log').innerHTML).not.toContain('<img');
    expect(app.node('app').innerHTML).toContain('most recent 100 check-ins, newest first');
    expect(app.node('app').innerHTML).not.toMatch(/everything you have logged/i);
  });

  it.each(['initial', 'retry'])('preserves the current 401 login redirect on the %s activity read', async (stage) => {
    let attempt = 0;
    const app = setup({ history: () => response({ error: 'Unavailable' }, ++attempt === 1 && stage === 'retry' ? 503 : 401) });
    await app.load(); if (stage === 'retry') await app.retry();
    expect(app.context.location.href).toBe('/login?next=' + encodeURIComponent('/organizer/#/profile'));
    expect(app.node('me-activity-log').innerHTML).not.toContain('Nothing logged yet');
    expect(app.node('me-activity-log').innerHTML).not.toContain('Could not load activity');
    expect(app.node('me-activity-retry')).toBeUndefined();
  });

  const staleCases = ['initial', 'retry'].flatMap((stage) => [200, 503, 401].flatMap((status) =>
    ['hash only', 'new generation', 'away and back'].map((navigation) => [stage, status, navigation])));
  it.each(staleCases)('ignores stale %s activity responses (%i, %s) and old retry callbacks', async (stage, status, navigation) => {
    const pending = deferred(), started = deferred(); let attempt = 0;
    const app = setup({ history: () => {
      if (++attempt === 1 && stage === 'retry') return response({ error: 'Unavailable' }, 503);
      started.resolve(); return pending.promise;
    } });
    let loading = app.load(), retry;
    if (stage === 'retry') { await loading; retry = app.node('me-activity-retry').onclick; loading = retry(); }
    await started.promise;
    const oldLog = app.node('me-activity-log');
    if (navigation === 'hash only') app.context.location.hash = '#/contacts';
    else if (navigation === 'new generation') app.run('renderLoading("New profile view")');
    else {
      app.context.location.hash = '#/contacts'; app.run('renderLoading("Contacts")');
      app.context.location.hash = '#/profile'; app.run('renderLoading("New profile view")');
    }
    const page = app.node('app').innerHTML, log = oldLog.innerHTML, callCount = app.calls.length;
    if (retry) await retry();
    pending.resolve(response(status === 200 ? activity : { error: 'Old failure' }, status)); await loading;
    if (retry) await retry();
    expect(app.node('app').innerHTML).toBe(page);
    expect(oldLog.innerHTML).toBe(log);
    expect(app.calls).toHaveLength(callCount);
    expect(app.context.location.href).toBeUndefined();
  });
});
