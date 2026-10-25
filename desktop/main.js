const { app, BrowserWindow, shell, dialog, ipcMain, desktopCapturer, session, screen } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_URL = process.env.MUOP_URL || 'https://muop.win';
const HOST = new URL(APP_URL).host;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
  ipcMain.handle('muop:pick-and-read-files', async (event, opts = {}) => {
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
      const entry = { name: path.basename(filePath), path: filePath, size: stat.size, lastModified: stat.mtimeMs };
      if (opts.base64) entry.base64 = data.toString('base64');
      else entry.text = data.toString('utf8');
      files.push(entry);
    }
    return files;
  });

  ipcMain.handle('muop:save-text-file', async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, { defaultPath: opts.suggestedName || 'muop-export.txt' });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, String(opts.text ?? ''), 'utf8');
    return result.filePath;
  });

  ipcMain.handle('muop:get-contacts', async () => {
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
  ipcMain.handle('muop:capture-screen', async (_event, opts = {}) => {
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: opts.all ? ['screen', 'window'] : ['screen'],
      thumbnailSize: { width: Math.round(primary.size.width * primary.scaleFactor), height: Math.round(primary.size.height * primary.scaleFactor) },
    });
    return sources.map((s) => ({ id: s.id, name: s.name, dataUrl: s.thumbnail.toDataURL() }));
  });

  ipcMain.handle('muop:get-reminders', async () => {
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

  ipcMain.handle('muop:create-reminder', async (_event, opts = {}) => {
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
  ipcMain.handle('muop:get-message-chats', async () => {
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

  ipcMain.handle('muop:get-notes', async () => {
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

  // Keep navigation inside the app; open external hosts in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).host !== HOST) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).host !== HOST) { e.preventDefault(); shell.openExternal(url); }
  });

  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  registerIpc();
  // Let the page share/capture the screen via getDisplayMedia()
  // (all platforms). Grants the whole primary screen with no picker;
  // the app has a single window and a single hosted origin.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0] });
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
