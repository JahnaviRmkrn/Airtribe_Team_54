const { app, BrowserWindow, shell, dialog, ipcMain, desktopCapturer, session, screen } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_URL = process.env.MUOP_URL || 'https://muop.win';
const APP_ORIGIN = new URL(APP_URL).origin;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Schemes the OS may open for links that leave the app.
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}
// Full origin (scheme + host + port), so http://muop.win is NOT the app.
const isAppUrl = (url) => parseUrl(url)?.origin === APP_ORIGIN;

function openExternal(url) {
  const u = parseUrl(url);
  if (u && EXTERNAL_SCHEMES.has(u.protocol)) shell.openExternal(u.href);
}

// Every bridge call must come from the app's own top-level page. A frame,
// a redirect target or any other origin gets nothing.
function assertAppSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
    throw new Error('Blocked: desktop features are only available to the muop app');
  }
}

// Sensitive reads/writes need the person's say-so in a native dialog the
// page cannot draw or click, so a script on the page can't use them silently.
async function confirmAccess(event, what) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Allow', 'Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: `Allow muop to ${what}?`,
    detail: 'Only allow this if you just asked muop to do it.',
  });
  if (response !== 0) throw new Error('Denied');
}

// Wraps an IPC handler: origin check always, native confirmation if `what` is set.
function handle(channel, what, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertAppSender(event);
    if (what) await confirmAccess(event, typeof what === 'function' ? what(...args) : what);
    return fn(event, ...args);
  });
}

// Run a JXA (JavaScript for Automation) script on macOS and parse its
// JSON stdout. Only used for Contacts/Notes, behind the OS permission
// prompt, and only when the page explicitly calls for it.
function runJxa(source) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', source], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`macOS automation failed: ${err.message}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Unexpected output from macOS automation')); }
    });
  });
}

function requireDarwin() {
  if (process.platform !== 'darwin') throw new Error('Contacts/Notes access is only available on macOS');
}

