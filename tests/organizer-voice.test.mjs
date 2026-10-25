import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Run the actual browser assets, with synthetic providers and microphone only.
const liveSource = readFileSync(new URL('../public/organizer/live.js', import.meta.url), 'utf8');
const voiceSource = readFileSync(new URL('../public/organizer/voice.js', import.meta.url), 'utf8');
const voiceAssets = JSON.parse(readFileSync(new URL('../public/vendor/voice-assets.json', import.meta.url), 'utf8'));
const unavailable = () => ({ ok: false, status: 503, json: async () => ({ error: 'Not configured' }) });
const denied = () => Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const microphone = () => {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { tracks, getTracks: () => tracks };
};

function widget(options = {}) {
  const nodes = new Map();
  const element = () => {
    const classes = new Set(['hidden']);
    return { textContent: '', value: '', disabled: false, open: false, dataset: {}, children: [],
      appendChild(child) { this.children.push(child); },
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    };
  };
  const root = { innerHTML: '', querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  } };
  const timers = new Map();
  let nextTimer = 0;
  const events = new Map();
  const recorders = [];
  class Recorder {
    static isTypeSupported() {
      if (options.recorderFailure === 'type') throw new Error('Recording format unavailable');
      return true;
    }
    constructor(stream) {
      if (options.recorderFailure === 'constructor') throw new Error('Recording unavailable');
      this.stream = stream;
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
      this.start = vi.fn(() => {
        if (options.recorderFailure === 'start') throw new Error('Recording could not start');
        this.state = 'recording';
      });
      this.stop = vi.fn(() => {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['synthetic audio']) });
        this.onstop?.();
      });
      recorders.push(this);
    }
  }
  const getUserMedia = vi.fn(options.getUserMedia || (async () => { throw denied(); }));
  const extraction = { contacts: [{ name: 'Alice', category: 'personal' }], goals: { personal: 50, professional: 30, community: 20 }, source: 'rules', saved: false };
  const fetch = vi.fn(async (url, request) => {
    const path = new URL(url, 'https://example.test').pathname;
    if (options.fetch) {
      const response = options.fetch(path, request);
      if (response !== undefined) return response;
    }
    if (path === '/api/voice/live-token' || path === '/api/voice/signed-url') return unavailable();
    if (path === '/api/voice/transcribe') return { ok: true, status: 200, json: async () => ({ transcript: 'Call Alice weekly' }) };
    if (path === '/api/extract') return { ok: true, status: 200, json: async () => extraction };
    throw new Error('Unexpected request: ' + path);
  });
  const window = {
    MediaRecorder: options.noRecorder ? undefined : Recorder,
    addEventListener: (name, fn) => events.set(name, fn),
    ElevenLabsClient: options.sdk,
  };
  const scripts = [];
  const context = vm.createContext({
    window, MediaRecorder: window.MediaRecorder,
    navigator: { mediaDevices: options.noMediaDevices ? undefined : options.noGetUserMedia ? {} : { getUserMedia } },
    document: { readyState: 'complete', createElement: () => ({ ...element(), remove: vi.fn() }), head: { appendChild(script) {
      scripts.push(script);
      if (options.loadSdk) options.loadSdk(script, window);
      else throw new Error('Unexpected SDK load');
    } } },
    location: { origin: 'https://example.test', href: '' },
    URL, Blob, fetch,
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(liveSource, context);
  vm.runInContext(voiceSource, context);
  const onResult = vi.fn();
  const voice = window.Voice.mount(root, onResult);
  const node = (key) => root.querySelector('[data-vx="' + key + '"]');
  return { voice, window, node, scripts, box: root.querySelector('.vx'), getUserMedia, recorders, timers, fetch, extraction, onResult,
    click: () => node('orb').onclick(), leave: () => events.get('hashchange')(),
    paths: () => fetch.mock.calls.map(([url]) => new URL(url, 'https://example.test').pathname),
  };
}

describe('organizer recording fallback recovery', () => {
  it('handles denied microphone access after both provider 503s and keeps typed extraction working', async () => {
    const app = widget();
    await expect(app.click()).resolves.toBeUndefined();
    expect(app.paths()).toEqual(['/api/voice/live-token', '/api/voice/signed-url']);
    expect(app.getUserMedia).toHaveBeenCalledTimes(1);
    expect(app.box.dataset.mode).toBe('idle');
    expect(app.node('label').textContent).toBe('Tap to talk');
    expect(app.node('err').textContent).toBe('Microphone permission was denied.');
    expect(app.node('fallback').open).toBe(true);
    expect(app.node('orb').disabled).toBe(false);
    expect(app.node('end').classList.contains('hidden')).toBe(true);
    app.node('text').value = 'Call Alice weekly';
    await app.node('extract').onclick();
    expect(app.onResult).toHaveBeenCalledWith(app.extraction);
    expect(app.paths()).toEqual(['/api/voice/live-token', '/api/voice/signed-url', '/api/extract']);
    expect(JSON.parse(app.fetch.mock.calls.at(-1)[1].body)).toEqual({ transcript: 'Call Alice weekly' });
    expect(app.node('extract').disabled).toBe(false);
  });

  it('can retry after denial, record, then transcribe and extract without saving', async () => {
    const stream = microphone();
    let attempts = 0;
    const app = widget({ getUserMedia: async () => { if (++attempts === 1) throw denied(); return stream; } });
    try {
      await expect(app.click()).resolves.toBeUndefined();
      await expect(app.click()).resolves.toBeUndefined();
      expect(app.getUserMedia).toHaveBeenCalledTimes(2);
      expect(app.box.dataset.mode).toBe('live');
      expect(app.node('err').textContent).toBe('');
      expect(app.node('end').classList.contains('hidden')).toBe(false);
      await app.node('end').onclick();
      await flush();
      expect(app.onResult).toHaveBeenCalledWith(app.extraction);
      expect(app.paths().slice(-2)).toEqual(['/api/voice/transcribe', '/api/extract']);
      expect(app.timers.size).toBe(0);
      for (const track of stream.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    } finally { app.voice.stop(); }
  });

  it.each(['noRecorder', 'noMediaDevices', 'noGetUserMedia'])('opens typing when %s prevents recording', async (capability) => {
    const app = widget({ [capability]: true });
    await expect(app.click()).resolves.toBeUndefined();
    expect(app.box.dataset.mode).toBe('off');
    expect(app.node('err').textContent).toBe('This browser cannot record audio.');
    expect(app.node('orb').disabled).toBe(true);
    expect(app.node('fallback').open).toBe(true);
    expect(app.getUserMedia).not.toHaveBeenCalled();
  });

  it.each(['type', 'constructor', 'start'])('releases every microphone track when recorder %s fails', async (recorderFailure) => {
    const stream = microphone();
    const app = widget({ recorderFailure, getUserMedia: async () => stream });
    await expect(app.click()).resolves.toBeUndefined();
    expect(app.box.dataset.mode).toBe('idle');
    expect(app.node('fallback').open).toBe(true);
    expect(app.node('err').textContent).toMatch(/Recording/);
    expect(app.timers.size).toBe(0);
    expect(app.paths()).not.toContain('/api/voice/transcribe');
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    for (const recorder of app.recorders) {
      expect(recorder.onstop).toBeNull();
      expect(recorder.ondataavailable).toBeNull();
    }
  });

  it('ignores repeated taps while recording startup is pending', async () => {
    const pending = deferred();
    const stream = microphone();
    const app = widget({ getUserMedia: () => pending.promise });
    const first = app.click();
    await flush();
    const second = app.click();
    await flush();
    const attempts = app.getUserMedia.mock.calls.length;
    pending.resolve(stream);
    await Promise.all([first, second]);
    try {
      expect(attempts).toBe(1);
      expect(app.recorders).toHaveLength(1);
      expect(app.timers.size).toBe(1);
    } finally { app.voice.stop(); }
    expect(app.timers.size).toBe(0);
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(app.paths()).not.toContain('/api/voice/transcribe');
  });
});

describe('leaving during recording fallback startup', () => {
  it.each(['live-token', 'signed-url'])('does not continue past a pending %s request after stop', async (endpoint) => {
    const pending = deferred();
    const app = widget({ fetch: (path) => path === '/api/voice/' + endpoint ? pending.promise : undefined });
    const started = app.click();
    await flush();
    app.voice.stop();
    const pathsBeforeStop = app.paths();
    pending.resolve(unavailable());
    await expect(started).resolves.toBeUndefined();
    expect(app.paths()).toEqual(pathsBeforeStop);
    expect(app.getUserMedia).not.toHaveBeenCalled();
    expect(app.node('fallback').open).toBe(false);
    expect(app.node('err').textContent).toBe('');
    await app.click();
    expect(app.paths()).toEqual(pathsBeforeStop);
  });

  it.each(['stop', 'hashchange'])('drops and releases a late microphone stream after %s', async (action) => {
    const pending = deferred();
    const stream = microphone();
    const app = widget({ getUserMedia: () => pending.promise });
    const started = app.click();
    await flush();
    if (action === 'stop') app.voice.stop(); else app.leave();
    pending.resolve(stream);
    await expect(started).resolves.toBeUndefined();
    expect(app.recorders).toHaveLength(0);
    expect(app.timers.size).toBe(0);
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(app.paths()).not.toContain('/api/voice/transcribe');
  });

  it.each(['stop', 'hashchange'])('handles a late microphone denial after %s without changing the abandoned widget', async (action) => {
    const pending = deferred();
    const app = widget({ getUserMedia: () => pending.promise });
    const started = app.click();
    await flush();
    if (action === 'stop') app.voice.stop(); else app.leave();
    const oldStatus = app.node('status').textContent;
    pending.reject(denied());
    await expect(started).resolves.toBeUndefined();
    expect(app.node('status').textContent).toBe(oldStatus);
    expect(app.node('fallback').open).toBe(false);
    expect(app.node('err').textContent).toBe('');
    expect(app.recorders).toHaveLength(0);
    expect(app.timers.size).toBe(0);
  });
});

describe('ElevenLabs strict-CSP startup and recovery', () => {
  const signedUrl = 'wss://synthetic.elevenlabs.io/conversation?token=mock';
  const signed = (path) => path === '/api/voice/signed-url'
    ? { ok: true, status: 200, json: async () => ({ signed_url: signedUrl }) } : undefined;
  const expectedWorklets = {
    rawAudioProcessor: '/vendor/elevenlabs/1.27.0/rawAudioProcessor.js',
    audioConcatProcessor: '/vendor/elevenlabs/1.27.0/audioConcatProcessor.js',
  };

  it('lazily loads the pinned SRI SDK and passes both same-origin worklets plus the conditional resampler', async () => {
    const session = { endSession: vi.fn(async () => {}) };
    const startSession = vi.fn(async (options) => { options.onConnect(); return session; });
    const app = widget({ fetch: signed, loadSdk: (script, window) => {
      window.ElevenLabsClient = { Conversation: { startSession } };
      script.onload();
    } });
    expect(app.scripts).toHaveLength(0);
    expect(startSession).not.toHaveBeenCalled();
    await app.click();
    expect(app.scripts).toHaveLength(1);
    expect(app.scripts[0]).toMatchObject({ src: voiceAssets.sdk.url, integrity: voiceAssets.sdk.integrity, crossOrigin: 'anonymous', async: true });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0][0]).toMatchObject({
      signedUrl, workletPaths: expectedWorklets,
      libsampleratePath: '/vendor/libsamplerate/2.1.2/libsamplerate.worklet.js',
    });
    const options = startSession.mock.calls[0][0];
    expect([...Object.values(options.workletPaths), options.libsampleratePath]).toEqual(voiceAssets.assets.map((asset) => asset.path));
    expect(app.box.dataset.mode).toBe('live');
    expect(app.getUserMedia).not.toHaveBeenCalled(); // provider is mocked, no real device access
    app.voice.stop();
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it('keeps typed extraction and a clean voice retry after a worklet-load failure', async () => {
    const session = { endSession: vi.fn(async () => {}) };
    const startSession = vi.fn().mockRejectedValueOnce(new Error('AudioWorklet module failed to load'))
      .mockImplementationOnce(async (options) => { options.onConnect(); return session; });
    const app = widget({ fetch: signed, sdk: { Conversation: { startSession } } });
    await expect(app.click()).resolves.toBeUndefined();
    expect(app.box.dataset.mode).toBe('idle');
    expect(app.node('err').textContent).toBe('AudioWorklet module failed to load');
    expect(app.node('fallback').open).toBe(true);
    expect(app.node('orb').disabled).toBe(false);
    app.node('text').value = 'Call Alice weekly';
    await app.node('extract').onclick();
    expect(app.onResult).toHaveBeenCalledWith(app.extraction);
    await app.click();
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(app.box.dataset.mode).toBe('live');
    expect(app.node('err').textContent).toBe('');
    expect(app.getUserMedia).not.toHaveBeenCalled();
    expect(app.paths()).not.toContain('/api/voice/transcribe');
    app.voice.stop();
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it('does not start two SDK sessions while module loading is pending', async () => {
    const pending = deferred();
    const session = { endSession: vi.fn(async () => {}) };
    const startSession = vi.fn(() => pending.promise);
    const app = widget({ fetch: signed, sdk: { Conversation: { startSession } } });
    const first = app.click();
    await flush();
    await app.click();
    expect(startSession).toHaveBeenCalledTimes(1);
    pending.resolve(session);
    await first;
    app.voice.stop();
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'hashchange'])('closes a late SDK session and ignores callbacks after %s', async (action) => {
    const pending = deferred();
    const session = { endSession: vi.fn(async () => {}) };
    const startSession = vi.fn(() => pending.promise);
    const app = widget({ fetch: signed, sdk: { Conversation: { startSession } } });
    const started = app.click();
    await flush();
    if (action === 'stop') app.voice.stop(); else app.leave();
    const status = app.node('status').textContent;
    const options = startSession.mock.calls[0][0];
    options.onConnect();
    options.onMessage({ role: 'user', message: 'Ignore this stale transcript' });
    options.onError('Ignore this stale error');
    options.onModeChange({ mode: 'speaking' });
    pending.resolve(session);
    await started;
    options.onDisconnect();
    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(app.node('status').textContent).toBe(status);
    expect(app.node('log').children).toHaveLength(0);
    expect(app.node('err').textContent).toBe('');
    expect(app.node('end').classList.contains('hidden')).toBe(true);
    expect(app.onResult).not.toHaveBeenCalled();
    expect(app.paths()).not.toContain('/api/extract');
    await app.click();
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('abandons a pending script load before creating an SDK session', async () => {
    const startSession = vi.fn();
    const app = widget({ fetch: signed, loadSdk: () => {} });
    const started = app.click();
    await flush();
    app.voice.stop();
    app.window.ElevenLabsClient = { Conversation: { startSession } };
    app.scripts[0].onload();
    await started;
    expect(startSession).not.toHaveBeenCalled();
  });
});
