import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Exercise the shipped browser script without starting its automatic boot request.
const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8')
  .replace(/\nboot\(\);\s*$/, '');

function organizer(overrides = {}) {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', value: '', textContent: '', disabled: false,
        addEventListener() {}, setAttribute() {}, removeAttribute() {},
        querySelectorAll() { return this.controls || []; }, classList: { add() {}, remove() {}, toggle() {} } });
      return nodes.get(id);
    },
    querySelectorAll: () => [],
  };
  const storage = new Map();
  const context = vm.createContext({
    document,
    location: { origin: 'https://example.test', hash: '' },
    window: {}, crypto: webcrypto,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    ...overrides,
  });
  context.window.localStorage = context.localStorage; context.window.sessionStorage = context.sessionStorage;
  vm.runInContext(source, context);
  vm.runInContext("contactCreateOwner = '11111111-1111-4111-8111-111111111111'; contactCreateRetryEnabled = true;", context);
  return { context, document };
}

const attack = '<img src=x onerror=alert(1)>';
const escaped = '&lt;img src=x onerror=alert(1)&gt;';

describe('contact history and search recovery', () => {
  it.each([null, undefined, '', 42, false, { imported: 'name' }])('search survives a malformed or empty name: %j', async (name) => {
    const { context, document } = organizer({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ contacts: [
        { id: 'one', name, category: 'personal', interests: ['chess'] },
        { id: 'two', name: 'Alice', category: 'personal', interests: [] },
      ] }) }),
    });
    await vm.runInContext('contactsView()', context);
    const search = document.getElementById('c-search');
    search.value = 'alice'; search.oninput();
    expect(document.getElementById('contact-list').innerHTML).toContain('Alice');
    search.value = 'chess'; search.oninput();
    expect(document.getElementById('contact-list').innerHTML).toContain('data-view="one"');
    search.value = 'absent'; search.oninput();
    expect(document.getElementById('contact-list').innerHTML).toContain('No one matches');
  });

  it('renders a retryable history error rather than claiming there are no check-ins', async () => {
    let unavailable = true;
    const { context, document } = organizer({
      fetch: async () => unavailable
        ? { ok: false, status: 400, json: async () => ({ error: 'Synthetic history query timeout' }) }
        : { ok: true, status: 200, json: async () => ({ contact: { id: 'one', name: 'Alice', category: 'personal' }, interactions: [] }) },
    });
    await vm.runInContext("contactDetailView('one')", context);
    expect(document.getElementById('app').innerHTML).toContain('Synthetic history query timeout');
    expect(document.getElementById('app').innerHTML).not.toContain('No check-ins yet');
    unavailable = false;
    await document.getElementById('retry-btn').onclick();
    expect(document.getElementById('app').innerHTML).toContain('No check-ins yet');
  });
});

describe('organizer meetup rendering', () => {
  it.each([['', undefined], ['0', 0], ['500', 500]])('creates a meetup with budget input %j without treating zero as empty', async (input, expected) => {
    let saved;
    const { context, document } = organizer({
      fetch: async (_path, opts = {}) => {
        if (opts.method === 'POST') saved = JSON.parse(opts.body);
        return { ok: true, status: opts.method === 'POST' ? 201 : 200, json: async () => ({ meetups: [] }) };
      },
    });
    await vm.runInContext('meetupsView()', context);
    document.getElementById('m-title').value = 'Synthetic coffee';
    document.getElementById('m-activity').value = 'coffee';
    document.getElementById('m-budget').value = input;
    await document.getElementById('m-form').onsubmit({ preventDefault() {} });
    expect(saved).toMatchObject({ title: 'Synthetic coffee', activity: 'coffee' });
    if (expected === undefined) expect(saved).not.toHaveProperty('budget');
    else expect(saved.budget).toBe(expected);
  });

  it('escapes stored meetup areas in the planned list', () => {
    const { context } = organizer();
    context.meetup = { id: 'one', title: 'Coffee', area: attack };
    const html = vm.runInContext('meetupRow(meetup)', context);
    expect(html).toContain(escaped);
    expect(html).not.toContain(attack);
  });

  it('escapes stored meetup areas in the dashboard', async () => {
    const { context, document } = organizer({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({
        is_empty: false,
        upcoming_meetups: [{ title: 'Coffee', area: attack }],
      }) }),
    });
    await vm.runInContext('dashboardView()', context);
    expect(document.getElementById('app').innerHTML).toContain(escaped);
    expect(document.getElementById('app').innerHTML).not.toContain(attack);
  });
});

