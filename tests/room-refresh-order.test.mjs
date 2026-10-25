import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Run shipped request/mutation functions with only rendering replaced. Deferred
// transport responses intentionally resolve out of order; no server/browser.
const source = readFileSync(new URL('../public/room/room.js', import.meta.url), 'utf8')
  .replace(/\nif \(!TOKEN\) \{[\s\S]*$/, '');
const state = (status = 'open', finalVenue = null) => ({ meetup: { status, final_venue: finalVenue }, is_organizer: true });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function setup() {
  // Build a complete fixture before applying the tiny renderer substitutions.
  const nodes = new Map(), requests = [], rendered = [], toasts = [], timers = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      nodes.set(id, { textContent: '', innerHTML: '', classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      } });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: node }, location: { pathname: '/m/synthetic-refresh-room-001' }, window: {},
    AbortController,
    setTimeout(fn, milliseconds) { const id = Symbol(); timers.set(id, { fn, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); }, clearInterval() {},
    fetch(url, options) { const r = deferred(); requests.push({ ...r, url, options }); return r.promise; },
    recordRender: (value) => rendered.push(value), recordToast: (msg) => toasts.push(msg), initial: state(),
  });
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  run('view = initial; render = () => recordRender(view); toast = (msg) => recordToast(msg);');
  const respond = (index, data = state(), status = 200) => requests[index].resolve({ ok: status < 400, status, json: async () => data });
  return { context, run, node, requests, rendered, toasts, respond, timers };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('room request ordering', () => {
  it.each(['closed', 'confirmed'])('does not let an earlier GET undo a %s mutation', async (kind) => {
    const a = setup(), old = a.run('refresh()');
    a.context.next = kind === 'closed' ? state('closed') : state('open', { id: 'venue-a' });
    expect(await a.run('act(async () => next)')).toBe(true);
    a.respond(0); await old;
    expect(a.run('view')).toEqual(a.context.next);
    expect(a.rendered).toHaveLength(1);
  });
  it('coalesces repeated polls while a slow GET is pending instead of starving it', async () => {
    const a = setup(), old = a.run('refresh()');
    const polls = Array.from({ length: 5 }, () => a.run('refresh()'));
    expect(a.requests).toHaveLength(1);
    a.respond(0, state('closed')); await Promise.all([old, ...polls]);
    expect(a.run('view.meetup.status')).toBe('closed');
    expect(a.rendered).toHaveLength(1);
    const next = a.run('refresh()'); expect(a.requests).toHaveLength(2);
    a.respond(1, state('closed')); await next; expect(a.rendered).toHaveLength(2);
  });
  it('times out a never-settling GET, aborts transport and permits the next poll', async () => {
    const a = setup(), stuck = a.run('refresh()');
    const duplicate = a.run('refresh()'); expect(a.requests).toHaveLength(1);
    expect([...a.timers.values()].map((t) => t.milliseconds)).toEqual([15_000]);
    [...a.timers.values()][0].fn(); await Promise.all([stuck, duplicate]);
    expect(a.requests[0].options.signal.aborted).toBe(true);
    expect(a.node('conn').classList.contains('hidden')).toBe(false);
    expect(a.timers.size).toBe(0);
    const next = a.run('refresh()'); a.respond(1, state('closed')); await next;
    expect(a.run('view.meetup.status')).toBe('closed');
    expect(a.node('conn').classList.contains('hidden')).toBe(true);
    a.respond(0); await tick(); // Deliberately ignore AbortSignal in fake transport.
    expect(a.run('view.meetup.status')).toBe('closed');
    expect(a.rendered).toHaveLength(1); expect(a.timers.size).toBe(0);
  });
  it('a stale read timeout cannot change a newer view or remove its in-flight read', async () => {
    const a = setup(), old = a.run('refresh()');
    const oldTimer = [...a.timers.values()][0];
    a.context.next = state('closed'); await a.run('act(async () => next)');
    const fresh = a.run('refresh()'); oldTimer.fn(); await old;
    const same = a.run('refresh()'); expect(a.requests).toHaveLength(2);
    expect(a.node('conn').classList.contains('hidden')).toBe(true);
    a.respond(1, state('closed')); await Promise.all([fresh, same]);
    expect(a.run('view.meetup.status')).toBe('closed'); expect(a.timers.size).toBe(0);
  });
  it.each([404, 503])('ignores a pre-mutation %i after a newer authoritative read', async (status) => {
    const a = setup(), old = a.run('refresh()');
    a.context.next = state('closed'); await a.run('act(async () => next)');
    const fresh = a.run('refresh()');
    a.respond(1, state('closed')); await fresh;
    a.respond(0, { error: 'stale error' }, status); await old;
    expect(a.run('view.meetup.status')).toBe('closed');
    expect(a.node('main').innerHTML).toBe('');
    expect(a.node('conn').classList.contains('hidden')).toBe(true);
  });
  it('does not let completion of an invalidated read clear the newer in-flight read', async () => {
    const a = setup(), old = a.run('refresh()');
    a.context.next = state('closed'); await a.run('act(async () => next)');
    const fresh = a.run('refresh()');
    a.respond(0); await old;
    const coalesced = a.run('refresh()'); expect(a.requests).toHaveLength(2);
    a.respond(1, state('closed')); await Promise.all([fresh, coalesced]);
    expect(a.run('view.meetup.status')).toBe('closed');
  });
  it('suppresses visibility/direct refresh while a mutation is pending', async () => {
    const a = setup(), pending = deferred(); a.context.pending = pending.promise;
    const action = a.run('act(() => pending)');
    await a.run('refresh()'); expect(a.requests).toHaveLength(0);
    pending.resolve(state('closed')); await action;
    const fresh = a.run('refresh()'); expect(a.requests).toHaveLength(1);
    a.respond(0, state('closed')); await fresh;
  });
  it.each([401, 409, 410, 429])('performs a recovery GET after releasing a failed %i mutation', async (status) => {
    const a = setup(); a.context.failure = Object.assign(new Error('changed'), { status });
    const action = a.run('act(async () => { throw failure; })'); await tick();
    expect(a.requests).toHaveLength(1);
    a.respond(0, state('closed')); expect(await action).toBe(false); await tick();
    expect(a.run('view.meetup.status')).toBe('closed');
    expect(a.run('busy')).toBe(false);
  });
  it('does not leave a failed action pending while its recovery GET is unresolved', async () => {
    const a = setup(); a.context.failure = Object.assign(new Error('changed'), { status: 409 });
    expect(await a.run('act(async () => { throw failure; })')).toBe(false);
    expect(a.run('busy')).toBe(false); expect(a.requests).toHaveLength(1);
    a.respond(0); await tick();
  });
  it('does not replay a failed mutation or refresh automatically on transport errors', async () => {
    const a = setup();
    expect(await a.run('act(async () => { throw new Error("network"); })')).toBe(false);
    expect(a.requests).toHaveLength(0); expect(a.toasts).toEqual(['network']);
    const read = a.run('refresh()'); a.respond(0, state()); await read;
    expect(a.rendered).toHaveLength(1);
  });
  it('a current missing room invalidates other responses and disables further polling/actions', async () => {
    const a = setup(), old = a.run('refresh()');
    a.context.next = state(); await a.run('act(async () => next)');
    const fresh = a.run('refresh()');
    a.respond(1, { error: 'missing' }, 404); await fresh;
    a.respond(0); await old;
    expect(a.run('view')).toBe(null);
    expect(a.node('main').innerHTML).toContain("This room link isn't valid");
    await a.run('refresh()'); expect(await a.run('act(async () => initial)')).toBe(false);
    expect(a.requests).toHaveLength(2); expect(a.rendered).toHaveLength(1);
  });
  it('a mutation 404 suppresses its pre-existing poll', async () => {
    const a = setup(), old = a.run('refresh()');
    a.context.failure = Object.assign(new Error('missing'), { status: 404 });
    expect(await a.run('act(async () => { throw failure; })')).toBe(false);
    a.respond(0); await old;
    expect(a.run('view')).toBe(null); expect(a.rendered).toHaveLength(0);
  });
  it('direct voice send invalidates old polls and suppresses new polls while pending', async () => {
    const a = setup(), old = a.run('refresh()'), send = a.run('send("PATCH", "/me", {})');
    await a.run('refresh()'); expect(a.requests).toHaveLength(2);
    a.respond(1, state('closed')); await send;
    a.respond(0); await old; expect(a.rendered).toHaveLength(0);
    const fresh = a.run('refresh()'); a.respond(2, state('closed')); await fresh;
    expect(a.run('view.meetup.status')).toBe('closed');
  });
  it('failed direct send releases polling without retrying the write', async () => {
    const a = setup(), send = a.run('send("PATCH", "/me", {})');
    a.respond(0, { error: 'failed' }, 503); await expect(send).rejects.toThrow('failed');
    const fresh = a.run('refresh()'); a.respond(1); await fresh;
    expect(a.requests.map((r) => r.options.method ?? 'GET')).toEqual(['PATCH', 'GET']);
  });
  it('ignores refresh and mutation responses after navigation to another room', async () => {
    const a = setup(), old = a.run('refresh()');
    a.context.location.pathname = '/m/another-synthetic-room-001';
    a.respond(0, state('closed')); await old; expect(a.rendered).toHaveLength(0);
    const pending = deferred(); a.context.pending = pending.promise;
    const action = a.run('act(() => pending, "saved")');
    a.context.location.pathname = '/elsewhere'; pending.resolve(state('closed'));
    expect(await action).toBe(false); expect(a.rendered).toHaveLength(0); expect(a.toasts).toHaveLength(0);
  });
});
