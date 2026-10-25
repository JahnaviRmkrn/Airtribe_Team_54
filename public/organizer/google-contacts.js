// One-shot Google Contacts import. Only names/emails and opaque preview IDs
// reach the preview. Credentials and the PKCE verifier stay on the server,
// never browser storage. OAuth state travels only in the authorization URL.
window.GoogleContacts = (() => {
  const base = '/api/me/integrations/google/contacts';
  const messages = {
    denied: 'Google permission was declined. Nothing was imported. You can try again or add people manually.',
    expired: 'That Google connection expired or could not be verified. Nothing was imported. Please try again.',
    failed: 'Google could not connect. Nothing was imported. Please try again.',
    ready: 'Google connected for this import only. Review and select people before saving.',
  };

  async function view() {
    const nav = renderLoading('Preparing Google Contacts import...');
    let preview;
    let busy = false;
    let selection = new Map();
    let message = '';
    const params = new URLSearchParams(location.search || '');
    const outcome = params.get('google_import');
    if (outcome) {
      message = messages[outcome] || '';
      params.delete('google_import');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
    }

    const errorMessage = (err) => {
      if (!stale(nav) && !(err instanceof AuthError)) el('gc-error').textContent = err.message || 'Import unavailable. Please try again.';
    };
    const run = async (operation) => {
      if (busy || stale(nav)) return;
      busy = true;
      el('gc-error').textContent = '';
      buttons(true);
      try { await operation(); } catch (err) { errorMessage(err); }
      finally { busy = false; if (!stale(nav)) buttons(false); }
    };
    const buttons = (disabled) => {
      document.querySelectorAll('#gc-panel button, #gc-panel input, #gc-panel select').forEach((node) => { node.disabled = disabled || node.dataset.duplicate === 'true'; });
      const save = el('gc-save');
      if (save) save.disabled = disabled || !selection.size || selection.size > 5;
      const connect = el('gc-connect');
      if (connect) connect.disabled = disabled || !preview.configured;
    };
    const counter = () => {
      const count = el('gc-count');
      if (count) count.textContent = `${selection.size} selected (up to 5 per import)`;
      buttons(busy);
    };
    const refresh = async () => {
      const current = await api(base);
      if (stale(nav)) return false;
      preview = current;
      // Preserve categories only for still-eligible rows. Nothing is preselected.
      const eligible = new Set((preview.contacts || []).filter((c) => !c.duplicate).map((c) => c.id));
      selection = new Map([...selection].filter(([id]) => eligible.has(id)));
      return true;
    };
    const load = async () => {
      const current = await api(base + '/preview', { method: 'POST' });
      if (stale(nav)) return;
      preview = { ...preview, ...current };
      paint();
    };
    function paint() {
      if (stale(nav)) return;
      el('app').innerHTML = `
        <p><a href="#/contacts">← Back to Contacts</a></p>
        <section class="card" id="gc-panel">
          <h1>Import Google Contacts</h1>
          <p class="muted">This is separate from signing in with Google. We request read-only access to your contacts, use only names and one email address per person, and never send messages or change Google Contacts.</p>
          <p class="muted">Choose people and categories below. Nothing is saved until you click “Import selected”. Each batch is limited to 5; onboarding still has its separate 5-person limit.</p>
          <p role="status" id="gc-message">${esc(message)}</p>
          <p class="error" id="gc-error" role="alert"></p>
          ${!preview.configured ? '<p class="muted">Google Contacts import needs administrator setup. You can still add people manually from Contacts.</p>' : ''}
          ${!preview.ready ? `
            <button class="primary" id="gc-connect" ${!preview.configured ? 'disabled' : ''}>Connect Google and preview</button>
            ${preview.pending ? '<p class="muted">A previous connection was not finished. Connecting again starts a fresh import.</p><button id="gc-cancel">Cancel unfinished connection</button>' : ''}
          ` : `
            <p class="muted">The temporary preview expires after 15 minutes. Cancel &amp; disconnect discards the preview and this app’s temporary access, not contacts already imported. It does not remove the permission listed in your Google Account.</p>
            ${preview.truncated ? '<p role="status">Preview limited to the first 1,000 Google contacts. Search or organize contacts in Google before starting a new import if someone is missing.</p>' : ''}
            ${preview.skipped ? `<p class="muted">${Number(preview.skipped)} duplicate or unusable Google entries skipped.</p>` : ''}
            <p id="gc-count" role="status"></p>
            <div class="google-contact-preview">
              ${(preview.contacts || []).map((c) => `<div class="row gc-row">
                <label class="gc-person"><input type="checkbox" data-gc-select="${esc(c.id)}" data-duplicate="${!!c.duplicate}" ${c.duplicate ? 'disabled' : ''} ${selection.has(c.id) ? 'checked' : ''}>
                  <span><strong>${esc(c.name)}</strong><span class="muted gc-email">${esc(c.email || 'No email address')}${c.duplicate ? ' · Already in Contacts' : ''}</span></span>
                </label>
                <label>Category <select aria-label="Category for ${esc(c.name)}" data-gc-category="${esc(c.id)}" data-duplicate="${!!c.duplicate}" ${c.duplicate ? 'disabled' : ''}>
                  ${CATEGORIES.map((cat) => `<option value="${cat}" ${(selection.get(c.id) || 'personal') === cat ? 'selected' : ''}>${catLabel(cat)}</option>`).join('')}
                </select></label>
              </div>`).join('')}
              ${preview.loaded && !preview.contacts?.length ? '<p>No usable contacts were found. Nothing has been saved.</p>' : ''}
            </div>
            <div class="quick-actions">
              <button class="primary" id="gc-save" disabled>Import selected</button>
              ${preview.has_more ? `<button id="gc-more">${preview.loaded ? 'Load more contacts' : 'Load contact preview'}</button>` : ''}
              <button id="gc-cancel">Cancel &amp; disconnect</button>
            </div>
            <p class="muted">Existing people are skipped by matching email, or by name when an email is missing. No existing contact is overwritten.</p>
          `}
        </section>`;
      const connect = el('gc-connect');
      const humanAction = (event, operation) => {
        if (stale(nav)) return;
        // Native pointer and keyboard clicks are trusted; assistant DOM clicks
        // and synthetic events cannot grant access or confirm an import.
        if (event?.isTrusted !== true) { errorMessage(new Error('Review this action and activate this button yourself to confirm.')); return; }
        return run(operation);
      };
      if (connect) connect.onclick = (event) => humanAction(event, async () => {
        const result = await api(base + '/start', { method: 'POST' });
        if (stale(nav)) return;
        // Never navigate to a URL outside the expected Google authorization URL.
        const url = new URL(result.authorization_url);
        if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Google authorization is unavailable. Please retry.');
        location.assign(url.href);
      });
      const more = el('gc-more');
      if (more) more.onclick = () => run(load);
      const cancel = el('gc-cancel');
      if (cancel) cancel.onclick = () => run(async () => {
        await api(base + '/cancel', { method: 'POST' });
        if (stale(nav)) return;
        selection.clear();
        preview = { configured: true, ready: false };
        message = 'Temporary access and the preview were cleared. Previously imported contacts are unchanged.';
        paint();
      });
      document.querySelectorAll('[data-gc-select]').forEach((checkbox) => {
        checkbox.onchange = () => {
          const id = checkbox.dataset.gcSelect;
          if (checkbox.checked && selection.size >= 5) { checkbox.checked = false; el('gc-error').textContent = 'Choose up to 5 people per import. You can import another batch afterward.'; }
          else if (checkbox.checked) selection.set(id, document.querySelector(`[data-gc-category="${id}"]`).value);
          else selection.delete(id);
          counter();
        };
      });
      document.querySelectorAll('[data-gc-category]').forEach((select) => {
        select.onchange = () => { if (selection.has(select.dataset.gcCategory)) selection.set(select.dataset.gcCategory, select.value); };
      });
      const save = el('gc-save');
      if (save) save.onclick = (event) => humanAction(event, async () => {
        if (!selection.size || selection.size > 5) return;
        const result = await api(base + '/import', { method: 'POST', body: JSON.stringify({ selections: [...selection].map(([id, category]) => ({ id, category })) }) });
        if (stale(nav)) return;
        message = `${Number(result.added)} imported. ${Number(result.skipped)} already existed and were skipped.`;
        selection.clear();
        if (await refresh()) paint();
      });
      counter();
    }

    try {
      if (!await refresh()) return;
      paint();
      if (preview.ready && !preview.loaded) await run(load);
    } catch (error) { if (!stale(nav)) renderError(error, view); }
  }
  return { view };
})();
