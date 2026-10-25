import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8').replace(/\nboot\(\);\s*$/, '');
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const candidate = { name: 'Alice', category: 'personal', interests: [], notes: '', preferred_frequency_days: 14 };
const store = (data = new Map()) => ({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) });
const unavailable = { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); }, removeItem() { throw new Error('Storage blocked'); } };
function server() {
  const contacts = []; const receipts = new Map(); const calls = []; const goalRows = []; const goalCalls = [];
  let lost = 0; let hold; let owner = alice; let goalsHold;
  return {
    contacts, receipts, calls, goalRows, goalCalls,
    setOwner(value) { owner = value; },
    holdGoals() { let release; goalsHold = new Promise((resolve) => { release = resolve; }); return () => { goalsHold = null; release(); }; },
    lose(count = 1) { lost = count; },
    hold() { let release; hold = new Promise((resolve) => { release = resolve; }); return () => { hold = null; release(); }; },
    async fetch(path, opts = {}) {
      if (path === '/api/me/goals') {
        goalCalls.push({ path, ...opts });
        if (opts.headers?.['X-Contact-Owner'] !== owner) return new Response(JSON.stringify({ error: 'Your signed-in account changed. Reload before saving.' }), { status: 409 });
        goalRows.push({ owner, goals: JSON.parse(opts.body) });
        if (goalsHold) await goalsHold;
        return new Response('{}');
      }
      if (path === '/api/me') return new Response(JSON.stringify({ user: { id: owner } }));
      if (opts.method !== 'POST') return new Response(JSON.stringify({ contacts }));
      calls.push({ path, ...opts });
      if (opts.headers['X-Contact-Owner'] !== owner) return new Response(JSON.stringify({ error: 'Your signed-in account changed. Reload before saving.' }), { status: 409 });
      const key = opts.headers['X-Contact-Owner'] + ':' + (opts.headers['Idempotency-Key'] || webcrypto.randomUUID());
      let receipt = receipts.get(key);
      if (!receipt) {
        const body = JSON.parse(opts.body); const rows = (body.contacts || [body]).map((c) => ({ ...c, id: webcrypto.randomUUID() }));
        contacts.push(...rows); receipt = { created_ids: rows.map((c) => c.id) }; receipts.set(key, receipt);
      }
      if (hold) await hold;
      if (lost) { lost--; throw new Error('Response lost after commit'); }
      const current = receipt.created_ids.flatMap((id) => contacts.filter((c) => c.id === id));
      return new Response(JSON.stringify({ contacts: current, created_ids: receipt.created_ids, missing_ids: receipt.created_ids.filter((id) => !current.some((c) => c.id === id)) }), { status: 201 });
    },
  };
}
function browser(service, { local = store(), session = store(), owner = alice, prefill, retryEnabled = true } = {}) {
  const nodes = new Map(); let goals = [];
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', value: '', textContent: '', disabled: false,
        setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {},
        querySelectorAll() { return []; }, classList: { add() {}, remove() {}, toggle() {} } });
      return nodes.get(id);
    },
    querySelectorAll: (selector) => selector === '.goal-input' ? goals : [],
  };
  let html = '';
  Object.defineProperty(document.getElementById('app'), 'innerHTML', {
    get: () => html,
    set(value) {
      html = value;
      goals = [...value.matchAll(/class="goal-input" data-cat="([^"\s]+)" min="0" max="100" value="([^"]*)"/g)]
        .map((m) => ({ dataset: { cat: m[1] }, value: m[2], disabled: false }));
      // Simulate fresh form controls, not old fields retained by the test DOM.
      for (const [id, value] of Object.entries({ 'c-name': '', 'c-cat': 'personal', 'c-interests': '', 'c-notes': '', 'c-email': '', 'c-freq': '14', 'c-next': '' })) document.getElementById(id).value = value;
    },
  });
  const context = vm.createContext({ document, crypto: webcrypto, localStorage: local, sessionStorage: session,
    window: { localStorage: local, sessionStorage: session, ...(prefill ? { ORGANIZER_PREFILL: prefill } : {}) },
    location: { hash: '#/contacts' }, confirm: () => false, fetch: service.fetch.bind(service),
  });
  vm.runInContext(source, context); context.owner = owner; vm.runInContext('contactCreateOwner = owner', context);
  context.retryEnabled = retryEnabled; vm.runInContext('contactCreateRetryEnabled = retryEnabled', context);
  return { context, local, session, run: (script) => vm.runInContext(script, context), node: (id) => document.getElementById(id),
    async add() { await vm.runInContext('contactsView()', context); document.getElementById('c-name').value = candidate.name; },
    submit() { return document.getElementById('add-form').onsubmit({ preventDefault() {} }); },
    setup() { vm.runInContext('onboardingView()', context); document.getElementById('ob-next').onclick(); },
  };
}
const token = (call) => call.headers['Idempotency-Key'];
describe('manual contact create retry UI', () => {
  it('reuses one key after two lost successful Add responses and creates exactly once', async () => {
    const service = server(); service.lose(2); const app = browser(service); await app.add();
    await app.submit(); await app.submit(); await app.submit();
    expect(service.contacts).toHaveLength(1); expect(service.calls).toHaveLength(3);
    expect(new Set(service.calls.map(token)).size).toBe(1);
    expect(service.calls[0].headers['Content-Type']).toBe('application/json');
  });
  it.each(['local', 'session'])('restores pending Add fields and retry token across refresh with %s storage', async (available) => {
    const service = server(); service.lose(); const storage = store();
    const options = available === 'local' ? { local: storage, session: unavailable } : { local: unavailable, session: storage };
    const app = browser(service, options); await app.add(); app.node('c-email').value = 'alice@example.test'; await app.submit();
    const refreshed = browser(service, options); await refreshed.run('contactsView()');
    expect(refreshed.node('c-name').value).toBe('Alice'); expect(refreshed.node('c-email').value).toBe('alice@example.test');
    await refreshed.submit();
    expect(service.contacts).toHaveLength(1); expect(token(service.calls[1])).toBe(token(service.calls[0]));
  });
  it('restores onboarding people from its pending intent after refresh even when the normal draft was lost', async () => {
    const service = server(); service.lose(); const storage = store();
    const app = browser(service, { local: storage, session: unavailable, prefill: { contacts: [candidate] } }); app.setup();
    await app.node('ob-confirm').onclick();
    const refreshed = browser(service, { local: storage, session: unavailable }); refreshed.setup();
    await refreshed.node('ob-confirm').onclick();
    expect(service.contacts).toHaveLength(1); expect(service.calls).toHaveLength(2);
    expect(token(service.calls[1])).toBe(token(service.calls[0]));
    expect(refreshed.node('app').innerHTML).toContain('1 person added');
    await refreshed.node('d-checkin').onclick();
    expect(refreshed.context.location.hash).toBe('#/contacts/' + service.contacts[0].id);
  });
  it('keeps the in-memory key when both stores throw and explains the refresh limitation', async () => {
    const service = server(); service.lose(); const app = browser(service, { local: unavailable, session: unavailable }); await app.add();
    await app.submit(); expect(app.node('add-error').textContent).toContain('keep this tab open');
    await app.submit(); expect(service.contacts).toHaveLength(1); expect(token(service.calls[1])).toBe(token(service.calls[0]));
  });
  it('does not silently treat edits to an uncertain create as a new create or overwrite', async () => {
    const service = server(); service.lose(); const app = browser(service); await app.add(); await app.submit();
    app.node('c-name').value = 'Edited'; await app.submit();
    expect(app.node('add-error').textContent).toContain('Retry the original details first');
    expect(service.calls).toHaveLength(1); expect(service.contacts[0].name).toBe('Alice');
    app.node('add-new').onclick(); // Decline abandonment.
    expect(app.run("pendingContactIntent('add').key")).toBe(token(service.calls[0]));
    app.context.confirm = () => true; app.node('add-new').onclick(); await Promise.resolve(); await Promise.resolve();
    await app.add(); await app.submit();
    expect(service.contacts).toHaveLength(2); expect(token(service.calls[1])).not.toBe(token(service.calls[0]));
  });
  it('a deliberate new Add after acknowledged success may create another same-named person', async () => {
    const service = server(); const app = browser(service); await app.add(); await app.submit();
    await app.add(); await app.submit();
    expect(service.contacts).toHaveLength(2); expect(token(service.calls[1])).not.toBe(token(service.calls[0]));
  });
  it('does not restore or send a prior account’s pending contact in another account', async () => {
    const service = server(); service.lose(); const local = store();
    const app = browser(service, { local }); await app.add(); await app.submit();
    service.setOwner(bob);
    const other = browser(service, { local, owner: bob }); await other.run('contactsView()');
    expect(other.node('c-name').value).toBe(''); expect(other.run("pendingContactIntent('add')")).toBeNull();
    other.node('c-name').value = 'Bob'; await other.submit();
    expect(service.calls[1].headers['X-Contact-Owner']).toBe(bob);
  });
  it('retains an intent after a late success on an abandoned onboarding view', async () => {
    const service = server(); const release = service.hold();
    const app = browser(service, { prefill: { contacts: [candidate] } }); app.setup();
    const pending = app.node('ob-confirm').onclick();
    while (!service.calls.length) await Promise.resolve();
    app.run('navGen++'); app.node('app').innerHTML = 'Other page'; release(); await pending;
    expect(app.node('app').innerHTML).toBe('Other page');
    expect(app.run("pendingContactIntent('onboarding').key")).toBe(token(service.calls[0]));
    app.setup(); await app.node('ob-confirm').onclick();
    expect(service.contacts).toHaveLength(1); expect(token(service.calls[1])).toBe(token(service.calls[0]));
  });
  it('keeps the original form token even if another tab acknowledges the shared intent', async () => {
    const service = server(); service.lose(); const local = store(); const app = browser(service, { local });
    await app.add(); await app.submit(); const other = browser(service, { local });
    await other.run('contactsView()'); await other.submit(); await app.submit();
    expect(service.contacts).toHaveLength(1); expect(new Set(service.calls.map(token)).size).toBe(1);
  });
  it('keeps a newer pending intent when an old tab retries an abandoned action', async () => {
    const service = server(); const local = store(); service.lose();
    const first = browser(service, { local }); await first.add(); await first.submit();
    const second = browser(service, { local }); await second.run('contactsView()');
    second.context.confirm = () => true; second.node('add-new').onclick(); await second.add();
    service.lose(); second.node('c-name').value = 'Bob'; await second.submit();
    const newer = second.run("pendingContactIntent('add').key");
    await first.submit();
    const refreshed = browser(service, { local }); await refreshed.run('contactsView()');
    expect(refreshed.node('c-name').value).toBe('Bob');
    expect(refreshed.run("pendingContactIntent('add').key")).toBe(newer);
    await refreshed.submit(); expect(service.contacts).toHaveLength(2);
  });
  it('does not show a new owner the prior owner’s saved onboarding draft', async () => {
    const service = server(); const local = store(); const session = store(); service.lose();
    const first = browser(service, { local, session, prefill: { contacts: [candidate] } }); first.setup();
    await first.node('ob-confirm').onclick();
    const second = browser(service, { local, session, owner: bob }); second.run('onboardingView()');
    expect(second.node('ob-rows').innerHTML).not.toContain('value="Alice"');
    expect(second.run("pendingContactIntent('onboarding')")).toBeNull();
  });
  it('keeps the key if decoding a committed HTTP success fails', async () => {
    const service = server(); const fetch = service.fetch.bind(service); let failed = false;
    service.fetch = async (path, options) => {
      const reply = await fetch(path, options);
      if (options?.method === 'POST' && !failed) { failed = true; return new Response('{', { status: 201 }); }
      return reply;
    };
    const app = browser(service); await app.add(); await app.submit(); await app.submit();
    expect(service.contacts).toHaveLength(1); expect(token(service.calls[1])).toBe(token(service.calls[0]));
  });

  it('preserves the exact follow-up instant on an unchanged restored date across timezones', async () => {
    const service = server(); const app = browser(service);
    app.context.savedBody = { ...candidate, next_followup_at: '2026-10-25T22:00:00.000Z' };
    app.run("writeContactIntent('add', { key: '33333333-3333-4333-8333-333333333333', state: 'pending', body: savedBody })");
    await app.run('contactsView()'); await app.submit();
    expect(JSON.parse(service.calls[0].body)).toEqual(app.context.savedBody);
  });

  it('rejects an account switch before any onboarding goals or contacts mutate', async () => {
    const service = server(); const app = browser(service, { prefill: { contacts: [candidate], goals: { personal: 80, professional: 10, community: 10 } } });
    app.setup(); service.setOwner(bob); await app.node('ob-confirm').onclick();
    expect(service.goalRows).toEqual([]); expect(service.contacts).toEqual([]); expect(service.calls).toEqual([]);
    expect(service.goalCalls[0].headers['X-Contact-Owner']).toBe(alice);
    expect(app.node('ob-error').textContent).toContain('account changed');
  });
  it('binds the later contact write to the original owner when the goals response is delayed', async () => {
    const service = server(); const release = service.holdGoals();
    const app = browser(service, { prefill: { contacts: [candidate] } }); app.setup();
    const pending = app.node('ob-confirm').onclick();
    expect(service.goalRows).toHaveLength(1); expect(service.goalRows[0].owner).toBe(alice);
    service.setOwner(bob); release(); await pending;
    expect(service.goalRows.some((row) => row.owner === bob)).toBe(false); expect(service.contacts).toEqual([]);
    expect(service.calls[0].headers['X-Contact-Owner']).toBe(alice);
    expect(app.node('ob-error').textContent).toContain('account changed');
  });
  it('allows correcting a first-attempt pre-commit validation rejection without losing form fields', async () => {
    const service = server(); const fetch = service.fetch.bind(service); const attempts = [];
    service.fetch = async (path, options) => {
      if (options?.method === 'POST') {
        attempts.push(options);
        if (JSON.parse(options.body).preferred_frequency_days > 365) return new Response(JSON.stringify({ error: 'Frequency must not exceed 365', code: 'contact_input_rejected' }), { status: 400 });
      }
      return fetch(path, options);
    };
    const app = browser(service); await app.add(); app.node('c-freq').value = '366'; await app.submit();
    expect(app.node('c-name').value).toBe('Alice'); expect(app.node('c-freq').value).toBe('366');
    expect(app.run("pendingContactIntent('add')")).toBeNull();
    app.node('c-freq').value = '365'; await app.submit();
    expect(attempts).toHaveLength(2); expect(token(attempts[0])).not.toBe(token(attempts[1]));
    expect(service.contacts).toHaveLength(1); expect(service.contacts[0].preferred_frequency_days).toBe(365);
  });
  it.each([undefined, 'contact_input_rejected'])('never discards an uncertain intent on a later 400, including code %s', async (code) => {
    const service = server(); service.lose(); const app = browser(service); await app.add(); await app.submit();
    const original = token(service.calls[0]);
    app.context.fetch = async () => new Response(JSON.stringify({ error: 'Could not validate', code }), { status: 400 });
    await app.submit(); expect(app.run("pendingContactIntent('add').key")).toBe(original);
    app.node('c-name').value = 'Edited'; await app.submit();
    expect(app.node('add-error').textContent).toContain('Retry the original details first'); expect(service.contacts).toHaveLength(1);
  });

  it('clears pending private Add data on success, and reports deleted replays without recreating', async () => {
    const service = server(); service.lose(); const app = browser(service); await app.add();
    app.node('c-notes').value = 'Private pending note'; app.node('c-email').value = 'private@example.test'; await app.submit();
    const storageKey = 'org_contact_create_v1:' + alice + ':add';
    expect(app.local.getItem(storageKey)).toContain('Private pending note');
    service.contacts.splice(0); await app.submit();
    expect(service.contacts).toEqual([]); expect(JSON.parse(app.session.getItem('org_flash')).msg).toContain('Nothing was recreated');
    expect(app.local.getItem(storageKey)).not.toMatch(/Private pending note|private@example/);
    expect(app.session.getItem(storageKey)).not.toMatch(/Private pending note|private@example/);
  });
  it('handles a fully deleted onboarding replay without a false added message or missing-name crash', async () => {
    const service = server(); service.lose(); const app = browser(service, { prefill: { contacts: [candidate] } }); app.setup();
    await app.node('ob-confirm').onclick(); service.contacts.splice(0); await app.node('ob-confirm').onclick();
    expect(service.contacts).toEqual([]); expect(app.node('app').innerHTML).toContain('Nothing was recreated');
    expect(app.node('app').innerHTML).not.toContain('person added'); expect(app.node('app').innerHTML).not.toContain('id="d-checkin"');
    expect(app.run("pendingContactIntent('onboarding')")).toBeNull();
  });
  it('clears private pending fields after explicit abandonment', async () => {
    const service = server(); service.lose(); const app = browser(service); await app.add();
    app.node('c-notes').value = 'Private abandoned note'; await app.submit();
    app.context.confirm = () => true; app.node('add-new').onclick();
    const key = 'org_contact_create_v1:' + alice + ':add';
    expect(app.local.getItem(key)).not.toContain('Private abandoned note');
    expect(app.session.getItem(key)).not.toContain('Private abandoned note');
  });

  it('lets onboarding correct a first-attempt validation rejection through Back without losing the person', async () => {
    const service = server(); const fetch = service.fetch.bind(service); const attempts = [];
    service.fetch = async (path, options) => {
      if (options?.method === 'POST') {
        attempts.push(options);
        if (JSON.parse(options.body).contacts[0].preferred_frequency_days > 365) return new Response(JSON.stringify({ error: 'Frequency must not exceed 365', code: 'contact_input_rejected' }), { status: 400 });
      }
      return fetch(path, options);
    };
    const app = browser(service, { prefill: { contacts: [{ ...candidate, preferred_frequency_days: 366 }] } }); app.setup();
    await app.node('ob-confirm').onclick(); expect(app.run("pendingContactIntent('onboarding')")).toBeNull();
    app.node('ob-back').onclick(); expect(app.node('ob-rows').innerHTML).toContain('value="Alice"');
    const query = app.context.document.querySelectorAll;
    app.context.document.querySelectorAll = (selector) => selector === '.ob-row' ? [{ querySelector: (field) => ({ value: ({ '[data-f=name]': 'Alice', '[data-f=category]': 'personal', '[data-f=interests]': '', '[data-f=freq]': '365' })[field] }) }] : query(selector);
    app.node('ob-next').onclick(); await app.node('ob-confirm').onclick();
    expect(attempts).toHaveLength(2); expect(token(attempts[0])).not.toBe(token(attempts[1]));
    expect(service.contacts).toHaveLength(1); expect(service.contacts[0].preferred_frequency_days).toBe(365);
  });
  it('does not release a key on an unclassified first-attempt 400', async () => {
    const service = server(); const app = browser(service); await app.add();
    app.context.fetch = async () => new Response(JSON.stringify({ error: 'Database outcome unknown' }), { status: 400 });
    await app.submit(); const pending = app.run("pendingContactIntent('add')");
    expect(pending.attempts).toBe(1); app.node('c-name').value = 'Edited'; await app.submit();
    expect(app.run("pendingContactIntent('add').key")).toBe(pending.key);
    expect(app.node('add-error').textContent).toContain('Retry the original details first');
  });
  it('does not release a first-attempt rejection if another tab already attempted the same intent', async () => {
    const service = server(); const app = browser(service); await app.add(); let settle;
    app.context.fetch = () => new Promise((resolve) => { settle = resolve; });
    const pending = app.submit(); const key = app.run("pendingContactIntent('add').key");
    app.run("writeContactIntent('add', { ...pendingContactIntent('add'), attempts: 2 })");
    settle(new Response(JSON.stringify({ error: 'Input rejected', code: 'contact_input_rejected' }), { status: 400 })); await pending;
    expect(app.run("pendingContactIntent('add').key")).toBe(key);
  });

});


