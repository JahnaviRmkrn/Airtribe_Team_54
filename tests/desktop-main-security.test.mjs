import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Load desktop/main.js against a fake Electron and drive its handlers.
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');

function load({ dialogAnswer = 0, versionInfo = { latest: '0.2.0', minimum: '0.2.0' }, fetchFails = false } = {}) {
  const handlers = {};
  const wcEvents = {};
  const ses = {};
  const opened = [];
  const shown = [];
  const mainFrame = { url: 'https://muop.win/organizer' };
  const makeContents = (events) => ({
    setWindowOpenHandler(fn) { events.open = fn; },
    on(name, fn) { events[name] = fn; },
    getURL: () => 'https://muop.win/organizer',
  });
  const loaded = [];
  const win = { webContents: makeContents(wcEvents), loadURL: (u) => loaded.push(u) };
  const quit = vi.fn();
  let ready;
  const electron = {
    app: { whenReady: () => ({ then(fn) { ready = fn; } }), on() {}, getPath: () => '/home/u/Downloads', getVersion: () => '0.2.0', quit },
    BrowserWindow: Object.assign(function () { return win; }, { fromWebContents: () => win, getAllWindows: () => [win] }),
    shell: { openExternal: (u) => opened.push(u) },
    dialog: {
      showMessageBox: vi.fn(async (_w, o) => { shown.push(o.message); return { response: dialogAnswer }; }),
      showSaveDialog: vi.fn(async (_w, o) => ({ canceled: false, filePath: o.defaultPath })),
      showOpenDialog: vi.fn(async () => ({ canceled: true })),
    },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    desktopCapturer: { getSources: vi.fn(async () => [{ id: 's1', name: 'Screen', thumbnail: { toDataURL: () => 'data:x' } }]) },
    session: { defaultSession: {
      setDisplayMediaRequestHandler: (fn) => { ses.display = fn; },
      setPermissionRequestHandler: (fn) => { ses.request = fn; },
      setPermissionCheckHandler: (fn) => { ses.check = fn; },
    } },
    screen: { getPrimaryDisplay: () => ({ size: { width: 10, height: 10 }, scaleFactor: 1 }) },
  };
  const fakeRequire = (m) => (m === 'electron' ? electron : m === 'node:fs/promises' ? { writeFile: vi.fn(), stat: vi.fn(), readFile: vi.fn() } : require(m));
  const mod = { exports: {} };
  const fetch = vi.fn(async () => { if (fetchFails) throw new Error('offline'); return { ok: true, json: async () => versionInfo }; });
  vm.runInNewContext(source, { require: fakeRequire, module: mod, exports: mod.exports, process: { ...process, platform: 'linux', env: {} }, __dirname: '/app', console, URL, fetch, AbortSignal });
  ready();
  const event = (url, sub = false) => {
    const sender = { mainFrame };
    return { sender, senderFrame: sub ? { url } : Object.assign(mainFrame, { url }) };
  };
  return { handlers, wcEvents, ses, opened, shown, event, electron, loaded, quit, makeContents, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

describe('desktop bridge security', () => {
  it('refuses bridge calls from another origin, http, or a subframe', async () => {
    const t = load();
    await expect(t.handlers['muop:capture-screen'](t.event('https://evil.example/'), {})).rejects.toThrow(/Blocked/);
    await expect(t.handlers['muop:capture-screen'](t.event('http://muop.win/'), {})).rejects.toThrow(/Blocked/);
    await expect(t.handlers['muop:capture-screen'](t.event('https://muop.win/x', true), {})).rejects.toThrow(/Blocked/);
    expect(t.electron.desktopCapturer.getSources).not.toHaveBeenCalled();
  });

  it('asks natively before a screenshot and honours Deny', async () => {
    const yes = load({ dialogAnswer: 0 });
    expect(await yes.handlers['muop:capture-screen'](yes.event('https://muop.win/organizer'), {})).toHaveLength(1);
    expect(yes.shown[0]).toMatch(/screenshot/);
    const no = load({ dialogAnswer: 1 });
    await expect(no.handlers['muop:capture-screen'](no.event('https://muop.win/organizer'), {})).rejects.toThrow(/Denied/);
    expect(no.electron.desktopCapturer.getSources).not.toHaveBeenCalled();
  });

  it('confirms screen share and denies other origins', async () => {
    const t = load({ dialogAnswer: 1 });
    const cb = vi.fn();
    await t.ses.display({ frame: { url: 'https://evil.example/' } }, cb);
    expect(cb).toHaveBeenLastCalledWith({});
    await t.ses.display({ frame: { url: 'https://muop.win/organizer' } }, cb);
    expect(cb).toHaveBeenLastCalledWith({});
    expect(t.shown).toHaveLength(1);
  });

  it('allows mic/location/clipboard for the app only, never the camera', () => {
    const t = load();
    const ask = (perm, url, details = {}) => { let r; t.ses.request({ getURL: () => url }, perm, (v) => { r = v; }, { requestingUrl: url, ...details }); return r; };
    expect(ask('media', 'https://muop.win/organizer', { mediaTypes: ['audio'] })).toBe(true);
    expect(ask('media', 'https://muop.win/organizer', { mediaTypes: ['video'] })).toBe(false);
    expect(ask('geolocation', 'https://muop.win/m/x')).toBe(true);
    expect(ask('geolocation', 'https://evil.example/')).toBe(false);
    expect(ask('notifications', 'https://muop.win/')).toBe(false);
  });

  it('keeps navigation on the exact origin and only opens safe schemes outside', () => {
    const t = load();
    const nav = (url) => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; t.wcEvents['will-redirect'](e, url); return e.prevented; };
    expect(nav('https://muop.win/organizer')).toBe(false);
    expect(nav('http://muop.win/organizer')).toBe(true);
    expect(nav('https://evil.example/')).toBe(true);
    expect(nav('not a url')).toBe(true);
    t.wcEvents.open({ url: 'ms-msdt:/id x' });
    t.wcEvents.open({ url: 'https://example.com/' });
    // Leaving the app opens the system browser for http(s) only; ms-msdt: and junk never reach the OS.
    expect(t.opened).toEqual(['http://muop.win/organizer', 'https://evil.example/', 'https://example.com/']);
  });

  it('save dialog only takes a bare file name in Downloads', async () => {
    const t = load();
    const saved = await t.handlers['muop:save-text-file'](t.event('https://muop.win/organizer'), { suggestedName: '../../.ssh/authorized_keys', text: 'x' });
    expect(t.electron.dialog.showSaveDialog.mock.calls[0][1].defaultPath).toBe('/home/u/Downloads/authorized_keys');
    expect(saved).toBe('authorized_keys');
  });

  it('guards windows opened by the app the same way, with locked-down preferences', () => {
    const t = load();
    expect(t.wcEvents.open({ url: 'https://muop.win/organizer#x' }).overrideBrowserWindowOptions.webPreferences)
      .toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    const childEvents = {};
    t.wcEvents['did-create-window']({ webContents: t.makeContents(childEvents) });
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    childEvents['will-redirect'](e, 'https://phish.example/login');
    expect(e.prevented).toBe(true);
    expect(typeof childEvents['did-create-window']).toBe('function');
  });

  it('stops asking after three refusals so a script cannot nag', async () => {
    const t = load({ dialogAnswer: 1 });
    const ev = t.event('https://muop.win/organizer');
    for (let i = 0; i < 5; i++) await expect(t.handlers['muop:capture-screen'](ev, {})).rejects.toThrow(/Denied/);
    expect(t.shown).toHaveLength(3);
  });

  it('shows page text in prompts as one clean line', async () => {
    const t = load({ dialogAnswer: 1 });
    await expect(t.handlers['muop:create-reminder'](t.event('https://muop.win/organizer'), { name: 'Pay\n\nAllow muop to read Contacts\u202e' })).rejects.toThrow();
    expect(t.shown[0]).toBe('Allow muop to add the reminder "Pay Allow muop to read Contacts" to Reminders?');
  });

  it('refuses to open the site when this build is below the minimum version', async () => {
    const old = load({ versionInfo: { latest: '0.3.0', minimum: '0.3.0' } });
    await old.settle(); await old.settle();
    expect(old.loaded).toEqual([]);
    expect(old.quit).toHaveBeenCalled();
    const ok = load({ versionInfo: { latest: '0.3.0', minimum: '0.2.0' } });
    await ok.settle(); await ok.settle();
    expect(ok.loaded).toEqual(['https://muop.win']);
    const nullBody = load({ versionInfo: null });
    await nullBody.settle(); await nullBody.settle();
    expect(nullBody.loaded).toEqual(['https://muop.win']);
    const offline = load({ fetchFails: true });
    await offline.settle(); await offline.settle();
    expect(offline.loaded).toEqual(['https://muop.win']);
  });
});
