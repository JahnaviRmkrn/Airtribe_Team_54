// Desktop-app abilities, via the Electron shell's window.muopDesktop
// bridge (see desktop/preload.js). In a plain browser this file is a
// no-op: the bridge does not exist and nothing is rendered.
(function () {
  var bridge = window.muopDesktop;
  if (!bridge || !bridge.isDesktop) return;

  var style = document.createElement('style');
  style.textContent =
    '#muop-desktop-btn{margin-left:8px}' +
    '#muop-desktop{position:fixed;right:16px;bottom:16px;z-index:60;width:min(430px,calc(100vw - 32px));max-height:75vh;overflow:auto;background:#fff;border:1px solid #e5ded4;border-radius:14px;box-shadow:0 14px 44px rgba(46,31,20,.2);padding:16px}' +
    '#muop-desktop h2{margin:0 0 4px;font-size:17px}' +
    '#muop-desktop .row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}' +
    '#muop-desktop button{cursor:pointer}' +
    '#muop-desktop pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#faf7f2;border-radius:8px;padding:10px;max-height:280px;overflow:auto}' +
    '#muop-desktop img{max-width:100%;border-radius:8px;border:1px solid #e5ded4}' +
    '#muop-desktop video{max-width:100%;border-radius:8px;border:1px solid #e5ded4;background:#000}';
  document.head.appendChild(style);

  var btn = document.createElement('button');
  btn.id = 'muop-desktop-btn';
  btn.type = 'button';
  btn.textContent = 'Desktop';
  btn.title = 'Abilities only available in the Muop desktop app';
  (document.querySelector('.topbar') || document.body).appendChild(btn);

  var panel = null;
  function stopShare() {
    if (!panel) return;
    var video = panel.querySelector('video');
    if (video && video.srcObject) video.srcObject.getTracks().forEach(function (t) { t.stop(); });
    if (video) { video.srcObject = null; video.hidden = true; }
    var stop = panel.querySelector('[data-act="stop-share"]');
    if (stop) stop.hidden = true;
    show('Screen sharing stopped.');
  }
  function close() { if (panel) { stopShare(); panel.remove(); panel = null; } }
  function show(text, imageUrl) {
    var out = panel.querySelector('[data-out]');
    out.textContent = text || '';
    var img = panel.querySelector('img');
    if (imageUrl) { img.src = imageUrl; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  }
  async function run(label, fn, format) {
    show(label + '…');
    try { show(format(await fn())); }
    catch (err) { show(label + ' failed: ' + (err && err.message ? err.message : err)); }
  }
  var names = function (items, key) {
    return items.length + ' found' + (items.length ? ':\n' + items.map(function (i) { return '- ' + (i[key] || '(unnamed)'); }).join('\n') : '');
  };

  function open() {
    if (panel) { close(); return; }
    panel = document.createElement('section');
    panel.id = 'muop-desktop';
    var isMac = bridge.platform === 'darwin';
    panel.innerHTML =
      '<h2>Desktop app</h2>' +
      '<p class="muted">Running in the Muop desktop app (' + bridge.platform + '). These use this computer; nothing is read until you click.</p>' +
      '<div class="row">' +
      '<button type="button" data-act="files">Open local files…</button>' +
      '<button type="button" data-act="shot">Capture screen</button>' +
      '<button type="button" data-act="share">Share screen</button>' +
      '<button type="button" data-act="stop-share" hidden>Stop sharing</button>' +
      (isMac ?
        '<button type="button" data-act="contacts">Mac Contacts</button>' +
        '<button type="button" data-act="notes">Mac Notes</button>' +
        '<button type="button" data-act="reminders">Mac Reminders</button>' +
        '<button type="button" data-act="new-reminder">New Reminder…</button>' +
        '<button type="button" data-act="chats">Message chats</button>' : '') +
      '<button type="button" data-act="save">Save result…</button>' +
      '<button type="button" data-act="close">Close</button>' +
      '</div>' +
      '<video hidden autoplay muted playsinline></video>' +
      '<img hidden alt="Screen capture"><pre data-out>Pick an action above.</pre>';
    document.body.appendChild(panel);

    panel.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'close') close();
      else if (act === 'files') run('Reading files', function () { return bridge.pickAndReadFiles(); }, function (files) {
        return files.length ? files.map(function (f) { return f.name + ' (' + f.size + ' bytes)'; }).join('\n') : 'No file chosen.';
      });
      else if (act === 'shot') run('Capturing screen', function () { return bridge.captureScreen(); }, function (shots) {
        if (!shots.length) return 'No screen source returned.';
        show(shots[0].name || 'Screen', shots[0].dataUrl);
        return 'Captured: ' + (shots[0].name || 'screen');
      });
      else if (act === 'share') {
        show('Starting screen share…');
        navigator.mediaDevices.getDisplayMedia({ video: true }).then(function (stream) {
          var video = panel.querySelector('video');
          video.srcObject = stream;
          video.hidden = false;
          panel.querySelector('[data-act="stop-share"]').hidden = false;
          stream.getVideoTracks()[0].addEventListener('ended', function () { stopShare(); });
          show('Sharing your screen — preview above. Stop sharing when done.');
        }).catch(function (err) { show('Screen share failed: ' + (err && err.message ? err.message : err)); });
      }
      else if (act === 'stop-share') stopShare();
      else if (act === 'save') {
        var text = panel.querySelector('[data-out]').textContent;
        run('Saving', function () { return bridge.saveTextFile({ suggestedName: 'muop-desktop.txt', text: text }); }, function (saved) {
          return saved ? 'Saved to ' + saved : 'Save cancelled.';
        });
      }
      else if (act === 'new-reminder') {
        var name = window.prompt('Reminder name');
        if (!name) { show('Reminder cancelled.'); return; }
        var due = window.prompt('Due (optional, e.g. 2026-11-01T19:00)', '');
        run('Creating reminder', function () {
          return bridge.createReminder({ name: name, dueDate: due || undefined });
        }, function (r) { return 'Created reminder "' + r.name + '" in list ' + r.list + '.'; });
      }
      else if (act === 'contacts') run('Reading Contacts', function () { return bridge.getContacts(); }, function (c) { return names(c, 'name'); });
      else if (act === 'notes') run('Reading Notes', function () { return bridge.getNotes(); }, function (n) { return names(n, 'name'); });
      else if (act === 'reminders') run('Reading Reminders', function () { return bridge.getReminders(); }, function (r) {
        return r.length + ' found' + (r.length ? ':\n' + r.map(function (i) { return '- [' + (i.completed ? 'x' : ' ') + '] ' + i.name + ' (' + i.list + ')'; }).join('\n') : '');
      });
      else if (act === 'chats') run('Reading Message chats', function () { return bridge.getMessageChats(); }, function (c) {
        return c.length + ' found' + (c.length ? ':\n' + c.map(function (i) { return '- ' + (i.name || (i.participants || []).join(', ') || i.id); }).join('\n') : '');
      });
    });
  }

  btn.addEventListener('click', open);
})();
