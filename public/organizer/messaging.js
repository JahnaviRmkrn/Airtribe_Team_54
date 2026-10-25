// Organizer messaging: link your own WhatsApp (linked device) and/or your
// Android phone's SMS, import WhatsApp people, and send as yourself.
// Loaded before app.js; uses its helpers (api, el, esc, go, navToken, stale,
// loadQr, flash, renderLoading, renderError) at call time. Nothing here sends
// anything without an explicit tap, and nothing is linked without opting in.

(() => {
  const CAT = ['personal', 'professional', 'community'];

  // --- hand-off links (work without linking anything; `?&body=` suits iOS and Android) ---
  const digits = (p) => String(p || '').replace(/\D/g, '');
  const smsHref = (phone, body) => 'sms:' + (phone || '') + '?&body=' + encodeURIComponent(body || '');
  const waHref = (phone, body) => 'https://wa.me/' + digits(phone) + '?text=' + encodeURIComponent(body || '');

  // --- which channels are linked (mirrors lib/channels.ts) ---
  let channelsP = null;
  const loadChannels = () => (channelsP ??= api('/api/me/channels').catch(() => {
    channelsP = null;
    return { whatsapp: { linked: false }, sms: { linked: false } };
  }));
  const resetChannels = () => { channelsP = null; };
  function channelsFor(c, ch) {
    const out = [];
    if (ch.whatsapp.linked && ((c.source === 'whatsapp' && c.source_ref) || c.phone)) out.push('whatsapp');
    if (ch.sms.linked && c.phone) out.push('sms');
    return out;
  }
  const CHANNEL_LABEL = { whatsapp: 'Send on WhatsApp', sms: 'Send SMS from my phone' };

  async function sendNow(payload, label) {
    try {
      const r = await api('/api/me/send', { method: 'POST', body: JSON.stringify(payload) });
      return { ok: true, msg: 'Sent' + (r.channel === 'sms' ? ' by SMS' : ' on WhatsApp') + '.' };
    } catch (e) {
      if (e instanceof AuthError) throw e;
      return { ok: false, msg: e.message || ('Could not send ' + label) };
    }
  }

  // "Send as me" buttons for one contact, plus hand-off links. `getText` reads the
  // current (editable) message. Sending is always an explicit tap with a confirm.
  async function mountSend(host, contact, getText) {
    const ch = await loadChannels();
    if (!host.isConnected) return;
    const chans = channelsFor(contact, ch);
    host.innerHTML = chans.map((k) => `<button class="primary" data-send="${k}">${CHANNEL_LABEL[k]}</button>`).join('')
      + (contact.phone ? `<a class="button-link" data-handoff="sms" target="_blank" rel="noopener">Open in Messages</a>` : '')
      + '<span class="muted send-status" role="status"></span>';
    const status = host.querySelector('.send-status');
    const hand = host.querySelector('[data-handoff]');
    const syncHand = () => { if (hand) hand.href = smsHref(contact.phone, getText()); };
    syncHand();
    if (hand) hand.onmousedown = hand.onfocus = syncHand;
    host.querySelectorAll('[data-send]').forEach((b) => {
      b.onclick = async () => {
        const text = getText().trim();
        if (!text) { status.textContent = 'Write a message first.'; return; }
        const via = b.dataset.send === 'sms' ? 'your phone by SMS' : 'your WhatsApp';
        if (!confirm('Send this message to ' + (contact.name || 'them') + ' from ' + via + '?')) return;
        b.disabled = true;
        status.textContent = 'Sending...';
        const r = await sendNow({ contact_id: contact.id, text, channel: b.dataset.send }, 'message');
        status.textContent = r.msg;
        b.disabled = false;
      };
    });
  }

  // Pick a recipient from your contacts (and WhatsApp groups) and send an invite text.
  async function invitePicker(btn, text) {
    const holder = btn.closest('.row, .card') || btn.parentElement;
    const open = holder.querySelector(':scope > .send-picker');
    if (open) { open.remove(); return; }
    const box = document.createElement('div');
    box.className = 'draft-box send-picker';
    box.innerHTML = '<p class="muted">Loading your people...</p>';
    holder.appendChild(box);
    let contacts = [], groups = [], ch;
    try {
      ch = await loadChannels();
      const rc = await api('/api/me/contacts');
      contacts = Array.isArray(rc) ? rc : rc.contacts || [];
      if (ch.whatsapp.linked) {
        try { groups = (await api('/api/me/whatsapp/contacts?limit=1')).groups || []; } catch { groups = []; }
      }
    } catch (e) {
      if (e instanceof AuthError) return;
      box.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
      return;
    }
    const linkedAny = ch.whatsapp.linked || ch.sms.linked;
    box.innerHTML = `
      <label class="draft-label">Send to
        <select class="sp-to">
          <option value="">Choose a person${groups.length ? ' or group' : ''}</option>
          <optgroup label="People">${contacts.map((c) => `<option value="c:${esc(c.id)}">${esc(c.name)}${c.phone ? '' : ' (no phone)'}</option>`).join('')}</optgroup>
          ${groups.length ? `<optgroup label="WhatsApp groups">${groups.map((g) => `<option value="g:${esc(g.jid)}">${esc(g.subject || 'Group')}</option>`).join('')}</optgroup>` : ''}
        </select>
      </label>
      <label class="draft-label">Message <textarea class="draft-text sp-text" rows="4">${esc(text)}</textarea></label>
      <div class="actions sp-actions"></div>
      ${linkedAny ? '' : '<p class="muted">Tip: link WhatsApp or SMS under Profile to send these as yourself. Until then, the buttons below open your own apps.</p>'}`;
    const sel = box.querySelector('.sp-to'), ta = box.querySelector('.sp-text'), acts = box.querySelector('.sp-actions');
    const render = () => {
      const v = sel.value;
      const c = v.startsWith('c:') ? contacts.find((x) => x.id === v.slice(2)) : null;
      const isGroup = v.startsWith('g:');
      const chans = c ? channelsFor(c, ch) : isGroup ? ['whatsapp'] : [];
      acts.innerHTML = chans.map((k) => `<button class="primary" data-send="${k}">${CHANNEL_LABEL[k]}</button>`).join('')
        + (!isGroup ? `<a class="button-link" data-h="wa" target="_blank" rel="noopener">Open in WhatsApp</a><a class="button-link" data-h="sms" target="_blank" rel="noopener">Open in Messages</a>` : '')
        + '<span class="muted send-status" role="status"></span>';
      const sync = () => {
        const w = acts.querySelector('[data-h=wa]'), s = acts.querySelector('[data-h=sms]');
        if (w) w.href = waHref(c && c.phone, ta.value);
        if (s) s.href = smsHref(c && c.phone, ta.value);
      };
      sync();
      ta.oninput = sync;
      const status = acts.querySelector('.send-status');
      acts.querySelectorAll('[data-send]').forEach((b) => {
        b.onclick = async () => {
          const body = ta.value.trim();
          if (!body) { status.textContent = 'Write a message first.'; return; }
          const who = c ? c.name : 'this group';
          if (!confirm('Send this message to ' + who + ' from ' + (b.dataset.send === 'sms' ? 'your phone by SMS' : 'your WhatsApp') + '?')) return;
          b.disabled = true;
          status.textContent = 'Sending...';
          const r = await sendNow(c ? { contact_id: c.id, text: body, channel: b.dataset.send } : { jid: v.slice(2), text: body }, 'invite');
          status.textContent = r.msg;
          b.disabled = false;
        };
      });
    };
    sel.onchange = render;
    render();
  }

  // --- the Messaging page: link, QR, import, unlink -----------------------------

  const WA_ERRORS = {
    logged_out: 'WhatsApp removed this device (you logged it out on your phone). Your saved session was deleted. Link again to continue.',
    replaced: 'WhatsApp is open on another linked copy of this device, so muop stopped. Link again if you want muop to use this account.',
    restricted: 'WhatsApp refused the connection. Your account may be restricted. muop will not keep retrying. Check WhatsApp on your phone before linking again.',
    connection_failed: 'muop could not stay connected to WhatsApp. Try linking again.',
    bridge_unavailable: 'The WhatsApp service is not reachable right now. Your link is intact; try again in a minute.',
    pairing_code_failed: 'WhatsApp would not give a pairing code. Try the QR code instead.',
  };

  const WA_NOTICE = `
    <div class="notice-box">
      <p><strong>Before you link</strong></p>
      <ul>
        <li>This links your WhatsApp to muop as a <strong>linked device</strong> using an <strong>unofficial method</strong> (the same one WhatsApp Web uses, not an official business API).</li>
        <li><strong>WhatsApp may restrict or ban accounts</strong> that use unofficial clients. You use this at your own risk.</li>
        <li>muop stores an <strong>encrypted session</strong> for your account on its server so it can stay connected.</li>
        <li>muop only sends when you tap Send, and only to your own contacts and groups. You can <strong>unlink at any time</strong>, which logs the device out and deletes the session.</li>
      </ul>
    </div>`;

  const SMS_NOTICE = `
    <div class="notice-box">
      <p><strong>How this works</strong></p>
      <ul>
        <li>Texts go out from <strong>your own Android phone and SIM</strong> through the free, open-source <a href="https://sms-gate.app" target="_blank" rel="noopener">SMS Gateway for Android</a> app. Your carrier's SMS charges apply.</li>
        <li>muop stores the gateway username and password <strong>encrypted on its server</strong>, and never shows them again. Unlinking deletes them.</li>
        <li>muop only sends when you tap Send, and only to your own contacts.</li>
        <li>iPhone or no Android phone? Skip this: the "Open in Messages" buttons use your own phone's SMS app and need no setup.</li>
      </ul>
    </div>`;

  async function view() {
    const nav = navToken();
    renderLoading('Loading messaging...');
    resetChannels();
    el('app').className = 'container';
    el('app').innerHTML = `
      <div class="page-head"><div><h1>Messaging</h1><p class="muted lede">Send check-ins and invites as yourself, from your own WhatsApp or phone. Both are optional.</p></div></div>
      <section class="card" id="wa-card"></section>
      <section class="card" id="sms-card"></section>`;
    waCard(nav);
    smsCard(nav);
  }

  async function waCard(nav) {
    const card = el('wa-card');
    const paint = (html) => { if (!stale(nav)) card.innerHTML = '<h2>WhatsApp</h2>' + html; };
    let timer = null;
    const stop = () => clearTimeout(timer);

    const poll = async () => {
      if (stale(nav)) return;
      let st;
      try { st = await api('/api/me/whatsapp/status'); } catch (e) {
        if (e instanceof AuthError) return;
        paint('<p class="error">' + esc(e.message) + '</p>');
        return;
      }
      if (stale(nav)) return;
      show(st);
      if (st.state === 'connecting' || st.state === 'waiting_qr') timer = setTimeout(poll, st.state === 'waiting_qr' ? 2500 : 1500);
    };

    function show(st) {
      resetChannels();
      if (st.state === 'connected') return connected(st);
      if (st.state === 'connecting' || st.state === 'waiting_qr') return linking(st);
      return unlinked(st);
    }

    function unlinked(st) {
      const err = st.state === 'logged_out' || st.state === 'error' ? `<p class="error">${esc(WA_ERRORS[st.error] || 'Something went wrong. Try linking again.')}</p>` : '';
      paint(`${err}${WA_NOTICE}
        <label class="check"><input type="checkbox" id="wa-accept"> I understand, link my WhatsApp</label>
        <details><summary class="muted">Prefer a pairing code to scanning a QR?</summary>
          <label class="draft-label">Your WhatsApp number with country code <input id="wa-phone" type="tel" inputmode="tel" placeholder="+91 98765 43210" autocomplete="off"></label>
        </details>
        <p class="error" id="wa-error"></p>
        <div class="quick-actions"><button class="primary" id="wa-link" disabled>Link WhatsApp</button></div>`);
      const acc = el('wa-accept'), btn = el('wa-link');
      acc.onchange = () => { btn.disabled = !acc.checked; };
      btn.onclick = async () => {
        el('wa-error').textContent = '';
        btn.disabled = true;
        const body = { accept: true };
        const phone = el('wa-phone').value.trim();
        if (phone) body.phone = phone;
        try {
          const r = await api('/api/me/whatsapp/link', { method: 'POST', body: JSON.stringify(body) });
          show(r);
          timer = setTimeout(poll, 1200);
        } catch (e) { if (!(e instanceof AuthError)) { el('wa-error').textContent = e.message; btn.disabled = false; } }
      };
    }

    async function linking(st) {
      if (st.pairing_code) {
        paint(`<p>On your phone, open WhatsApp, then <strong>Settings, Linked devices, Link a device, Link with phone number instead</strong>, and enter this code:</p>
          <p class="pair-code" aria-live="polite">${esc(st.pairing_code)}</p>
          <p class="muted">The code expires in a couple of minutes.</p>
          <div class="quick-actions"><button id="wa-cancel">Cancel</button></div>`);
      } else if (st.qr) {
        paint(`<p>On your phone, open WhatsApp, then <strong>Settings, Linked devices, Link a device</strong>, and scan this code. It refreshes by itself.</p>
          <div class="qr-box" id="wa-qr"><p class="muted">Drawing QR code...</p></div>
          <div class="quick-actions"><button id="wa-cancel">Cancel</button></div>`);
        try {
          const qrcode = await loadQr();
          const q = qrcode(0, 'M');
          q.addData(st.qr);
          q.make();
          const host = el('wa-qr');
          if (host) host.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'WhatsApp link QR code', title: 'WhatsApp link' });
        } catch (e) { const h = el('wa-qr'); if (h) h.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
      } else {
        paint('<div class="state-box"><span class="spinner"></span><p class="muted">Connecting to WhatsApp...</p></div><div class="quick-actions"><button id="wa-cancel">Cancel</button></div>');
      }
      const cancel = el('wa-cancel');
      if (cancel) cancel.onclick = unlink;
    }

    async function unlink() {
      stop();
      try {
        const r = await api('/api/me/whatsapp/unlink', { method: 'POST' });
        resetChannels();
        flash(r.wiped === false ? 'Unlinked, but the WhatsApp service was unreachable, so the stored session could not be deleted yet. Try Unlink again later.' : 'WhatsApp unlinked and your stored session deleted.');
        view();
      } catch (e) { if (!(e instanceof AuthError)) alert(e.message); }
    }

    function connected(st) {
      const c = st.counts || { contacts: 0, groups: 0 };
      paint(`<p><span class="tag status-open">Linked</span> ${st.phone ? '+' + esc(st.phone) : 'your WhatsApp'}</p>
        <p class="muted">${st.synced || c.contacts ? `${c.contacts} contacts and ${c.groups} groups synced.` : 'Syncing your contacts... this can take a minute after linking.'}</p>
        <div class="quick-actions"><button class="primary" id="wa-import">Import people</button><button class="danger" id="wa-unlink">Unlink WhatsApp</button></div>
        <div id="wa-import-panel"></div>`);
      el('wa-unlink').onclick = () => { if (confirm('Unlink WhatsApp? This logs the device out and deletes your stored session and synced contact list.')) unlink(); };
      el('wa-import').onclick = () => importPanel(nav, el('wa-import-panel'));
      if (!st.synced) timer = setTimeout(poll, 4000);
    }

    poll();
  }

  // Preview -> pick -> confirm. Names come from the bridge; only the picked ids go back.
  async function importPanel(nav, host) {
    if (host.firstChild) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="draft-box">
      <div class="toolbar"><input type="search" id="wi-q" placeholder="Search name or number" autocomplete="off"></div>
      <div id="wi-list" class="muted">Loading...</div>
      <div class="actions">
        <label>Add as <select id="wi-cat">${CAT.map((c) => `<option value="${c}">${catLabel(c)}</option>`).join('')}</select></label>
        <button class="primary" id="wi-go" disabled>Import selected</button>
        <button id="wi-all">Select all shown</button>
        <span class="muted" id="wi-msg" role="status"></span>
      </div></div>`;
    const picked = new Set();
    let q = '', total = 0, rows = [], groups = [];
    const refreshBtn = () => { el('wi-go').disabled = !picked.size; el('wi-go').textContent = picked.size ? `Import ${picked.size} selected` : 'Import selected'; };
    const paintList = () => {
      const list = el('wi-list');
      if (!list) return;
      list.className = '';
      list.innerHTML = (rows.length ? `<ul class="people-list">${rows.map((c) => `
        <li><label class="person"><input type="checkbox" data-jid="${esc(c.jid)}" ${c.imported ? 'disabled' : ''} ${picked.has(c.jid) ? 'checked' : ''}>
          <span class="person-info"><strong>${esc(c.name || (c.phone ? '+' + c.phone : 'Unnamed'))}</strong><span class="muted">${c.phone ? '+' + esc(c.phone) : ''}${c.imported ? ' · already in muop' : ''}</span></span></label></li>`).join('')}</ul>`
        : '<p class="muted">No contacts match. Newly linked accounts can take a minute to sync.</p>')
        + (rows.length < total ? '<p><button id="wi-more">Show more</button></p>' : '')
        + (groups.length ? `<p class="muted">${groups.length} WhatsApp group${groups.length === 1 ? '' : 's'} synced. You can send invites to them from a meetup.</p>` : '');
      list.querySelectorAll('input[data-jid]').forEach((i) => { i.onchange = () => { if (i.checked) picked.add(i.dataset.jid); else picked.delete(i.dataset.jid); refreshBtn(); }; });
      const more = el('wi-more');
      if (more) more.onclick = () => load(true);
    };
    async function load(append) {
      if (stale(nav)) return;
      try {
        const r = await api('/api/me/whatsapp/contacts?limit=50&offset=' + (append ? rows.length : 0) + '&q=' + encodeURIComponent(q));
        rows = append ? rows.concat(r.contacts) : r.contacts;
        total = r.total; groups = r.groups || [];
        paintList();
      } catch (e) { if (!(e instanceof AuthError) && el('wi-list')) el('wi-list').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
    }
    let t;
    el('wi-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(false); }, 300); };
    el('wi-all').onclick = () => { rows.filter((c) => !c.imported).forEach((c) => picked.add(c.jid)); paintList(); refreshBtn(); };
    el('wi-go').onclick = async () => {
      el('wi-go').disabled = true;
      el('wi-msg').textContent = 'Importing...';
      try {
        const jids = [...picked];
        let imported = 0, skipped = 0;
        for (let i = 0; i < jids.length; i += 200) {
          const r = await api('/api/me/whatsapp/import', { method: 'POST', body: JSON.stringify({ jids: jids.slice(i, i + 200), category: el('wi-cat').value }) });
          imported += r.imported; skipped += r.skipped;
        }
        picked.clear();
        el('wi-msg').textContent = `Imported ${imported}${skipped ? `, ${skipped} already there` : ''}.`;
        await load(false);
        refreshBtn();
      } catch (e) { if (!(e instanceof AuthError)) { el('wi-msg').textContent = e.message; el('wi-go').disabled = false; } }
    };
    load(false);
  }

  async function smsCard(nav) {
    const card = el('sms-card');
    const paint = (html) => { if (!stale(nav)) card.innerHTML = '<h2>SMS from your Android phone</h2>' + html; };
    let ch;
    try { ch = await loadChannels(); } catch { return; }
    if (stale(nav)) return;
    if (ch.sms.linked) {
      paint(`<p><span class="tag status-open">Linked</span> ${ch.sms.mode === 'local' ? 'Local server mode' : 'Cloud mode'}</p>
        <p class="muted">Your gateway password is stored encrypted and is never shown.</p>
        <label class="draft-label">Send a test SMS to my own number <input id="sms-to" type="tel" inputmode="tel" placeholder="+91 98765 43210" autocomplete="off"></label>
        <p class="error" id="sms-error" role="status"></p>
        <div class="quick-actions"><button class="primary" id="sms-test">Send test SMS to myself</button><button class="danger" id="sms-unlink">Unlink SMS</button></div>`);
      el('sms-test').onclick = async () => {
        const to = el('sms-to').value.replace(/[\s()-]/g, '');
        el('sms-error').textContent = 'Sending...';
        try {
          await api('/api/me/sms/test', { method: 'POST', body: JSON.stringify({ to }) });
          el('sms-error').textContent = 'Test sent. Check that your phone received it.';
        } catch (e) { if (!(e instanceof AuthError)) el('sms-error').textContent = e.message; }
      };
      el('sms-unlink').onclick = async () => {
        if (!confirm('Unlink SMS? This deletes the stored gateway credentials.')) return;
        try { await api('/api/me/sms/unlink', { method: 'POST' }); resetChannels(); flash('SMS unlinked and credentials deleted.'); view(); } catch (e) { if (!(e instanceof AuthError)) alert(e.message); }
      };
      return;
    }
    paint(`${SMS_NOTICE}
      <ol class="muted">
        <li>On an Android phone, install <strong>SMS Gateway for Android</strong> (sms-gate.app) and allow SMS permission.</li>
        <li><strong>Cloud mode</strong> (easiest): switch on "Cloud Server" in the app, tap Offline to go Online, and copy the username and password it shows.</li>
        <li><strong>Local server mode</strong>: switch on "Local Server" and use the phone's address (for example http://192.168.1.20:8080, or its Tailscale address) with the username and password shown there. The muop server must be able to reach the phone.</li>
      </ol>
      <div class="goals-grid">
        <label>Mode <select id="sms-mode"><option value="cloud">Cloud</option><option value="local">Local server</option></select></label>
        <label id="sms-url-wrap" class="hidden">Phone address <input id="sms-url" type="url" placeholder="http://192.168.1.20:8080" autocomplete="off"></label>
        <label>Username <input id="sms-user" autocomplete="off"></label>
        <label>Password <input id="sms-pass" type="password" autocomplete="new-password"></label>
      </div>
      <label class="check"><input type="checkbox" id="sms-accept"> I understand, link my phone's SMS</label>
      <p class="error" id="sms-error" role="status"></p>
      <div class="quick-actions"><button class="primary" id="sms-link" disabled>Link SMS</button></div>`);
    el('sms-mode').onchange = () => el('sms-url-wrap').classList.toggle('hidden', el('sms-mode').value !== 'local');
    el('sms-accept').onchange = () => { el('sms-link').disabled = !el('sms-accept').checked; };
    el('sms-link').onclick = async () => {
      el('sms-error').textContent = '';
      const body = { accept: true, mode: el('sms-mode').value, username: el('sms-user').value.trim(), password: el('sms-pass').value };
      if (body.mode === 'local') body.url = el('sms-url').value.trim();
      el('sms-link').disabled = true;
      try {
        await api('/api/me/sms/link', { method: 'POST', body: JSON.stringify(body) });
        resetChannels();
        flash('SMS linked. Send yourself a test to check it works.');
        view();
      } catch (e) { if (!(e instanceof AuthError)) { el('sms-error').textContent = e.message; el('sms-link').disabled = false; } }
    };
  }

  window.Messaging = { view, mountSend, invitePicker, smsHref, waHref, resetChannels };
})();