function registerIpc() {
  handle('muop:pick-and-read-files', null, async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: opts.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    const files = [];
    for (const filePath of result.filePaths) {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`File too large (max 10 MB): ${path.basename(filePath)}`);
      const data = await fs.readFile(filePath);
      // No absolute path: the page doesn't need the user's directory layout.
      const entry = { name: path.basename(filePath), size: stat.size, lastModified: stat.mtimeMs };
      if (opts.base64) entry.base64 = data.toString('base64');
      else entry.text = data.toString('utf8');
      files.push(entry);
    }
    return files;
  });

  handle('muop:save-text-file', null, async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // A bare file name only, in Downloads: the page can't aim the dialog at
    // ~/.ssh or a dotfile.
    const name = path.basename(String(opts.suggestedName || 'muop-export.txt')).replace(/^\.+/, '') || 'muop-export.txt';
    const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, String(opts.text ?? ''), 'utf8');
    return path.basename(result.filePath);
  });

  handle('muop:get-contacts', 'read your Contacts (names, emails, phone numbers)', async () => {
    requireDarwin();
    return runJxa(`(() => {
      const Contacts = Application('Contacts');
      Contacts.includeStandardAdditions = true;
      return JSON.stringify(Contacts.people().map(p => ({
        name: p.name(),
        emails: p.emails().map(e => e.value()),
        phones: p.phones().map(e => e.value()),
      })));
    })()`);
  });

  // Screen capture on every platform. Returns PNG data URLs sized to
  // each display. { all: true } returns every screen/window source;
  // default is just the primary display.
  handle('muop:capture-screen', (opts = {}) => (opts.all ? 'take screenshots of all your screens and windows' : 'take a screenshot of your screen'), async (_event, opts = {}) => {
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: opts.all ? ['screen', 'window'] : ['screen'],
      thumbnailSize: { width: Math.round(primary.size.width * primary.scaleFactor), height: Math.round(primary.size.height * primary.scaleFactor) },
    });
    return sources.map((s) => ({ id: s.id, name: s.name, dataUrl: s.thumbnail.toDataURL() }));
  });

  handle('muop:get-reminders', 'read your Reminders', async () => {
    requireDarwin();
    return runJxa(`(() => {
      const Reminders = Application('Reminders');
      Reminders.includeStandardAdditions = true;
      const out = [];
      for (const list of Reminders.lists()) {
        for (const r of list.reminders()) {
          out.push({ list: list.name(), name: r.name(), body: r.body(),
            completed: r.completed(), dueDate: String(r.dueDate()) });
        }
      }
      return JSON.stringify(out);
    })()`);
  });

  handle('muop:create-reminder', (opts = {}) => `add the reminder "${String(opts.name || '').slice(0, 80)}" to Reminders`, async (_event, opts = {}) => {
    requireDarwin();
    if (!opts.name) throw new Error('createReminder requires a name');
    const payload = JSON.stringify({ name: String(opts.name), body: String(opts.body || ''), list: opts.list ? String(opts.list) : null, dueDate: opts.dueDate || null });
    return runJxa(`(() => {
      const opts = ${payload};
      const Reminders = Application('Reminders');
      Reminders.includeStandardAdditions = true;
      const list = opts.list ? Reminders.lists.byName(opts.list) : Reminders.defaultList();
      const props = { name: opts.name, body: opts.body };
      if (opts.dueDate) props.dueDate = new Date(opts.dueDate);
      const r = Reminders.Reminder(props);
      list.reminders.push(r);
      return JSON.stringify({ id: r.id(), name: r.name(), list: list.name() });
    })()`);
  });

  // Messages on macOS exposes chats/participants only (message bodies
  // live in ~/Library/Messages/chat.db, which needs Full Disk Access
  // and is intentionally not read here).
  handle('muop:get-message-chats', 'read your Messages chat list and participants', async () => {
    requireDarwin();
    return runJxa(`(() => {
      const Messages = Application('Messages');
      Messages.includeStandardAdditions = true;
      return JSON.stringify(Messages.chats().map(c => ({
        id: c.id(), name: c.name(),
        participants: c.participants().map(p => p.handle()),
      })));
    })()`);
  });

  handle('muop:get-notes', 'read all your Notes', async () => {
    requireDarwin();
    return runJxa(`(() => {
      const Notes = Application('Notes');
      Notes.includeStandardAdditions = true;
      return JSON.stringify(Notes.notes().map(n => ({
        name: n.name(),
        body: n.plaintext(),
        creationDate: String(n.creationDate()),
        modificationDate: String(n.modificationDate()),
      })));
    })()`);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 560,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Keep navigation (including server redirects) on the app's exact origin;
  // anything else goes to the system browser, and only for safe schemes.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    openExternal(url);
    return { action: 'deny' };
  });
  const keepInApp = (e, url) => {
    if (!isAppUrl(url)) { e.preventDefault(); openExternal(url); }
  };
  win.webContents.on('will-navigate', keepInApp);
  win.webContents.on('will-redirect', keepInApp);
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  registerIpc();
  // getDisplayMedia(): only for the app's own page, and only after a native
  // confirmation, so a script can't start a silent screen recording.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || !isAppUrl(request.frame?.url ?? request.securityOrigin)) return callback({});
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Share screen', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      message: 'Share your whole screen with muop?',
      detail: 'Only allow this if you just pressed Share screen in muop.',
    });
    if (response !== 0) return callback({});
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback(sources[0] ? { video: sources[0] } : {});
  });
  // Browser permissions: what the app uses (mic for voice, location for the
  // meeting point, clipboard writes, screen share) and only for its origin.
  // Camera and everything else are refused instead of Electron's grant-all default.
  const allowed = (permission, origin, details = {}) => {
    if (!isAppUrl(origin)) return false;
    if (permission === 'media') return ![...(details.mediaTypes || []), details.mediaType].includes('video');
    return ['clipboard-sanitized-write', 'geolocation', 'display-capture'].includes(permission);
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowed(permission, details?.requestingUrl || wc.getURL(), details)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin, details) =>
    allowed(permission, origin, details));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
