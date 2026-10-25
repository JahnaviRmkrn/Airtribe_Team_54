const { contextBridge, ipcRenderer } = require('electron');

// Exposed to the hosted page as window.muopDesktop. The main process only
// answers the app's own top-level page (exact origin), shows native
// pickers, and asks for native confirmation before screen capture or any
// Contacts/Notes/Reminders/Messages access, so the page gets no raw
// filesystem or Node access and can't use these silently.
contextBridge.exposeInMainWorld('muopDesktop', {
  platform: process.platform,
  isDesktop: true,
  // Pick local files and read them in the main process.
  // Returns [{ name, size, lastModified, text?, base64? }]
  // `text` is set for text-like files, `base64` when opts.base64 is true.
  pickAndReadFiles: (opts) => ipcRenderer.invoke('muop:pick-and-read-files', opts || {}),
  // Save text the page generated to a user-chosen local file.
  // Returns the saved file name, or null if the user cancelled.
  saveTextFile: (opts) => ipcRenderer.invoke('muop:save-text-file', opts || {}),
  // Screen capture (macOS, Windows, Linux): PNG data URL of the
  // primary display, or of every display/source with { all: true }.
  // Also enables navigator.mediaDevices.getDisplayMedia() in the page.
  captureScreen: (opts) => ipcRenderer.invoke('muop:capture-screen', opts || {}),
  // macOS only: read Contacts / Notes / Reminders / Messages through
  // the OS apps (triggers the macOS permission prompt for this app).
  // These reject on Windows/Linux.
  getContacts: () => ipcRenderer.invoke('muop:get-contacts'),
  getNotes: () => ipcRenderer.invoke('muop:get-notes'),
  getReminders: () => ipcRenderer.invoke('muop:get-reminders'),
  createReminder: (opts) => ipcRenderer.invoke('muop:create-reminder', opts || {}),
  getMessageChats: () => ipcRenderer.invoke('muop:get-message-chats'),
});
