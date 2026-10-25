import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Load desktop/main.js against a fake Electron and drive its handlers.
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');

function load({ dialogAnswer = 0 } = {}) {
  const handlers = {};
  const wcEvents = {};
  const ses = {};
  const opened = [];
  const shown = [];
  const mainFrame = { url: 'https://muop.win/organizer' };
  const win = {
    webContents: {
      setWindowOpenHandler(fn) { wcEvents.open = fn; },
      on(name, fn) { wcEvents[name] = fn; },
      getURL: () => 'https://muop.win/organizer',
    },
    loadURL() {},
  };
  let ready;
  const electron = {
    app: { whenReady: () => ({ then(fn) { ready = fn; } }), on() {}, getPath: () => '/home/u/Downloads' },
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
  vm.runInNewContext(source, { require: fakeRequire, module: mod, exports: mod.exports, process: { ...process, platform: 'linux', env: {} }, __dirname: '/app', console, URL });
  ready();
  const event = (url, sub = false) => {
    const sender = { mainFrame };
    return { sender, senderFrame: sub ? { url } : Object.assign(mainFrame, { url }) };
  };
  return { handlers, wcEvents, ses, opened, shown, event, electron };
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
});
