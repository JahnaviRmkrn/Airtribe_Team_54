import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../public/organizer/app.js', import.meta.url), 'utf8').replace(/\nboot\(\);\s*$/, '');
const meetup = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Coffee', activity: 'board games', area: 'Indiranagar',
  starts_at: '2026-11-01T01:30:45.123456-04:00', budget: 0, notes: 'Private note', status: 'open',
  updated_at: '2026-10-25T05:00:00.123456+00:00', room_token: 'room-token', final_venue_id: 'kept',
};
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(overrides = {}) {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) {
        let value = '';
        nodes.set(id, { innerHTML: '', textContent: '', disabled: false, hidden: false,
          get value() { return value; }, set value(next) { value = String(next); },
          addEventListener() {}, setAttribute() {}, removeAttribute() {},
          querySelectorAll() { return [...nodes].filter(([name]) => name.startsWith('me-')).map(([, node]) => node); },
          classList: { add() {}, remove() {}, toggle() {} },
        });
      }
      return nodes.get(id);
    },
    querySelectorAll: () => [],
  };
  const calls = [];
  const context = vm.createContext({ document, location: { origin: 'https://example.test', hash: '#/meetups/' + meetup.id + '/edit' }, window: {},
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    confirm: () => true,
    fetch: async (path, opts) => { calls.push({ path, opts }); return response({ meetup }); }, ...overrides,
  });
  vm.runInContext(source, context);
  context.id = meetup.id;
  const load = () => vm.runInContext('meetupEditView(id)', context);
  const submit = () => document.getElementById('me-form').onsubmit({ preventDefault() {} });
  return { context, document, calls, load, submit, node: document.getElementById };
}

