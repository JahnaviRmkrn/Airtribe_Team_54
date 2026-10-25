import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the shipped browser script without starting its automatic boot request.
const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8')
  .replace(/\nboot\(\);\s*$/, '');

function organizer(overrides = {}) {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { innerHTML: '', value: '', addEventListener() {}, classList: { remove() {}, toggle() {} } });
      return nodes.get(id);
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document,
    location: { origin: 'https://example.test', hash: '' },
    window: {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {} },
    ...overrides,
  });
  vm.runInContext(source, context);
  return { context, document };
}

const attack = '<img src=x onerror=alert(1)>';
const escaped = '&lt;img src=x onerror=alert(1)&gt;';

describe('organizer meetup rendering', () => {
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
      localStorage: { setItem() {} },
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
    const { context, document } = organizer();
    const today = new Date().toISOString();
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