describe('manual contact retry rollout UI', () => {
  it.each(['add', 'onboarding'])('uses unkeyed legacy %s creation without advertising safe retry when capability is off', async (kind) => {
    const service = server(); const app = browser(service, { retryEnabled: false, prefill: { contacts: [candidate] } });
    if (kind === 'add') await app.add(); else app.setup();
    expect(app.node('app').innerHTML).not.toContain('Retries reuse the same save key');
    if (kind === 'add') await app.submit(); else await app.node('ob-confirm').onclick();
    expect(service.calls).toHaveLength(1); expect(token(service.calls[0])).toBeUndefined();
    expect(service.calls[0].headers['X-Contact-Owner']).toBe(alice); expect(service.contacts).toHaveLength(1);
  });
  it.each(['add', 'onboarding'])('blocks repeat %s submissions after an unkeyed lost response, including after refresh or later enablement', async (kind) => {
    const service = server(); service.lose(); const local = store();
    const options = { local, retryEnabled: false, prefill: { contacts: [candidate] } };
    const app = browser(service, options);
    if (kind === 'add') await app.add(); else app.setup();
    const submit = (page) => kind === 'add' ? page.submit() : page.node('ob-confirm').onclick();
    await submit(app); await submit(app);
    expect(app.node(kind === 'add' ? 'add-error' : 'ob-error').textContent).toContain('Check Contacts');
    expect(service.calls).toHaveLength(1); expect(service.contacts).toHaveLength(1);
    const refreshed = browser(service, { ...options, retryEnabled: true });
    if (kind === 'add') await refreshed.run('contactsView()'); else refreshed.setup();
    await submit(refreshed);
    expect(service.calls).toHaveLength(1); expect(service.contacts).toHaveLength(1);
    expect(refreshed.node(kind === 'add' ? 'add-error' : 'ob-error').textContent).toContain('cannot be safely retried');
  });
  it('retains a keyed intent while capability is disabled and never downgrades it to legacy', async () => {
    const service = server(); service.lose(); const local = store();
    const first = browser(service, { local }); await first.add(); await first.submit();
    const original = token(service.calls[0]);
    const disabled = browser(service, { local, retryEnabled: false }); await disabled.run('contactsView()'); await disabled.submit();
    expect(service.calls).toHaveLength(1); expect(disabled.run("pendingContactIntent('add').key")).toBe(original);
    expect(disabled.node('add-error').textContent).toContain('temporarily unavailable');
    const enabled = browser(service, { local }); await enabled.run('contactsView()'); await enabled.submit();
    expect(service.calls).toHaveLength(2); expect(token(service.calls[1])).toBe(original); expect(service.contacts).toHaveLength(1);
  });
  it('never falls back to an unkeyed insert after a keyed 503', async () => {
    const service = server(); const seen = [];
    service.fetch = async (path, options = {}) => {
      if (options.method === 'POST') { seen.push(options); return new Response(JSON.stringify({ error: 'Safe contact saving is unavailable' }), { status: 503 }); }
      return new Response(JSON.stringify({ contacts: [] }));
    };
    const app = browser(service); await app.add(); await app.submit(); await app.submit();
    expect(seen).toHaveLength(2); expect(token(seen[0])).toBeTruthy(); expect(token(seen[1])).toBe(token(seen[0]));
    expect(app.run("pendingContactIntent('add').key")).toBe(token(seen[0]));
  });
  it('allows a deliberate new legacy add only after explicit abandonment and warns about possible duplicates', async () => {
    const service = server(); service.lose(); const app = browser(service, { retryEnabled: false }); await app.add(); await app.submit();
    app.node('add-new').onclick(); await app.submit(); expect(service.calls).toHaveLength(1);
    let warning; app.context.confirm = (text) => { warning = text; return true; }; app.node('add-new').onclick();
    await app.add(); await app.submit();
    expect(warning).toContain('Check Contacts first'); expect(warning).toContain('create another person');
    expect(service.contacts).toHaveLength(2); expect(service.calls.every((call) => token(call) === undefined)).toBe(true);
  });
  it('unlocks a first-attempt explicitly rejected legacy body for correction', async () => {
    const service = server(); const fetch = service.fetch.bind(service);
    service.fetch = async (path, options) => options?.method === 'POST' && JSON.parse(options.body).preferred_frequency_days > 365
      ? new Response(JSON.stringify({ error: 'Invalid frequency', code: 'contact_input_rejected' }), { status: 400 }) : fetch(path, options);
    const app = browser(service, { retryEnabled: false }); await app.add(); app.node('c-freq').value = '366'; await app.submit();
    expect(app.run("pendingContactIntent('add')")).toBeNull(); app.node('c-freq').value = '365'; await app.submit();
    expect(service.contacts).toHaveLength(1); expect(token(service.calls[0])).toBeUndefined();
  });
  it.each([undefined, false, 'true', true])('boot enables retry only for explicit boolean capability %j', async (capability) => {
    const service = server(); service.fetch = async (path) => new Response(JSON.stringify(path === '/api/me'
      ? { user: { id: alice }, capabilities: { contact_create_retry: capability } } : { is_empty: false }));
    const app = browser(service, { retryEnabled: false });
    app.run('installFlash = () => {}; route = () => {};'); await app.run('boot()');
    expect(app.run('contactCreateRetryEnabled')).toBe(capability === true);
  });
});


