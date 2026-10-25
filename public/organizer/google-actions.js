/* Explicit Google actions. No background sends, event inserts, browser tokens,
 * private-note prefills or automatic retries. Server previews own the content. */
(() => {
  let generation = 0;
  window.GoogleActions = {
    async render(purpose, context) {
      const { api, esc, isCurrent } = context;
      const run = ++generation;
      const active = () => generation === run && isCurrent();
      const app = document.getElementById('app');
      const base = '/api/me/integrations/google/' + purpose;
      const gmail = purpose === 'gmail';
      const title = gmail ? 'Send with Gmail' : 'Create a Google Calendar event';
      const send = (body) => api(base, { method: 'POST', body: JSON.stringify(body) });
      let view = 0;
      const live = (v) => active() && view === v;
      const field = (id) => document.getElementById(id);
      const frame = (content) => {
        view++;
        app.innerHTML = `<section class="google-action"><div class="page-head"><h1>${title}</h1></div>
          <p class="muted">Nothing is sent or created until you review the exact details and confirm. Leaving this page never starts an action.</p>${content}</section>`;
        return view;
      };
      const showError = (error) => { const out = field('ga-error'); if (out) out.textContent = error.message || 'Could not complete this request.'; };
      const refresh = () => { if (active()) window.GoogleActions.render(purpose, context); };
      function bind(id, callback) {
        const button = field(id); if (!button) return;
        const v = view; let busy = false;
        button.onclick = async (event) => {
          if (busy || !live(v) || button.disabled) return;
          // Browser-generated clicks include native keyboard activation. A model
          // calling element.click() cannot authorize consent or a saved action.
          if (['ga-confirm', 'ga-connect'].includes(id) && event?.isTrusted !== true) {
            showError(new Error('Review this action and activate this button yourself to confirm.'));
            return;
          }
          busy = true; button.disabled = true;
          try { await callback(v); } catch (error) { if (live(v)) showError(error); }
          finally { if (live(v)) { busy = false; button.disabled = false; } }
        };
      }
      function draftFromPreview(p) {
        return gmail ? { from: p.from, to: p.to, subject: p.subject, body: p.body } : {
          title: p.title, description: p.description, location: p.location, localStart: p.localStart, timeZone: p.timeZone,
          durationMinutes: p.durationMinutes, attendees: p.attendees, disambiguation: p.disambiguation, sendUpdates: p.sendUpdates,
        };
      }
      function renderAction(action) {
        const p = action.preview;
        const preview = !p ? '<p>The stored content has expired; the action history is retained to prevent replay.</p>' : gmail ? `
          <dl class="ga-details"><dt>From</dt><dd>${esc(p.from)}</dd><dt>Date header</dt><dd>${esc(new Date(action.createdAt).toUTCString())}</dd><dt>To</dt><dd>${p.to.map(esc).join('<br>')}</dd><dt>Subject</dt><dd>${esc(p.subject)}</dd></dl>
          <p class="muted">This is the sender address you entered, not an independently verified profile. Google must authorize this exact mailbox. No account or sender substitution is attempted.</p><h3>Plain-text message</h3><pre class="ga-text">${esc(p.body)}</pre>` : `
          <dl class="ga-details"><dt>Calendar</dt><dd>Primary calendar of the Google account selected when this preview was created</dd>
          <dt>Title</dt><dd>${esc(p.title)}</dd><dt>Starts</dt><dd>${esc(p.localStart.replace('T', ' '))} (${esc(p.timeZone)})<br><span class="muted">${esc(p.start)} UTC instant</span></dd>
          <dt>Ends</dt><dd>${esc(p.endLocal.replace('T', ' '))} (${esc(p.timeZone)})<br><span class="muted">${esc(p.end)} UTC instant</span></dd>
          <dt>Duration</dt><dd>${esc(p.durationMinutes)} elapsed minutes</dd><dt>Location</dt><dd>${esc(p.location || 'None')}</dd>
          <dt>Attendees</dt><dd>${p.attendees.length ? p.attendees.map(esc).join('<br>') : 'Only you; no attendees'}</dd>
          <dt>Notifications</dt><dd>${esc(p.notificationNote)}</dd><dt>Reminders</dt><dd>No event reminders added</dd></dl>
          <h3>Description</h3><pre class="ga-text">${esc(p.description || '(Empty)')}</pre>`;
        const pending = ['claimed', 'uncertain'].includes(action.state);
        const text = {
          preview: 'Review every detail below. Confirming sends this exact saved version, not later edits.',
          claimed: 'This action was claimed and may still be processing, or its result may be unknown. Do not send or create it again.',
          uncertain: 'The outcome is unknown. It may already have completed. Do not send or create it again.',
          completed: gmail ? 'Google accepted this email for sending. This does not confirm delivery.' : 'Google confirmed creation of this event. This does not confirm attendee acceptance or notification delivery.',
          rejected: 'Google rejected this request. This action will not be retried.',
          cancelled: 'This preview was cancelled before submission. Nothing was sent or created from this preview.',
          expired: 'This preview expired before submission. Create and review a fresh draft to continue.',
        }[action.state] || 'Check the saved action status.';
        frame(`<div class="card"><p role="status" class="${pending ? 'error' : ''}">${esc(text)}</p>${pending ? `<p>${gmail ? 'Check the selected Google account’s Sent mailbox yourself. Send-only access cannot read it.' : 'Check the selected Google account’s calendar, or use the read-only check below. A missing event is not proof that creation failed.'}</p>` : ''}
          ${preview}${gmail && action.state === 'preview' ? '<label class="ga-ack"><input type="checkbox" id="ga-sender-check"> I confirm the From address is the primary Gmail mailbox of the Google account I selected, not an alias.</label>' : ''}<p class="muted">Action reference: ${esc(action.id)}</p>
          <p id="ga-error" class="error" role="alert"></p><div class="ga-buttons">
          ${action.state === 'preview' ? `<button id="ga-confirm" ${gmail ? 'disabled' : ''}>${gmail ? 'Confirm and send email' : 'Confirm and create event'}</button><button id="ga-edit" class="secondary">Back to edit</button><button id="ga-cancel" class="secondary">Cancel preview</button>` : ''}
          <button id="ga-check" class="secondary">Check saved status</button>
          ${pending && !gmail ? '<button id="ga-reconcile" class="secondary">Check this event in Google (read only)</button>' : ''}
          <button id="ga-home" class="secondary">Back to ${gmail ? 'Gmail' : 'Calendar'}</button></div>
          ${action.state === 'preview' ? '<p class="muted">Once confirmed, leaving the page cannot undo a send or event creation.</p>' : ''}</div>`);
        if (gmail && action.state === 'preview') field('ga-sender-check').onchange = () => { field('ga-confirm').disabled = !field('ga-sender-check').checked; };
        bind('ga-confirm', async (v) => {
          if (gmail && !field('ga-sender-check').checked) return;
          // On transport failure never re-enable confirmation. The request may
          // have committed even though this browser did not receive a response.
          field('ga-confirm').textContent = gmail ? 'Sending…' : 'Creating…';
          ['ga-edit', 'ga-cancel', 'ga-sender-check'].forEach((id) => { if (field(id)) field(id).disabled = true; });
          try {
            const result = await send({ operation: 'confirm', id: action.id, previewHash: action.previewHash, confirmed: true, ...(gmail ? { senderAcknowledged: true } : {}) });
            if (live(v)) renderAction(result.action);
          } catch {
            if (live(v)) renderAction({ ...action, state: 'uncertain' });
          }
        });
        bind('ga-edit', async (v) => { const result = await send({ operation: 'cancel', id: action.id }); if (live(v)) { if (result.action.state === 'cancelled') compose(draftFromPreview(p)); else renderAction(result.action); } });
        bind('ga-cancel', async (v) => { const result = await send({ operation: 'cancel', id: action.id }); if (live(v)) renderAction(result.action); });
        bind('ga-check', async (v) => { const result = await api(base + '?id=' + encodeURIComponent(action.id)); if (live(v)) renderAction(result.action); });
        bind('ga-reconcile', async (v) => { const result = await send({ operation: 'reconcile', id: action.id }); if (live(v)) renderAction(result.action); });
        bind('ga-home', refresh);
      }
      function compose(draft = {}) {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        frame(`<form id="ga-form" class="card"><p>No contacts or private notes are added automatically. Enter only what you want to share.</p>
          ${gmail ? `
          <label>Your primary Gmail address<input id="ga-from" type="email" required maxlength="254" value="${esc(draft.from || '')}" autocomplete="off"></label>
          <p class="muted">Enter the primary mailbox address for the Google account you selected. This app cannot read your Google profile and does not support send-as aliases.</p>
          <label>Recipient email addresses, separated by commas<textarea id="ga-to" rows="2" required maxlength="6400">${esc((draft.to || []).join(', '))}</textarea></label>
          <label>Subject<input id="ga-subject" required maxlength="200" value="${esc(draft.subject || '')}"></label>
          <label>Plain-text message<textarea id="ga-body" rows="10" required maxlength="20000">${esc(draft.body || '')}</textarea></label>` : `
          <label>Title<input id="ga-title" required maxlength="200" value="${esc(draft.title || '')}"></label>
          <label>Description<textarea id="ga-description" rows="5" maxlength="10000">${esc(draft.description || '')}</textarea></label>
          <label>Location<input id="ga-location" maxlength="500" value="${esc(draft.location || '')}"></label>
          <div class="ga-grid"><label>Start date and time<input id="ga-start" type="datetime-local" required value="${esc(draft.localStart || '')}"></label>
          <label>IANA time zone<input id="ga-zone" required maxlength="100" value="${esc(draft.timeZone || zone)}" placeholder="Asia/Kolkata"></label>
          <label>Duration, in elapsed minutes<input id="ga-duration" type="number" min="1" max="10080" step="1" required value="${esc(draft.durationMinutes || 60)}"></label>
          <label>If the clocks move back<select id="ga-dst"><option value="reject">Ask me if the time occurs twice</option><option value="earlier">Use the earlier occurrence</option><option value="later">Use the later occurrence</option></select></label></div>
          <label>Attendee email addresses, separated by commas<textarea id="ga-attendees" rows="2" maxlength="6400">${esc((draft.attendees || []).join(', '))}</textarea></label>
          <label>Guest notification request<select id="ga-notifications"><option value="all">Notify all attendees</option><option value="none">Request no guest notifications</option></select></label>
          <p class="muted">Attendees can see the event details and attendee list. Google may still send some emails when notifications are off; external calendar syncing may be affected. No automatic reminders, recurrence or conferencing are added.</p>`}
          <p id="ga-error" class="error" role="alert"></p><p id="ga-status" role="status"></p>
          <div class="ga-buttons"><button type="submit" id="ga-preview">Review exact ${gmail ? 'email' : 'event'}</button><button type="button" id="ga-abandon" class="secondary">Cancel</button></div></form>`);
        if (!gmail) { field('ga-dst').value = draft.disambiguation || 'reject'; field('ga-notifications').value = draft.sendUpdates || 'all'; }
        const v = view; let pending = false;
        const form = field('ga-form');
        form.onsubmit = async (e) => {
          e.preventDefault(); if (pending || !live(v)) return;
          const split = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);
          const body = gmail ? { from: field('ga-from').value, to: split(field('ga-to').value), subject: field('ga-subject').value, body: field('ga-body').value } : {
            title: field('ga-title').value, description: field('ga-description').value, location: field('ga-location').value,
            localStart: field('ga-start').value, timeZone: field('ga-zone').value, durationMinutes: Number(field('ga-duration').value),
            attendees: split(field('ga-attendees').value), disambiguation: field('ga-dst').value, sendUpdates: field('ga-notifications').value,
          };
          pending = true; const controls = [...form.querySelectorAll('input,textarea,select,button')]; controls.forEach((c) => { c.disabled = true; });
          field('ga-error').textContent = ''; field('ga-status').textContent = 'Saving a preview. Nothing is being sent or created.';
          try { const result = await send({ operation: 'preview', draft: body }); if (live(v)) renderAction(result.action); }
          catch (error) { if (live(v)) showError(error); }
          finally { if (live(v)) { pending = false; controls.forEach((c) => { c.disabled = false; }); field('ga-status').textContent = ''; } }
        };
        bind('ga-abandon', refresh);
      }
      frame('<div class="card"><p role="status">Checking connection and saved actions…</p></div>');
      try {
        const status = await api(base); if (!active()) return;
        const disclosure = gmail
          ? 'Gmail permission only allows sending mail. This feature cannot read your inbox, contacts or Sent mailbox. You must enter and confirm that account’s primary Gmail address. It is not inferred from your muop sign-in account, and send-as aliases are not supported.'
          : 'Google’s owned-calendar event permission can view, create, change and delete events on calendars you own. This feature only creates your reviewed event in the selected account’s primary calendar, and can check that exact event after an uncertain result. It does not list calendars or other events.';
        frame(`<div class="card"><p>${esc(status.enabled ? disclosure : status.message)}</p>
          ${status.enabled ? `<p>${status.connected ? 'Temporary Google connection is ready.' : 'Connect the Google account you want to use. Connecting never sends an email or creates an event.'} Connections expire after 15 minutes. Reconnecting requires a fresh preview.</p><div class="ga-buttons">
          ${status.connected ? '<button id="ga-compose">Compose new draft</button><button id="ga-disconnect" class="secondary">Remove temporary connection</button>' : ''}
          <button id="ga-connect" class="secondary">${status.connected ? 'Choose a different Google account' : 'Connect Google for this purpose'}</button></div>` : '<p>You can keep using the rest of muop while setup is pending.</p>'}
          <p id="ga-error" class="error" role="alert"></p></div>
          ${(status.actions || []).length ? `<div class="card"><h2>Recent saved actions</h2><p class="muted">Unknown outcomes are never retried automatically.</p><div class="ga-history">${status.actions.map((a, i) => `<button id="ga-history-${i}" class="secondary">${esc(a.preview ? (gmail ? a.preview.subject : a.preview.title) : 'Expired content')} · ${esc(a.state)}</button>`).join('')}</div></div>` : ''}`);
        bind('ga-compose', () => compose());
        bind('ga-connect', async (v) => {
          const result = await send({ operation: 'start' }); if (!live(v)) return;
          const url = new URL(result.authorizationUrl);
          if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Unexpected Google connection destination.');
          location.assign(url.href);
        });
        bind('ga-disconnect', async (v) => { await send({ operation: 'disconnect' }); if (live(v)) refresh(); });
        (status.actions || []).forEach((a, i) => bind('ga-history-' + i, () => renderAction(a)));
      } catch (error) { if (active()) { frame('<div class="card"><p id="ga-error" class="error" role="alert"></p><button id="ga-reload">Check again</button></div>'); showError(error); bind('ga-reload', refresh); } }
    },
  };
})();
