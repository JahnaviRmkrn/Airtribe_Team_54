import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Execute the shipped scripts, omitting only automatic boot/polling. The DOM,
// FormData, geolocation results and HTTP responses are synthetic, not a browser
// or live permission/provider test. No external resource is fetched.
const roomSource = readFileSync(new URL('../public/room/room.js', import.meta.url), 'utf8')
  .replace(/\nif \(!TOKEN\) \{[\s\S]*$/, '');
const middleSource = readFileSync(new URL('../public/room/meet.js', import.meta.url), 'utf8');
const guest = (preferences = {}) => ({ id: 'synthetic-guest', guest_name: 'Guest', preferences, availability: [] });
const view = (preferences = {}) => ({
  meetup: { title: 'Synthetic room', status: 'open', budget: null, final_venue: null },
  me: { attendee_id: 'synthetic-guest', voted_venue_id: null }, is_organizer: false,
  attendees: [guest(preferences)], shortlist: [], votes: {}, meeting_point: { people: 0 },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function room(initialView = view(), { navigator = {}, middle = false } = {}) {
  const nodes = new Map(), requests = [], controls = [{ disabled: false }];
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        innerHTML: '', textContent: '', open: false,
        querySelectorAll: () => [], querySelector: (selector) => node(selector),
        classList: {
          contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name),
          toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        },
      });
    }
    return nodes.get(id);
  };
  const document = {
    getElementById: (id) => id === 'loc-clear' && !node('prefs-form').innerHTML.includes('id="loc-clear"') ? null : node(id),
    querySelectorAll: (selector) => selector.startsWith('#prefs-form') ? controls : [],
    createElement: (tag) => ({ tag }),
    head: { appendChild(element) { if (element.tag === 'script') queueMicrotask(() => element.onerror()); } },
  };
  let form = {};
  const context = vm.createContext({
    document, location: { pathname: '/m/synthetic-room-token-0001' }, window: {}, navigator,
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    FormData: class {
      get(key) { return form[key] ?? null; }
      getAll(key) { const value = form[key]; return value == null ? [] : Array.isArray(value) ? value : [value]; }
    },
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => initialView };
    },
  });
  if (middle) vm.runInContext(middleSource, context);
  vm.runInContext(roomSource, context);
  const run = (script) => vm.runInContext(script, context);
  context.fixtureView = initialView;
  run('view = fixtureView');
  return {
    node, requests, context, run, controls,
    form(values) { form = values; },
    save: () => run('savePrefs({ preventDefault() {} })'),
    locate: () => node('loc-btn').onclick(),
    setLocate: (locate) => { context.window.MeetMiddle = { locate, render() {} }; },
  };
}