describe('shipped meetup editor', () => {
  it('discovers editing only on open rows, including budget zero and safe labels', () => {
    const app = setup(); app.context.meetup = meetup;
    expect(vm.runInContext('meetupRow(meetup)', app.context)).toContain('Edit / reschedule');
    expect(vm.runInContext('meetupRow(meetup)', app.context)).toContain('₹0 per person');
    app.context.meetup = { ...meetup, status: 'closed', title: '<img onerror=alert(1)>' };
    const closed = vm.runInContext('meetupRow(meetup)', app.context);
    expect(closed).not.toContain('Edit / reschedule');
    expect(closed).not.toContain('<img');
    expect(closed).toContain('&lt;img');
  });

  it('routes direct entry and pre-fills all details, with explicit UTC and current/proposed local times', async () => {
    const app = setup(); await vm.runInContext('route()', app.context);
    expect(app.calls[0].path).toBe('/api/me/meetups/' + meetup.id);
    for (const field of ['title', 'activity', 'area', 'budget', 'notes']) expect(app.node('me-' + field).value).toBe(String(meetup[field]));
    expect(app.node('me-when').value).toBe('2026-11-01T05:30:45.123');
    const html = app.node('app').innerHTML;
    for (const label of ['Date &amp; time (UTC, optional)', 'UTC+00:00', 'Current schedule in', 'Guests are not automatically notified', 'Save changes', 'Cancel', 'Back to meetups', 'maxlength="120"', 'maxlength="40"', 'maxlength="80"', 'maxlength="2000"']) expect(html).toContain(label);
    expect(app.node('me-local-preview').textContent).toContain('Proposed schedule in');
    expect(app.node('me-local-preview').textContent).toContain('2026');
  });

  it('sends only changed fields and the exact concurrency token, preserving unchanged timestamp and zero budget', async () => {
    const app = setup(); await app.load();
    app.node('me-title').value = 'New title';
    await app.submit();
    expect(app.calls).toHaveLength(2);
    expect(app.calls[1].opts.method).toBe('PATCH');
    expect(JSON.parse(app.calls[1].opts.body)).toEqual({ title: 'New title', expected_updated_at: meetup.updated_at });
    expect(app.context.location.hash).toBe('#/meetups');
    expect(vm.runInContext('meetupNotice', app.context)).toContain('Guests are not automatically notified');
    await app.submit();
    expect(app.calls).toHaveLength(2);
  });

  it('treats an unchanged form and Cancel as no-write exits and ignores callbacks after Cancel', async () => {
    let app = setup(); await app.load(); await app.submit(); expect(app.calls).toHaveLength(1);
    expect(vm.runInContext('meetupNotice', app.context)).toBe('No meetup changes to save.');
    app = setup(); await app.load(); app.node('me-title').value = 'Unsaved'; app.node('me-cancel').onclick(); await app.submit();
    expect(app.calls).toHaveLength(1); expect(app.context.location.hash).toBe('#/meetups');
  });

  it('allows clearing all nullable fields and changing a positive budget to zero', async () => {
    const app = setup({ fetch: async () => response({ meetup: { ...meetup, budget: 100 } }) }); await app.load();
    const sent = []; app.context.fetch = async (path, opts) => { sent.push(JSON.parse(opts.body)); return response({ meetup }); };
    app.node('me-area').value = ''; app.node('me-when').value = ''; app.node('me-notes').value = ''; app.node('me-budget').value = '0';
    await app.submit();
    expect(sent).toEqual([{ area: null, notes: null, starts_at: null, budget: 0, expected_updated_at: meetup.updated_at }]);
    const emptyBudget = setup(); await emptyBudget.load(); emptyBudget.node('me-budget').value = ''; await emptyBudget.submit();
    expect(JSON.parse(emptyBudget.calls[1].opts.body)).toEqual({ budget: null, expected_updated_at: meetup.updated_at });
  });

  it('shows a proposed local equivalent and sends explicit UTC when rescheduling', async () => {
    const app = setup(); await app.load(); app.node('me-when').value = '2026-11-01T06:30'; app.node('me-when').oninput();
    expect(app.node('me-local-preview').textContent).toContain('Proposed schedule in');
    await app.submit();
    expect(JSON.parse(app.calls[1].opts.body)).toEqual({ starts_at: '2026-11-01T06:30:00.000Z', expected_updated_at: meetup.updated_at });
  });

  it.each([
    ['me-title', ''], ['me-title', 'x'.repeat(121)], ['me-activity', ''], ['me-activity', 'x'.repeat(41)],
    ['me-area', 'x'.repeat(81)], ['me-notes', 'x'.repeat(2001)], ['me-budget', '-1'], ['me-budget', '1.5'], ['me-budget', '1000001'],
    ['me-when', '2026-02-30T10:00'], ['me-when', '2026-11-01T24:00'], ['me-when', '0000-01-01T00:00'],
  ])('validates %s without any mutation', async (field, value) => {
    const app = setup(); await app.load(); app.node(field).value = value; await app.submit();
    expect(app.calls).toHaveLength(1); expect(app.node('me-error').textContent.length).toBeGreaterThan(0); expect(app.node('me-submit').disabled).toBe(false);
  });

  it('guards repeated submissions and stale pending success after Back/new navigation', async () => {
    const app = setup(); await app.load(); const pending = deferred(); let calls = 0;
    app.context.fetch = () => { calls++; return pending.promise; };
    app.node('me-title').value = 'Changed'; const save = app.submit(); await app.submit();
    expect(calls).toBe(1); expect(app.node('me-submit').disabled).toBe(true); expect(app.node('me-cancel').disabled).toBe(true);
    vm.runInContext('navGen++', app.context); app.context.location.hash = '#/contacts'; app.node('app').innerHTML = 'New screen';
    pending.resolve(response({ meetup })); await save;
    expect(app.node('app').innerHTML).toBe('New screen'); expect(app.context.location.hash).toBe('#/contacts'); expect(vm.runInContext('meetupNotice', app.context)).toBe('');
  });

  it('keeps failed input for an explicit retry and never retries automatically', async () => {
    const app = setup(); await app.load(); let calls = 0;
    app.context.fetch = async () => { if (++calls === 1) throw new Error('Offline'); return response({ meetup }); };
    app.node('me-title').value = 'Keep my changes'; await app.submit();
    expect(calls).toBe(1); expect(app.node('me-error').textContent).toBe('Offline'); expect(app.node('me-title').value).toBe('Keep my changes'); expect(app.node('me-submit').disabled).toBe(false);
    await app.submit(); expect(calls).toBe(2); expect(app.context.location.hash).toBe('#/meetups');
  });

  it('does not override a Back click when its hashchange event has not fired yet', async () => {
    const app = setup(); await app.load(); const pending = deferred();
    app.context.fetch = () => pending.promise; app.node('me-title').value = 'Changed'; const save = app.submit();
    app.context.location.hash = '#/contacts'; // No navGen change yet.
    pending.resolve(response({ meetup })); await save;
    expect(app.context.location.hash).toBe('#/contacts'); expect(vm.runInContext('meetupNotice', app.context)).toBe('');
  });

  it.each([404, 409, 410])('blocks another write after %i until explicit reload, keeping edits visible', async (status) => {
    const app = setup(); await app.load(); let calls = 0;
    app.context.fetch = async () => { calls++; return response({ error: 'Changed or closed. Reload latest details.' }, status); };
    app.node('me-title').value = 'Keep my edits'; await app.submit(); await app.submit();
    expect(calls).toBe(1); expect(app.node('me-reload').hidden).toBe(false); expect(app.node('me-title').value).toBe('Keep my edits');
    app.context.confirm = () => false; await app.node('me-reload').onclick(); expect(calls).toBe(1);
    app.context.confirm = () => true; app.context.fetch = async () => { calls++; return response({ meetup: { ...meetup, title: 'Newer title' } }); };
    await app.node('me-reload').onclick();
    expect(calls).toBe(2); expect(app.node('me-title').value).toBe('Newer title');
  });

  it('ignores a late loading response or failure after navigating away', async () => {
    for (const reject of [false, true]) {
      const request = deferred(); const app = setup({ fetch: () => request.promise }); const load = app.load();
      vm.runInContext('navGen++', app.context); app.node('app').innerHTML = 'New page';
      if (reject) request.reject(new Error('Late failure')); else request.resolve(response({ meetup }));
      await load; expect(app.node('app').innerHTML).toBe('New page');
    }
  });

  it('keeps closed rooms read-only even by direct URL', async () => {
    const app = setup({ fetch: async () => response({ meetup: { ...meetup, status: 'closed' } }) }); await app.load();
    expect(app.node('app').innerHTML).toContain('cannot be edited or reopened'); expect(app.node('app').innerHTML).not.toContain('me-form');
  });

  it('offers Retry when loading fails and redirects auth errors without rendering a fake form', async () => {
    const app = setup({ fetch: async () => response({ error: 'Unavailable' }, 503) }); await app.load();
    expect(app.node('app').innerHTML).toContain('Unavailable');
    app.context.fetch = async () => response({ meetup }); await app.node('retry-btn').onclick(); expect(app.node('app').innerHTML).toContain('me-form');
    const auth = setup({ fetch: async () => response({}, 401) }); await auth.load();
    expect(auth.context.location.href).toContain('/login?next='); expect(auth.node('app').innerHTML).not.toContain('me-form');
  });

  it('validates UTC without depending on local DST transitions or normalizing impossible dates', () => {
    const app = setup();
    for (const value of ['2026-03-08T02:30', '2026-11-01T01:30', '2028-02-29T12:00', '0001-01-01T00:00']) {
      app.context.value = value;
      expect(vm.runInContext('meetupUtcISO(value)', app.context)).toBe(value + ':00.000Z');
    }
    for (const value of ['2027-02-29T12:00', '2026-13-01T12:00', '2026-11-01T01:60', '2026-11-01T01:30:60', '2026-11-01T01:30+05:30']) {
      app.context.value = value; expect(() => vm.runInContext('meetupUtcISO(value)', app.context)).toThrow();
    }
  });
});