function followupRows() {
  const rows = ['alice', 'bob'].map((name) => {
    const fields = Object.fromEntries(['note', 'next', 'save', 'cancel', 'error'].map((key) => [key, { value: '', textContent: '', disabled: false }]));
    const row = { innerHTML: '', fields, querySelector: (selector) => fields[selector.match(/data-fu="([^"]+)"/)[1]] };
    return { row, button: { dataset: { done: name, name }, closest: () => row } };
  });
  const { context } = organizer({
    document: { getElementById: (id) => rows[0].row.fields[id.replace('fu-', '')] },
  });
  vm.runInContext('dashboardView = async () => {}', context);
  for (const { button } of rows) {
    context.button = button;
    vm.runInContext('markDoneForm(button)', context);
  }
  return { context, rows };
}

describe('independent follow-up forms', () => {
  it('saves the correct contact and values with two forms open', async () => {
    const { context, rows } = followupRows();
    const saved = [];
    context.fetch = async (_url, opts) => {
      saved.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({}) };
    };
    rows[0].row.fields.note.value = 'Alice note';
    rows[1].row.fields.note.value = 'Bob note';
    expect(rows[0].row.fields.save.onclick).toBeTypeOf('function');
    expect(rows[1].row.fields.save.onclick).toBeTypeOf('function');
    await rows[0].row.fields.save.onclick();
    await rows[1].row.fields.save.onclick();
    expect(saved).toEqual([
      { contact_id: 'alice', type: 'check_in', notes: 'Alice note' },
      { contact_id: 'bob', type: 'check_in', notes: 'Bob note' },
    ]);
  });

  it('shows a save error only in the corresponding form', async () => {
    const { context, rows } = followupRows();
    context.fetch = async () => { throw new Error('Offline'); };
    expect(rows[1].row.fields.save.onclick).toBeTypeOf('function');
    await rows[1].row.fields.save.onclick();
    expect(rows[1].row.fields.error.textContent).toBe('Offline');
    expect(rows[1].row.fields.save.disabled).toBe(false);
    expect(rows[0].row.fields.error.textContent).toBe('');
  });
});