describe('shipped guest preference form boundaries', () => {
  it.each([
    [{ budget_max: 0 }, 'up to ₹0'], [{ budget_min: 0 }, 'from ₹0'],
    [{ budget_min: 0, budget_max: 0 }, 'up to ₹0'],
  ])('shows a saved zero budget instead of an empty preference prompt: %j', (preferences, summary) => {
    const app = room(view(preferences));
    app.run('renderPrefs()');
    expect(app.node('prefs-summary').textContent).toContain(summary);
    expect(app.node('prefs-details').open).toBe(false);
  });

  it('keeps null/omitted bounds blank and submits a typed zero instead of dropping it', async () => {
    const app = room(view({ budget_min: null }));
    app.run('renderPrefs()');
    expect(app.node('prefs-summary').textContent).toContain('Tell us your area');
    expect(app.node('prefs-form').innerHTML).toContain('aria-label="Minimum budget" value=""');
    app.form({ guest_name: 'Guest', budget_min: '0', budget_max: '0', area: 'Indiranagar' });
    await app.save();
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0].body.preferences).toEqual({ budget_min: 0, budget_max: 0, area: 'Indiranagar' });
  });

  it.each([
    ['unavailable', {}, 'cannot share location'],
    ['denied', { geolocation: { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) } }, 'permission was denied'],
    ['timeout', { geolocation: { getCurrentPosition: (_ok, fail) => fail({ code: 3 }) } }, 'Could not get your location'],
  ])('keeps typed preferences usable when geolocation is %s', async (_label, navigator, message) => {
    const app = room(view(), { navigator, middle: true });
    app.run('render()');
    app.form({ guest_name: 'Typed guest', area: 'Whitefield', budget_max: '0', food: ['veg'], availability: ['Sat lunch'] });
    await app.locate();
    expect(app.node('loc-status').textContent).toContain(message);
    expect(app.node('loc-status').textContent).toContain('type your area instead');
    expect(app.controls.every((control) => !control.disabled)).toBe(true);
    await app.save();
    expect(app.requests[0].body).toEqual({ guest_name: 'Typed guest', preferences: { area: 'Whitefield', budget_max: 0, food: ['veg'] }, availability: ['Sat lunch'] });
  });

  it('keeps the middle text and typed form usable when the map library cannot load', async () => {
    const fixture = view();
    fixture.meeting_point = { people: 2, lat: 12.9, lng: 77.6, near: 'Indiranagar', max_km: 5, avg_km: 3, pins: [] };
    const app = room(fixture, { middle: true });
    app.run('render()');
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.node('.meet-map').classList.contains('hidden')).toBe(true);
    expect(app.node('.meet-body').innerHTML).toContain('The middle is near');
    expect(app.controls.every((control) => !control.disabled)).toBe(true);
    app.form({ guest_name: 'Map-free guest', area: 'Whitefield' });
    await app.save();
    expect(app.requests[0].body.preferences).toEqual({ area: 'Whitefield' });
  });

  it('does not let a late location result undo an explicit Stop sharing', async () => {
    const app = room(view({ location: { label: 'Shared location' } }));
    const pending = deferred();
    app.setLocate(() => pending.promise);
    app.run('renderPrefs()');
    const locating = app.locate();
    app.node('loc-clear').onclick();
    pending.resolve({ lat: 12.971, lng: 77.641 });
    await locating;
    expect(app.node('loc-status').textContent).toBe('Location will be removed when you save.');
    app.form({ guest_name: 'Guest', area: 'Indiranagar' });
    await app.save();
    expect(app.requests[0].body.preferences.location).toBeNull();
  });

  it('does not carry a late location result into a new form after saving typed preferences', async () => {
    const app = room(view());
    const pending = deferred();
    app.setLocate(() => pending.promise);
    app.run('renderPrefs()');
    const locating = app.locate();
    app.form({ guest_name: 'Guest', area: 'Indiranagar' });
    await app.save();
    pending.resolve({ lat: 12.971, lng: 77.641 });
    await locating;
    app.form({ guest_name: 'Guest', area: 'Whitefield' });
    await app.save();
    expect(app.requests.map((request) => request.body.preferences)).toEqual([{ area: 'Indiranagar' }, { area: 'Whitefield' }]);
  });

  it('uses only the latest location request and shares it only on Save', async () => {
    const app = room(view());
    const first = deferred(), second = deferred();
    let calls = 0;
    app.setLocate(() => (++calls === 1 ? first.promise : second.promise));
    app.run('renderPrefs()');
    expect(calls).toBe(0);
    const earlier = app.locate(), latest = app.locate();
    second.resolve({ lat: 12.981, lng: 77.651 });
    await latest;
    first.resolve({ lat: 12.971, lng: 77.641 });
    await earlier;
    expect(app.requests).toEqual([]);
    app.form({ guest_name: 'Guest' });
    await app.save();
    expect(app.requests[0].body.preferences.location).toEqual({ lat: 12.981, lng: 77.651, label: 'Shared location' });
  });

  it.each(['closed', 'missing', 'different guest'])('discards a pending location after the room becomes %s', async (state) => {
    const app = room(view());
    const pending = deferred();
    app.setLocate(() => pending.promise);
    app.run('renderPrefs()');
    const locating = app.locate();
    if (state === 'closed') app.run("view.meetup.status = 'closed'; render()");
    else if (state === 'missing') app.run('renderMissing()');
    else app.run("view.me.attendee_id = 'other-synthetic-guest'; renderPrefs()");
    pending.resolve({ lat: 12.971, lng: 77.641 });
    await locating;
    expect(app.run('pendingLocation')).toBeUndefined();
    expect(app.requests).toEqual([]);
    if (state === 'closed') expect(app.controls.every((control) => control.disabled)).toBe(true);
  });
});
