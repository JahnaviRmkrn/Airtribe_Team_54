import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const liveSource = readFileSync(new URL('../public/organizer/live.js', import.meta.url), 'utf8');
const planSource = readFileSync(new URL('../public/organizer/plan-voice.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
function liveHarness(options = {}) {
  const sockets = [], contexts = [];
  const tracks = [{ stop: vi.fn() }];
  const getUserMedia = vi.fn(options.getUserMedia || (async () => ({ getTracks: () => tracks })));
  class AudioContext {
    constructor() { this.close = vi.fn(async () => {}); this.audioWorklet = { addModule: vi.fn(options.addModule || (async () => {})) }; contexts.push(this); }
    createMediaStreamSource() { return { connect: vi.fn() }; }
  }
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.send = vi.fn(); this.close = vi.fn(() => { this.readyState = 3; }); sockets.push(this); }
  }
  const bodyNodes = [];
  const window = options.fab ? { Assistant: { tools: [], context: () => '', call: vi.fn(async () => ({ ok: true })) } } : {};
  const document = { readyState: 'complete', getElementById: (id) => bodyNodes.find((n) => n.id === id), createElement: node, body: { append: (...items) => bodyNodes.push(...items) } };
  const fetch = vi.fn(options.fetch || (async () => response({ token: 'synthetic', model: 'synthetic', voice: 'synthetic' })));
  vm.runInNewContext(liveSource, { window, document, navigator: { mediaDevices: { getUserMedia } }, location: { origin: 'https://example.test' }, URL, fetch, AudioContext, AudioWorkletNode: class { port = {}; }, WebSocket: Socket, AbortController, setTimeout, clearTimeout });
  const packet = (data) => sockets[0].onmessage({ data: JSON.stringify(data) });
  return { window, fetch, sockets, contexts, tracks, getUserMedia, packet, fab: () => document.getElementById('voice-fab') };
}
const toolPacket = (ids = ['a']) => ({ toolCall: { functionCalls: ids.map((id) => ({ id, name: 'create_meetup', args: { title: 'Brunch' } })) } });

describe('shipped Gemini Live tool lifecycle with synthetic transport', () => {
  it('lets a second floating-mic tap cancel pending startup without creating another session', async () => {
    const pending = deferred(); const h = liveHarness({ fab: true, fetch: () => pending.promise });
    const first = h.fab().onclick(); const second = h.fab().onclick();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response({ token: 'synthetic', model: 'synthetic' })); await Promise.all([first, second]);
    expect(h.getUserMedia).not.toHaveBeenCalled(); expect(h.sockets).toHaveLength(0);
  });
  it('reuses the result of a repeated tool-call ID instead of executing it twice', async () => {
    const h = liveHarness(); const waiting = deferred(); const onToolCall = vi.fn(() => waiting.promise);
    const session = await h.window.LiveVoice.start({ onToolCall });
    const first = h.packet(toolPacket()); const duplicate = h.packet(toolPacket()); await flush();
    expect(onToolCall).toHaveBeenCalledTimes(1);
    waiting.resolve({ ok: true }); await Promise.all([first, duplicate]); session.stop();
  });
  it('does not run later calls in a batch after the user stops during the first call', async () => {
    const h = liveHarness(); const waiting = deferred(); const onToolCall = vi.fn(() => waiting.promise);
    const session = await h.window.LiveVoice.start({ onToolCall });
    const pending = h.packet(toolPacket(['a', 'b'])); await flush(); session.stop(); waiting.resolve({ ok: true }); await pending;
    expect(onToolCall).toHaveBeenCalledTimes(1);
  });
  it('ignores tool messages delivered after stop, including asynchronously decoded messages', async () => {
    const h = liveHarness(); const onToolCall = vi.fn(); const session = await h.window.LiveVoice.start({ onToolCall });
    const raw = deferred(); const pending = h.sockets[0].onmessage({ data: { text: () => raw.promise } });
    session.stop(); raw.resolve(JSON.stringify(toolPacket())); await pending; await h.packet(toolPacket(['b']));
    expect(onToolCall).not.toHaveBeenCalled();
  });
  it('aborts a canceled tool signal and skips its queued work', async () => {
    const h = liveHarness(); const waiting = deferred(); let receivedSignal;
    const onToolCall = vi.fn((_name, _args, context) => { receivedSignal = context?.signal; return waiting.promise; });
    const session = await h.window.LiveVoice.start({ onToolCall });
    const pending = h.packet(toolPacket()); await flush(); await h.packet({ toolCallCancellation: { ids: ['a'] } });
    expect(receivedSignal?.aborted).toBe(true);
    waiting.resolve({ cancelled: true }); await pending; session.stop();
  });
  it('does not run another tool after an uncertain mutation outcome', async () => {
    const h = liveHarness(); const onToolCall = vi.fn(async () => ({ error: 'Unknown outcome', uncertain: true }));
    const session = await h.window.LiveVoice.start({ onToolCall });
    await h.packet(toolPacket(['a', 'b'])); await h.packet(toolPacket(['c']));
    expect(onToolCall).toHaveBeenCalledTimes(1); session.stop();
  });
  it('releases the microphone and audio contexts if worklet startup fails', async () => {
    const h = liveHarness({ addModule: async () => { throw new Error('Worklet unavailable'); } });
    await expect(h.window.LiveVoice.start({})).rejects.toThrow('Worklet unavailable');
    expect(h.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(h.contexts.every((c) => c.close.mock.calls.length === 1)).toBe(true);
    expect(h.sockets).toHaveLength(0);
  });
  it('honors cancellation while the token is loading without opening a microphone', async () => {
    const pending = deferred(); const h = liveHarness({ fetch: () => pending.promise }); const controller = new AbortController();
    const started = h.window.LiveVoice.start({ signal: controller.signal }); controller.abort();
    pending.resolve(response({ token: 'synthetic', model: 'synthetic' }));
    await expect(started).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.getUserMedia).not.toHaveBeenCalled();
  });
});