describe('onboarding retries', () => {
  it('does not create duplicate contacts when saving goals fails then retries', async () => {
    const calls = [];
    let failGoals = true;
    const { context, document } = organizer({
      window: { ORGANIZER_PREFILL: { contacts: [{ name: 'Alice', category: 'personal' }] } },
      sessionStorage: { removeItem() {} },
      fetch: async (path) => {
        calls.push(path);
        if (path === '/api/me/goals' && failGoals) {
          failGoals = false;
          return { ok: false, status: 503, json: async () => ({ error: 'Retry goals' }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const goals = ['personal', 'professional', 'community'].map((category, index) => ({ dataset: { cat: category }, value: ['50', '30', '20'][index] }));
    document.querySelectorAll = (selector) => selector === '.goal-input' ? goals : [];
    vm.runInContext('onboardingView()', context);
    document.getElementById('ob-next').onclick();
    await document.getElementById('ob-confirm').onclick();
    expect(document.getElementById('ob-error').textContent).toBe('Retry goals');
    await document.getElementById('ob-confirm').onclick();
    expect(calls.filter((path) => path === '/api/me/contacts')).toHaveLength(1);
    expect(document.getElementById('app').innerHTML).toContain('1 person added - lovely! What next?');
    expect(calls.filter((path) => path === '/api/me/goals')).toHaveLength(2);
    document.getElementById('d-dash').onclick();
    expect(context.location.hash).toBe('#/dashboard');
  });
});

describe('onboarding extraction source credit', () => {
  function setup(contacts = [{ name: 'Alice', category: 'personal' }]) {
    const storage = new Map([['org_prefill', JSON.stringify({
      contacts,
      source: 'deepseek',
    })]]);
    const app = organizer({
      sessionStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    });
    vm.runInContext('onboardingView()', app.context);
    return { ...app, storage };
  }

  it.each([
    ['empty', []],
    ['duplicate-only', [{ name: 'ALICE', category: 'personal' }]],
  ])('does not credit a later %s fallback extraction', (_kind, contacts) => {
    const { context, document, storage } = setup();
    context.window.OrganizerOnboarding.apply({ contacts, source: 'rules' });
    const attribution = document.getElementById('ob-source').textContent;
    expect(attribution).toContain('understood by DeepSeek');
    expect(attribution).not.toContain('built-in rules');
    const saved = JSON.parse(storage.get('org_prefill'));
    expect(saved.sources).toEqual(['deepseek']);
    expect(saved.contacts.map((contact) => contact.name)).toEqual(['Alice']);
  });

  it('does not credit a provider whose person is dropped at the five-person cap, including Back and refresh', () => {
    const contacts = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'].map((name) => ({
      name, category: 'personal', interests: 'hiking', preferred_frequency_days: 7,
    }));
    const { context, document, storage } = setup(contacts);
    const rows = document.getElementById('ob-rows').innerHTML;
    const attribution = document.getElementById('ob-source').textContent;
    const goals = { personal: 60, professional: 25, community: 15 };
    context.window.OrganizerOnboarding.apply({ contacts: [{ name: 'Frank' }], goals, source: 'rules' });
    expect(document.getElementById('ob-source').textContent).toBe(attribution);
    expect(attribution).toContain('understood by DeepSeek');
    expect(attribution).not.toContain('built-in rules');
    expect(document.getElementById('ob-rows').innerHTML).toBe(rows);
    expect(document.getElementById('ob-error').textContent).toBe('Only the first 5 people were kept - you can add more from Contacts later.');
    const saved = JSON.parse(storage.get('org_prefill'));
    expect(saved.contacts).toEqual(contacts);
    expect(saved.sources).toEqual(['deepseek']);
    expect(saved.goals).toEqual(goals);
    document.getElementById('ob-next').onclick();
    expect(document.getElementById('app').innerHTML).toContain('data-cat="personal" min="0" max="100" value="60"');
    document.getElementById('ob-back').onclick();
    expect(document.getElementById('ob-source').textContent).toBe(attribution);
    expect(document.getElementById('ob-rows').innerHTML).toBe(rows);
    vm.runInContext('onboardingView()', context);
    expect(document.getElementById('ob-source').textContent).toBe(attribution);
    expect(document.getElementById('ob-rows').innerHTML).toBe(rows);
  });

  it('credits a provider when one of its people survives the remaining-capacity limit', () => {
    const contacts = ['Alice', 'Bob', 'Carol', 'Dan'].map((name) => ({ name }));
    const { context, document, storage } = setup(contacts);
    context.window.OrganizerOnboarding.apply({ contacts: [{ name: 'Eve' }, { name: 'Frank' }], source: 'rules' });
    expect(document.getElementById('ob-source').textContent).toContain('understood by DeepSeek + built-in rules');
    const saved = JSON.parse(storage.get('org_prefill'));
    expect(saved.sources).toEqual(['deepseek', 'rules']);
    expect(saved.contacts.map((contact) => contact.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dan', 'Eve']);
    expect(document.getElementById('ob-error').textContent).toBe('Only the first 5 people were kept - you can add more from Contacts later.');
  });

  it('keeps each contributing source once across Back and refresh', () => {
    const { context, document, storage } = setup();
    context.window.OrganizerOnboarding.apply({ contacts: [{ name: 'Bob' }], source: 'rules' });
    context.window.OrganizerOnboarding.apply({ contacts: [{ name: 'Carol' }], source: 'rules' });
    const attribution = document.getElementById('ob-source').textContent;
    expect(attribution).toContain('understood by DeepSeek + built-in rules');
    expect(JSON.parse(storage.get('org_prefill')).sources).toEqual(['deepseek', 'rules']);
    document.getElementById('ob-next').onclick();
    document.getElementById('ob-back').onclick();
    expect(document.getElementById('ob-source').textContent).toBe(attribution);
    vm.runInContext('onboardingView()', context);
    expect(document.getElementById('ob-source').textContent).toBe(attribution);
  });
});

describe('organizer navigation races', () => {
  it.each([
    ['dashboardView()', { is_empty: false }],
    ['contactsView()', { contacts: [] }],
    ["contactDetailView('alice')", { contact: { name: 'Alice' }, interactions: [] }],
    ['meetupsView()', { meetups: [{ title: 'Stale meetup' }] }],
  ])('ignores an old %s result after a newer view loads', async (view, result) => {
    let resolve;
    let request = 0;
    const pending = new Promise((done) => { resolve = done; });
    const { context, document } = organizer({
      sessionStorage: { getItem: () => null },
      fetch: async () => (++request === 1 ? pending : { ok: true, status: 200, json: async () => ({ meetups: [] }) }),
    });
    const stale = vm.runInContext(view, context);
    await vm.runInContext('meetupsView()', context);
    const latest = document.getElementById('app').innerHTML;
    resolve({ ok: true, status: 200, json: async () => result });
    await stale;
    expect(document.getElementById('app').innerHTML).toBe(latest);
  });

  it('does not replace a newer view with an old request error', async () => {
    let reject;
    let request = 0;
    const pending = new Promise((_done, fail) => { reject = fail; });
    const { context, document } = organizer({
      fetch: async () => (++request === 1 ? pending : { ok: true, status: 200, json: async () => ({ meetups: [] }) }),
    });
    const stale = vm.runInContext('dashboardView()', context);
    await vm.runInContext('meetupsView()', context);
    const latest = document.getElementById('app').innerHTML;
    reject(new Error('Old request failed'));
    await stale;
    expect(document.getElementById('app').innerHTML).toBe(latest);
  });
});


describe('latest dashboard reconciliation', () => {
  it('retains calendar events and safely renders them when a day is selected', () => {
    // Keep this rendering fixture away from the device/IST midnight boundary;
    // timezone policy itself is covered by followup-dates-ui.test.mjs.
    const today = '2026-10-25T10:00:00Z';
    const ClockDate = class extends Date { constructor(...args) { super(...(args.length ? args : [today])); } };
    const { context, document } = organizer({ Date: ClockDate });
    context.contacts = [{ name: '<img src=x onerror=alert(1)>', next_followup_at: today }];
    context.meetups = [{ title: 'Coffee meetup', starts_at: today }];
    vm.runInContext('calendarHTML(contacts, meetups); wireCalendar()', context);
    const details = document.getElementById('cal-detail').innerHTML;
    expect(details).toContain('Coffee meetup');
    expect(details).toContain(escaped);
    expect(details).not.toContain(attack);
  });

  it.each(['welcomeView()', 'onboardingView()'])(
    'ignores dashboard secondary contact results after opening %s', async (destination) => {
      let resolve;
      let requestedContacts;
      const started = new Promise((done) => { requestedContacts = done; });
      const pending = new Promise((done) => { resolve = done; });
      const { context, document } = organizer({
        fetch: async (path) => {
          if (path === '/api/me/contacts') { requestedContacts(); return pending; }
          return { ok: true, status: 200, json: async () => ({ is_empty: false }) };
        },
      });
      const stale = vm.runInContext('dashboardView()', context);
      await started;
      vm.runInContext(destination, context);
      const latest = document.getElementById('app').innerHTML;
      resolve({ ok: true, status: 200, json: async () => ({ contacts: [] }) });
      await stale;
      expect(document.getElementById('app').innerHTML).toBe(latest);
    },
  );

  it('does not navigate away after a meetup save completes on an old page', async () => {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const { context, document } = organizer({
      fetch: async (_path, opts) => opts.method === 'POST' ? pending
        : { ok: true, status: 200, json: async () => ({ meetups: [] }) },
    });
    await vm.runInContext('meetupsView()', context);
    document.getElementById('m-title').value = 'Coffee';
    const save = document.getElementById('m-form').onsubmit({ preventDefault() {} });
    vm.runInContext('welcomeView()', context);
    const latest = document.getElementById('app').innerHTML;
    resolve({ ok: true, status: 201, json: async () => ({ meetup: { title: 'Coffee' } }) });
    await save;
    expect(document.getElementById('app').innerHTML).toBe(latest);
  });
});


describe('dashboard people robustness', () => {
  it('renders malformed non-string contact names without crashing', () => {
    const { context } = organizer();
    context.contacts = [{ name: 123, category: 'personal' }, { name: 'Alice', category: 'personal' }];
    expect(vm.runInContext('peopleCard(contacts)', context)).toContain('123');
  });
});


const createForms = [
  { label: 'contact', view: 'contactsView()', form: 'add-form', button: 'add-submit', status: 'add-status', error: 'add-error', endpoint: '/api/me/contacts', fields: { 'c-name': 'Alice', 'c-cat': 'personal', 'c-freq': '14' }, result: { contacts: [] } },
  { label: 'check-in', view: "contactDetailView('alice')", form: 'log-form', button: 'log-submit', status: 'log-status', error: 'log-error', endpoint: '/api/me/interactions', fields: { 'log-note': 'Coffee together' }, result: { contact: { name: 'Alice' }, interactions: [] } },
  { label: 'meetup', view: 'meetupsView()', form: 'm-form', button: 'm-submit', status: 'm-status', error: 'm-error', endpoint: '/api/me/meetups', fields: { 'm-title': 'Coffee', 'm-activity': 'coffee' }, result: { meetups: [] } },
];
const response = (body = {}, status = 200) => ({ ok: status < 400, status, json: async () => body });
const submitEvent = () => ({ preventDefault() {} });

async function createFormSetup(spec) {
  const posts = [];
  let settle;
  const app = organizer({ fetch: async (path, opts = {}) => {
    if (opts.method !== 'POST') return response(spec.result);
    posts.push({ path, body: JSON.parse(opts.body) });
    return new Promise((resolve) => { settle = resolve; });
  } });
  await vm.runInContext(spec.view, app.context);
  const node = (id) => app.document.getElementById(id);
  for (const [id, value] of Object.entries(spec.fields)) node(id).value = value;
  const button = node(spec.button);
  button.textContent = 'Save';
  node(spec.form).controls = [...Object.keys(spec.fields).map(node), button];
  return { ...app, node, button, posts, submit: node(spec.form).onsubmit, settle: (...args) => settle(...args) };
}

describe.each(createForms)('$label creation guards', (spec) => {
  it('blocks direct repeated submissions, disables controls and announces pending work', async () => {
    const app = await createFormSetup(spec);
    const pending = app.submit(submitEvent());
    await app.submit(submitEvent());
    expect(app.posts).toHaveLength(1);
    expect(app.posts[0].path).toBe(spec.endpoint);
    expect(app.button.disabled).toBe(true);
    expect(app.node(spec.status).textContent).toMatch(/saving|creating|adding/i);
    for (const id of Object.keys(spec.fields)) expect(app.node(id).disabled).toBe(true);
    app.settle(response({}, 201));
    await pending;
  });

  it('retains entered values and permits one deliberate retry after a failed request', async () => {
    const app = await createFormSetup(spec);
    const first = app.submit(submitEvent());
    app.settle(response({ error: 'Please retry' }, 503));
    await first;
    expect(app.node(spec.error).textContent).toBe('Please retry');
    expect(app.button.disabled).toBe(false);
    expect(app.button.textContent).toBe('Save');
    expect(app.node(spec.status).textContent).toBe('');
    for (const [id, value] of Object.entries(spec.fields)) {
      expect(app.node(id).value).toBe(value);
      expect(app.node(id).disabled).toBe(false);
    }
    const retry = app.submit(submitEvent());
    await app.submit(submitEvent());
    expect(app.posts).toHaveLength(2);
    expect(app.posts[1].body).toEqual(app.posts[0].body);
    app.settle(response({}, 201));
    await retry;
  });

  it.each([201, 503])('ignores a late %s response and an old handler after navigation', async (status) => {
    const app = await createFormSetup(spec);
    const pending = app.submit(submitEvent());
    vm.runInContext('welcomeView()', app.context);
    const latest = app.node('app').innerHTML;
    app.node(spec.error).textContent = 'New view';
    app.settle(response({ error: 'Old error' }, status));
    await pending;
    await app.submit(submitEvent());
    expect(app.posts).toHaveLength(1);
    expect(app.node('app').innerHTML).toBe(latest);
    expect(app.node(spec.error).textContent).toBe('New view');
  });
});

function onboardingDraftSetup(storage = new Map(), overrides = {}) {
  const requests = [];
  const app = organizer({
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    fetch: async (path, opts) => { requests.push({ path, body: JSON.parse(opts.body) }); return response(); },
    ...overrides,
  });
  let goals = [];
  let html = '';
  Object.defineProperty(app.document.getElementById('app'), 'innerHTML', {
    get: () => html,
    set(value) {
      html = value;
      goals = [...value.matchAll(/class="goal-input" data-cat="([^"\s]+)" min="0" max="100" value="([^"]*)"/g)]
        .map((match) => ({ dataset: { cat: match[1] }, value: match[2], disabled: false }));
    },
  });
  app.document.querySelectorAll = (selector) => selector === '.goal-input' ? goals : [];
  vm.runInContext('onboardingView()', app.context);
  const node = (id) => app.document.getElementById(id);
  return { ...app, storage, node, goals: () => goals, requests };
}

describe('onboarding editable goal drafts', () => {
  it('preserves edited goals across Back, Next and refresh without saving to the API', () => {
    const app = onboardingDraftSetup();
    app.node('ob-next').onclick();
    app.goals().forEach((input, i) => { input.value = ['60', '20', '20'][i]; input.oninput(); });
    expect(app.node('goals-total').textContent).toBe(100);
    app.node('ob-back').onclick();
    app.node('ob-next').onclick();
    expect(app.goals().map((input) => input.value)).toEqual(['60', '20', '20']);
    expect(JSON.parse(app.storage.get('org_prefill')).goals).toEqual({ personal: 60, professional: 20, community: 20 });
    const refreshed = onboardingDraftSetup(app.storage);
    refreshed.node('ob-next').onclick();
    expect(refreshed.goals().map((input) => input.value)).toEqual(['60', '20', '20']);
    expect(app.requests).toEqual([]);
    expect(refreshed.requests).toEqual([]);
  });

  it('retains invalid totals as drafts but refuses to save them', async () => {
    const app = onboardingDraftSetup();
    app.node('ob-next').onclick();
    app.goals()[0].value = '60';
    app.goals()[0].oninput();
    app.node('ob-back').onclick();
    app.node('ob-next').onclick();
    await app.node('ob-confirm').onclick();
    expect(app.node('ob-error').textContent).toContain('currently 110%');
    expect(app.requests).toEqual([]);
  });

  it('blocks repeated saves and Back or Skip while saving, then restores controls after failure', async () => {
    let settle;
    let calls = 0;
    const app = onboardingDraftSetup(new Map(), { fetch: () => { calls++; return new Promise((resolve) => { settle = resolve; }); } });
    app.node('ob-next').onclick();
    const save = app.node('ob-confirm').onclick;
    const pending = save();
    await save();
    expect(calls).toBe(1);
    expect(app.node('ob-confirm').disabled).toBe(true);
    expect(app.node('ob-back').disabled).toBe(true);
    expect(app.node('ob-skip').disabled).toBe(true);
    expect(app.goals().every((input) => input.disabled)).toBe(true);
    app.node('ob-back').onclick();
    app.node('ob-skip').onclick();
    expect(app.node('app').innerHTML).toContain('Step 2 of 2');
    expect(app.context.location.hash).toBe('');
    settle(response({ error: 'Retry goals' }, 503));
    await pending;
    expect(app.node('ob-confirm').disabled).toBe(false);
    expect(app.node('ob-back').disabled).toBe(false);
    expect(app.node('ob-skip').disabled).toBe(false);
    expect(app.goals().every((input) => !input.disabled)).toBe(true);
    app.node('ob-back').onclick();
    expect(app.node('app').innerHTML).toContain('Step 1 of 2');
    await save();
    expect(calls).toBe(1);
  });

  it('does not create contacts or repaint after leaving during a goal save', async () => {
    let settle;
    const paths = [];
    const storage = new Map([['org_prefill', JSON.stringify({ contacts: [{ name: 'Alice' }] })]]);
    const app = onboardingDraftSetup(storage, { fetch: (path) => { paths.push(path); return new Promise((resolve) => { settle = resolve; }); } });
    app.node('ob-next').onclick();
    const pending = app.node('ob-confirm').onclick();
    vm.runInContext('welcomeView()', app.context);
    const latest = app.node('app').innerHTML;
    settle(response());
    await pending;
    expect(paths).toEqual(['/api/me/goals']);
    expect(app.node('app').innerHTML).toBe(latest);
    expect(storage.has('org_prefill')).toBe(true);
  });
});


it('visibly pauses check-in controls while contact details are being edited', async () => {
  const app = await createFormSetup(createForms[1]);
  app.node('c-edit').onclick();
  expect(app.button.disabled).toBe(true);
  expect(app.node('log-note').disabled).toBe(true);
  expect(app.node('log-status').textContent).toContain('Save or cancel contact edits');
  await app.submit(submitEvent());
  expect(app.posts).toHaveLength(0);
});

describe('onboarding draft edge cases', () => {
  it('keeps the newer draft when setup was originally prefilled in memory', () => {
    const app = onboardingDraftSetup(new Map(), { window: { ORGANIZER_PREFILL: { goals: { personal: 50, professional: 30, community: 20 } } } });
    app.node('ob-next').onclick();
    app.goals().forEach((input, i) => { input.value = ['60', '20', '20'][i]; input.oninput(); });
    vm.runInContext('onboardingView()', app.context);
    app.node('ob-next').onclick();
    expect(app.goals().map((input) => input.value)).toEqual(['60', '20', '20']);
    expect(app.requests).toEqual([]);
  });

  it.each([
    [['50.5', '29.5', '20']],
    [['-10', '90', '20']],
    [['', '80', '20']],
  ])('rejects invalid percentages even if the numeric total is 100: %j', async (values) => {
    const app = onboardingDraftSetup();
    app.node('ob-next').onclick();
    app.goals().forEach((input, i) => { input.value = values[i]; input.oninput(); });
    await app.node('ob-confirm').onclick();
    expect(app.node('ob-error').textContent).toContain('whole percentages between 0 and 100');
    expect(app.requests).toEqual([]);
  });

  it('retains an in-memory draft when browser storage is unavailable', () => {
    const app = onboardingDraftSetup(new Map(), { sessionStorage: { getItem: () => null, setItem() { throw new Error('Unavailable'); } } });
    app.node('ob-next').onclick();
    app.goals().forEach((input, i) => { input.value = ['60', '20', '20'][i]; input.oninput(); });
    app.node('ob-back').onclick();
    app.node('ob-next').onclick();
    expect(app.goals().map((input) => input.value)).toEqual(['60', '20', '20']);
    expect(app.requests).toEqual([]);
  });

  it('blocks repeats during contact creation and ignores its response after leaving', async () => {
    let settle;
    let started;
    const contactStarted = new Promise((resolve) => { started = resolve; });
    const paths = [];
    const storage = new Map([['org_prefill', JSON.stringify({ contacts: [{ name: 'Alice' }] })]]);
    const app = onboardingDraftSetup(storage, { fetch: (path) => {
      paths.push(path);
      if (path === '/api/me/goals') return Promise.resolve(response());
      started();
      return new Promise((resolve) => { settle = resolve; });
    } });
    app.node('ob-next').onclick();
    const submit = app.node('ob-confirm').onclick;
    const pending = submit();
    await contactStarted;
    await submit();
    expect(paths).toEqual(['/api/me/goals', '/api/me/contacts']);
    vm.runInContext('welcomeView()', app.context);
    const latest = app.node('app').innerHTML;
    settle(response());
    await pending;
    expect(app.node('app').innerHTML).toBe(latest);
    expect(storage.has('org_prefill')).toBe(true);
  });
});


const profileResults = {
  '/api/me': { user: { email: 'alice@example.test' } },
  '/api/me/dashboard': { goals: { personal: 60, professional: 20, community: 20 }, contact_counts: { personal: 2 } },
  '/api/me/interactions?limit=100': { interactions: [{ contact: { name: 'Bob' }, type: 'check_in' }] },
};

describe('profile rendering and navigation', () => {
  it('loads account details, goals and interactions without a missing navigation helper', async () => {
    const paths = [];
    const { context, document } = organizer({ fetch: async (path) => { paths.push(path); return response(profileResults[path]); } });
    await vm.runInContext('profileView()', context);
    const html = document.getElementById('app').innerHTML;
    expect(html).toContain('alice@example.test');
    expect(html).toContain('Personal</strong> · 60%');
    expect(document.getElementById('me-activity-log').innerHTML).toContain('Bob');
    expect(paths).toEqual(Object.keys(profileResults));
  });

  it('shows a retryable initial request error', async () => {
    const { context, document } = organizer({ fetch: async () => response({ error: 'Profile unavailable' }, 503) });
    await vm.runInContext('profileView()', context);
    expect(document.getElementById('app').innerHTML).toContain('Profile unavailable');
    expect(document.getElementById('retry-btn').onclick).toBeTypeOf('function');
  });

  it.each(['/api/me', '/api/me/interactions?limit=100'])(
    'does not render over navigation after a delayed %s request', async (target) => {
      let settle;
      let started;
      const waiting = new Promise((resolve) => { started = resolve; });
      const { context, document } = organizer({ fetch: (path) => {
        if (path !== target) return Promise.resolve(response(profileResults[path]));
        started();
        return new Promise((resolve) => { settle = resolve; });
      } });
      const pending = vm.runInContext('profileView()', context);
      await waiting;
      vm.runInContext('welcomeView()', context);
      const latest = document.getElementById('app').innerHTML;
      settle(response(profileResults[target]));
      await pending;
      expect(document.getElementById('app').innerHTML).toBe(latest);
    },
  );

  it.each([200, 503])('ignores a late goal-save response (%s) after navigation', async (status) => {
    let settle;
    const goals = ['60', '20', '20'].map((value, i) => ({ value, dataset: { cat: ['personal', 'professional', 'community'][i] } }));
    const { context, document } = organizer({ fetch: (path, opts = {}) => opts.method === 'PUT'
      ? new Promise((resolve) => { settle = resolve; }) : Promise.resolve(response(profileResults[path])) });
    document.querySelectorAll = (selector) => selector === '.me-goal-input' ? goals : [];
    await vm.runInContext('profileView()', context);
    document.getElementById('me-edit-goals').onclick();
    const pending = document.getElementById('me-goals-save').onclick();
    vm.runInContext('welcomeView()', context);
    const latest = document.getElementById('app').innerHTML;
    document.getElementById('me-goals-error').textContent = 'New view';
    settle(response({ error: 'Old goal error' }, status));
    await pending;
    expect(document.getElementById('app').innerHTML).toBe(latest);
    expect(document.getElementById('me-goals-error').textContent).toBe('New view');
  });

  it('guards repeated goal saves and permits retry after an explicit server failure', async () => {
    let settle;
    const writes = [];
    const goals = ['60', '20', '20'].map((value, i) => ({ value, disabled: false, dataset: { cat: ['personal', 'professional', 'community'][i] } }));
    const { context, document } = organizer({ fetch: (path, opts = {}) => {
      if (opts.method !== 'PUT') return Promise.resolve(response(profileResults[path]));
      writes.push(JSON.parse(opts.body));
      return new Promise((resolve) => { settle = resolve; });
    } });
    const node = (id) => document.getElementById(id);
    document.querySelectorAll = (selector) => selector === '.me-goal-input' ? goals : [];
    await vm.runInContext('profileView()', context);
    node('me-edit-goals').onclick();
    const save = node('me-goals-save').onclick;
    const pending = save();
    await save();
    expect(writes).toEqual([{ personal: 60, professional: 20, community: 20 }]);
    expect(node('me-goals-save').disabled).toBe(true);
    expect(node('me-goals-cancel').disabled).toBe(true);
    expect(goals.every((input) => input.disabled)).toBe(true);
    settle(response({ error: 'Retry goal save' }, 503));
    await pending;
    expect(node('me-goals-error').textContent).toBe('Retry goal save');
    expect(node('me-goals-save').disabled).toBe(false);
    expect(node('me-goals-cancel').disabled).toBe(false);
    const retry = save();
    expect(writes).toHaveLength(2);
    settle(response());
    await retry;
  });
});
