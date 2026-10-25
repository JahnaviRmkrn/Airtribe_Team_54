# Muop desktop (Electron)

Electron shell that loads [https://muop.win](https://muop.win). It does not bundle
the Next.js app, so it needs internet and always serves the deployed version.
External links open in the system browser. Override the URL with `MUOP_URL=...`.

## Desktop-only abilities (page bridge)

The shell exposes `window.muopDesktop` to the hosted page (via a sandboxed
preload; the page gets no Node/filesystem access of its own):

```js
window.muopDesktop.platform;                 // 'darwin' | 'win32' | 'linux'
await window.muopDesktop.pickAndReadFiles(); // native picker -> [{name, path, size, text}]
await window.muopDesktop.pickAndReadFiles({ base64: true }); // binary files, max 10 MB each
await window.muopDesktop.saveTextFile({ suggestedName: 'plan.txt', text });
await window.muopDesktop.getContacts();      // macOS only -> [{name, emails, phones}]
await window.muopDesktop.getNotes();         // macOS only -> [{name, body, ...}]
await window.muopDesktop.getReminders();     // macOS only -> [{list, name, completed, dueDate}]
await window.muopDesktop.createReminder({ name: 'Book table', dueDate: '2026-11-01T19:00:00' }); // macOS only
await window.muopDesktop.getMessageChats();  // macOS only -> [{id, name, participants}]
await window.muopDesktop.captureScreen();    // all platforms -> [{id, name, dataUrl(PNG)}]
navigator.mediaDevices.getDisplayMedia();    // all platforms: screen sharing, no picker
```

Local files and screen capture/sharing work on macOS, Windows and Linux
(macOS will ask for Screen Recording permission). Contacts, Notes,
Reminders and Messages are macOS-only: they read through the OS apps
(JXA), so macOS shows its permission prompt for Muop the first time, and
the calls reject on Windows/Linux. Messages returns chats/participants
only — message bodies are not exposed by Messages scripting. The hosted
page must call these itself — nothing is read until it does.

## Run

```bash
cd desktop
npm install
npm start
```

## Build installers

```bash
npm run dist:win   # release/*.exe — NSIS installer + portable (needs Wine on Linux)
npm run dist:mac   # release/*.dmg + *.zip — must be run on macOS
npm run dist:linux # release/*.AppImage
npm run dist       # all of the above, on macOS (Windows targets also build there)
```

On a Linux host without Wine, `npx electron-builder --win zip` produces
`release/Muop-<version>-win.zip` instead: unzip anywhere and run `Muop.exe`.

To publish builds on the site: copy them into `../public/downloads/`, then run
`node ../scripts/write-downloads-info.mjs` so the landing page shows the true
sizes and SHA-256 checksums from `downloads.json`.

CI: `.github/workflows/desktop.yml` builds all three desktop installers and
the Android APK on GitHub runners (Actions → "Desktop & Android builds" → Run
workflow, or push a `desktop-v*` tag) and attaches them as run artifacts. That
is the supported way to get the macOS `.dmg` and Windows NSIS installer
without owning those machines.

Notes:

- Builds are unsigned (`identity: null`, `signAndEditExecutable: false`). macOS Gatekeeper
  and Windows SmartScreen will warn until you sign with an Apple Developer ID /
  Windows code-signing certificate and re-enable signing in `package.json`.
- The host used to develop this is Linux: the Windows artifacts build there, the
  macOS `.dmg`/`.zip` do not — run `npm run dist:mac` on a Mac (or macOS CI).