describe('legacy contact uncertainty boundaries', () => {
  it.each(['lost', 'json', 'server'])('blocks unkeyed resubmission on %s uncertainty even without browser storage', async (failure) => {
    const service = server(); const fetch = service.fetch.bind(service);
    if (failure === 'lost') service.lose();
    else service.fetch = async (path, options) => {
      const result = await fetch(path, options);
      return options?.method !== 'POST' ? result : failure === 'json'
        ? new Response('{', { status: 201 }) : new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 });
    };
    const app = browser(service, { retryEnabled: false, local: unavailable, session: unavailable }); await app.add();
    await app.submit();
    expect(app.node('add-error').textContent).toContain('Check Contacts');
    expect(app.node('add-error').textContent).toContain('storage is unavailable');
    await app.submit(); expect(service.calls).toHaveLength(1); expect(service.contacts).toHaveLength(1);
  });
  it('keeps legacy owner binding before the onboarding goals mutation', async () => {
    const service = server(); const app = browser(service, { retryEnabled: false, prefill: { contacts: [candidate] } });
    app.setup(); service.setOwner(bob); await app.node('ob-confirm').onclick();
    expect(service.goalRows).toEqual([]); expect(service.calls).toEqual([]); expect(service.contacts).toEqual([]);
    expect(app.node('ob-error').textContent).toContain('account changed');
  });
  it('blocks replay of a late legacy success after navigating away', async () => {
    const service = server(); const release = service.hold(); const local = store();
    const app = browser(service, { local, retryEnabled: false }); await app.add();
    const pending = app.submit(); while (!service.calls.length) await Promise.resolve();
    app.run('navGen++'); app.node('app').innerHTML = 'Other page'; release(); await pending;
    expect(app.node('app').innerHTML).toBe('Other page');
    const refreshed = browser(service, { local, retryEnabled: false }); await refreshed.run('contactsView()'); await refreshed.submit();
    expect(service.calls).toHaveLength(1); expect(service.contacts).toHaveLength(1);
    expect(refreshed.node('add-error').textContent).toContain('cannot be safely retried');
  });
});