function node() {
  const classes = new Set(['hidden']), children = new Map();
  return { innerHTML: '', textContent: '', value: '', dataset: {}, children: [], appendChild: vi.fn(), setAttribute: vi.fn(),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    querySelector(s) { if (!children.has(s)) children.set(s, node()); return children.get(s); }, querySelectorAll: () => [],
  };
}
function planHarness(options = {}) {
  const root = node(); const events = new Map(); const sessions = []; let callbacks;
  const start = vi.fn(async (opts) => { callbacks = opts; const session = { stop: vi.fn() }; sessions.push(session); return options.start ? options.start(session) : session; });
  const window = { LiveVoice: { start }, addEventListener: (type, fn) => events.set(type, fn), removeEventListener: vi.fn() };
  const fetch = vi.fn(options.fetch || (async () => response({ meetup: { title: 'Brunch', room_url: 'https://example.test/m/synthetic' } })));
  const onCreated = vi.fn();
  vm.runInNewContext(planSource, { window, document: { createElement: node }, navigator: {}, fetch, AbortController, setTimeout, clearTimeout });
  const plan = window.PlanByVoice.mount(root, { onCreated });
  const get = (key) => root.querySelector('[data-pv="' + key + '"]');
  return { plan, root, get, start, fetch, sessions, onCreated, callbacks: () => callbacks, click: () => get('mic').onclick(), leave: () => events.get('hashchange')() };
}
const args = { title: 'Brunch', activity: 'brunch', summary: 'A meal together', share_message: 'Join us for brunch' };
describe('shipped voice meetup planning lifecycle', () => {
  it('shows a current connection failure even when the transport ended first', async () => {
    const h = planHarness(); await h.click(); h.callbacks().onState('ended'); h.callbacks().onError('Synthetic connection failed');
    expect(h.get('err').textContent).toContain('Synthetic connection failed');
  });
  it('does not launch two voice sessions on repeated startup taps', async () => {
    const waiting = deferred(); const h = planHarness({ start: () => waiting.promise });
    const first = h.click(); const second = h.click(); expect(h.start).toHaveBeenCalledTimes(1);
    waiting.resolve({ stop: vi.fn() }); await Promise.all([first, second]);
  });
  it('stops a late-starting session after navigation and ignores its tools', async () => {
    const waiting = deferred(); const late = { stop: vi.fn() }; const h = planHarness({ start: () => waiting.promise });
    const started = h.click(); h.leave(); waiting.resolve(late); await started;
    expect(late.stop).toHaveBeenCalledTimes(1);
    expect((await h.callbacks().onToolCall('save_meetup_plan', args)).error).toMatch(/cancel|ended/i);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('makes only one creation request for duplicate save calls', async () => {
    const waiting = deferred(); const h = planHarness({ fetch: () => waiting.promise }); await h.click();
    const first = h.callbacks().onToolCall('save_meetup_plan', args); const duplicate = h.callbacks().onToolCall('save_meetup_plan', args);
    expect(h.fetch).toHaveBeenCalledTimes(1); waiting.resolve(response({ meetup: { title: 'Brunch', room_url: 'https://example.test/m/synthetic' } }));
    await Promise.all([first, duplicate]); expect(h.onCreated).toHaveBeenCalledTimes(1);
  });
  it('keeps an unknown creation outcome locked against automatic retry', async () => {
    const h = planHarness({ fetch: async () => { throw new Error('Lost response'); } }); await h.click();
    const first = await h.callbacks().onToolCall('save_meetup_plan', args).catch((error) => ({ error: error.message }));
    const retry = await h.callbacks().onToolCall('save_meetup_plan', args).catch((error) => ({ error: error.message }));
    expect(first.uncertain).toBe(true); expect(retry.uncertain).toBe(true); expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.get('err').textContent).toMatch(/unknown|check/i);
  });
  it('does not publish a late save result over a page the user left', async () => {
    const waiting = deferred(); const h = planHarness({ fetch: () => waiting.promise }); await h.click();
    const saving = h.callbacks().onToolCall('save_meetup_plan', args); h.leave(); const before = h.get('result').innerHTML;
    waiting.resolve(response({ meetup: { title: 'Brunch', room_url: 'https://example.test/m/synthetic' } })); await saving;
    expect(h.onCreated).not.toHaveBeenCalled(); expect(h.get('result').innerHTML).toBe(before);
  });
});
