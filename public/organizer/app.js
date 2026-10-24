// Organizer app - Team 54, AI Builders Day.
// Talks only to Person A's real API: same-origin /api/me/* with a Supabase
// cookie session. Nothing is ever sent automatically - every action is an
// explicit tap. All state lives on the server, so everything survives refresh.

const CATEGORIES = ['personal', 'professional', 'community'];
const ACTIVITIES = ['dinner', 'coffee', 'drinks', 'brunch', 'activity'];

const catLabel = (c) => (c ? c.charAt(0).toUpperCase() + c.slice(1) : '');
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const fmtDay = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
};
const toISO = (local) => (local ? new Date(local).toISOString() : undefined);
const parseInterests = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

// --- API ---------------------------------------------------------------

class AuthError extends Error {}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    const next = '/organizer/' + (location.hash || '');
    location.href = '/login?next=' + encodeURIComponent(next);
    throw new AuthError('Not signed in - redirecting to login.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || ('Request failed (' + res.status + ')'));
  }
  if (res.status === 204) return null;
  return res.json();
}

// --- routing -------------------------------------------------------------

function go(hash) { location.hash = hash; }

function route() {
  el('nav').classList.remove('hidden');
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', hash.startsWith('#/' + a.dataset.nav));
  });
  const contactMatch = hash.match(/^#\/contacts\/(.+)$/);
  if (contactMatch) return contactDetailView(decodeURIComponent(contactMatch[1]));
  const views = {
    '#/dashboard': dashboardView,
    '#/contacts': contactsView,
    '#/meetups': meetupsView,
    '#/onboarding': onboardingView,
  };
  (views[hash] || dashboardView)();
}

function renderLoading(msg) {
  el('app').innerHTML = '<div class="card state-box"><span class="spinner"></span><p class="muted">' + esc(msg || 'Loading...') + '</p></div>';
}

function renderError(err, retry) {
  if (err instanceof AuthError) return; // redirect already in flight
  el('app').innerHTML = `
    <div class="card error-card state-box">
      <p class="error">${esc(err.message || 'Something went wrong.')}</p>
      <button id="retry-btn">Try again</button>
    </div>`;
  el('retry-btn').onclick = retry;
}

function copyText(text, btn, label) {
  const done = () => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = label; }, 1500);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done);
  } else {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
    done();
  }
}

const roomUrl = (token) => location.origin + '/m/' + token;

// --- dashboard -----------------------------------------------------------

async function dashboardView() {
  renderLoading('Loading your dashboard...');
  let d;
  try {
    d = await api('/api/me/dashboard');
  } catch (e) { return renderError(e, dashboardView); }

  const counts = d.contact_counts || {};
  const totalContacts = CATEGORIES.reduce((s, c) => s + (counts[c] || 0), 0);
  const act = d.recorded_activity || { label: 'Recorded activity', total: 0, by_category: {}, sufficient_data: false };
  const followups = d.followups || { overdue: [], upcoming: [] };
  const meetups = d.upcoming_meetups || [];
  const recent = d.recent_activity || [];

  if (d.is_empty) {
    el('app').innerHTML = `
      <h1>Dashboard</h1>
      <div class="card state-box">
        <h2>Welcome to Organizer</h2>
        <p class="muted">Nothing here yet. Add your people and plan your first meetup.</p>
        <div class="quick-actions" style="justify-content:center">
          <button class="primary" id="qa-add">Add person</button>
          <button class="primary" id="qa-meetup">Plan a meetup</button>
        </div>
      </div>`;
    el('qa-add').onclick = () => { sessionStorage.setItem('org_new_contact', '1'); go('#/contacts'); };
    el('qa-meetup').onclick = () => go('#/meetups');
    return;
  }

  const followupRow = (f, overdue) => `
    <div class="row" data-fu-name="${esc(f.name || '')}">
      <div><strong>${esc(f.name || 'Someone')}</strong>
        ${f.category ? `<span class="tag">${esc(catLabel(f.category))}</span>` : ''}
        <div class="muted">${overdue ? 'Was due' : 'Due'} ${esc(fmtDate(f.next_followup_at))}</div>
      </div>
      <div class="actions"><button data-done="${esc(f.id || f.contact_id || '')}" data-name="${esc(f.name || '')}">Mark done</button></div>
    </div>`;

  el('app').innerHTML = `
    <h1>Dashboard</h1>
    <div class="stats">
      <div class="stat card">
        <div class="stat-num">${totalContacts}</div>
        <div class="stat-label">Contacts</div>
        <div class="muted">${CATEGORIES.map((c) => `${catLabel(c)} ${counts[c] || 0}`).join(' · ')}</div>
      </div>
      <div class="stat card">
        <div class="stat-num">${act.total || 0}</div>
        <div class="stat-label">${esc(act.label || 'Recorded activity')}</div>
        <div class="muted">interactions on record</div>
      </div>
    </div>
    ${act.sufficient_data && d.goals ? goalsComparison(d.goals, act) : ''}
    <div class="quick-actions">
      <button class="primary" id="qa-add">Add person</button>
      <button class="primary" id="qa-meetup">Plan a meetup</button>
    </div>
    <section class="card">
      <h2>Follow-ups</h2>
      ${(followups.overdue || []).map((f) => followupRow(f, true)).join('')}
      ${(followups.upcoming || []).map((f) => followupRow(f, false)).join('')}
      ${!(followups.overdue || []).length && !(followups.upcoming || []).length ? '<p class="muted">No follow-ups due.</p>' : ''}
    </section>
    <section class="card">
      <h2>Upcoming meetups</h2>
      ${meetups.length ? meetups.map((m) => `
        <div class="row">
          <div><strong>${esc(m.title)}</strong>
            ${m.activity ? `<span class="tag">${esc(m.activity)}</span>` : ''}
            <div class="muted">${[m.area, fmtDate(m.starts_at)].filter(Boolean).join(' · ')}</div>
            ${m.room_token ? `<div class="muted mono">${esc(roomUrl(m.room_token))}</div>` : ''}
          </div>
          ${m.room_token ? `<div class="actions"><button data-copy="${esc(roomUrl(m.room_token))}">Copy link</button></div>` : ''}
        </div>`).join('') : '<p class="muted">No meetups planned.</p>'}
    </section>
    <section class="card">
      <h2>Recent activity</h2>
      ${recent.length ? recent.map((r) => `
        <div class="row">
          <div><strong>${esc((r.contact && r.contact.name) || 'Someone')}</strong>
            ${r.contact && r.contact.category ? `<span class="tag">${esc(catLabel(r.contact.category))}</span>` : ''}
            <div class="muted">${esc((r.type || '').replace(/_/g, ' '))} · ${esc(fmtDate(r.occurred_at))}</div>
            ${r.notes ? `<div class="muted">${esc(r.notes)}</div>` : ''}
          </div>
        </div>`).join('') : '<p class="muted">No activity recorded yet.</p>'}
    </section>`;

  el('qa-add').onclick = () => { sessionStorage.setItem('org_new_contact', '1'); go('#/contacts'); };
  el('qa-meetup').onclick = () => go('#/meetups');
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b, 'Copy link'); });
  document.querySelectorAll('[data-done]').forEach((b) => { b.onclick = () => markDoneForm(b); });
}

function goalsComparison(goals, act) {
  const total = act.total || 0;
  const rows = CATEGORIES.map((c) => {
    const goal = goals[c] || 0;
    const actual = total ? Math.round(((act.by_category || {})[c] || 0) / total * 100) : 0;
    return `
      <div class="goal-bar">
        <div class="row spread"><span>${catLabel(c)}</span>
          <span class="muted">goal ${goal}% · actual ${actual}%</span></div>
        <div class="bar-track">
          <div class="bar-actual" style="width:${Math.min(actual, 100)}%"></div>
        </div>
      </div>`;
  }).join('');
  return `<section class="card"><h2>Goals vs activity</h2>${rows}
    <p class="muted">Bars show where your recorded activity actually went, against your goals.</p></section>`;
}

// --- mark a follow-up done ------------------------------------------------

function markDoneForm(btn) {
  const row = btn.closest('.row');
  const contactId = btn.dataset.done;
  row.innerHTML = `
    <div style="flex:1">
      <strong>${esc(btn.dataset.name || 'Follow-up')}</strong>
      <label>Note <input id="fu-note" placeholder="How was the check-in?"></label>
      <label>Next follow-up (optional) <input id="fu-next" type="date"></label>
      <p class="muted">Leave the date blank to schedule by this person's check-in frequency.</p>
      <p class="error" id="fu-error"></p>
      <div class="actions">
        <button class="primary" id="fu-save">Save</button>
        <button id="fu-cancel">Cancel</button>
      </div>
    </div>`;
  el('fu-cancel').onclick = () => dashboardView();
  el('fu-save').onclick = async () => {
    el('fu-save').disabled = true;
    const body = { contact_id: contactId, type: 'check_in', notes: el('fu-note').value.trim() };
    const next = el('fu-next').value;
    if (next) body.next_followup_at = new Date(next + 'T12:00:00').toISOString();
    try {
      await api('/api/me/interactions', { method: 'POST', body: JSON.stringify(body) });
      dashboardView();
    } catch (e) {
      el('fu-save').disabled = false;
      el('fu-error').textContent = e.message;
    }
  };
}

// --- contacts --------------------------------------------------------------

async function contactsView() {
  renderLoading('Loading contacts...');
  const filter = sessionStorage.getItem('org_filter') || '';
  let contacts;
  try {
    const r = await api('/api/me/contacts' + (filter ? '?category=' + encodeURIComponent(filter) : ''));
    contacts = Array.isArray(r) ? r : (r.contacts || []);
  } catch (e) { return renderError(e, contactsView); }

  el('app').innerHTML = `
    <h1>Contacts</h1>
    <section class="card">
      <h2>Add person</h2>
      <form id="add-form">
        <div class="form-grid">
          <label>Name <input id="c-name" placeholder="Name" required></label>
          <label>Category
            <select id="c-cat">${CATEGORIES.map((c) => `<option value="${c}">${catLabel(c)}</option>`).join('')}</select>
          </label>
          <label class="full">Interests <input id="c-interests" placeholder="hiking, chai, board games (comma-separated)"></label>
          <label>Check in every (days) <input id="c-freq" type="number" min="1" value="14"></label>
          <label>Next follow-up <input id="c-next" type="date"></label>
          <label class="full">Notes <input id="c-notes" placeholder="Notes"></label>
        </div>
        <p class="error" id="add-error"></p>
        <button class="primary" type="submit">Add</button>
      </form>
    </section>
    <section class="card">
      <div class="row spread">
        <h2>Your people</h2>
        <select id="filter" style="width:auto">
          <option value="">All categories</option>
          ${CATEGORIES.map((c) => `<option value="${c}" ${c === filter ? 'selected' : ''}>${catLabel(c)}</option>`).join('')}
        </select>
      </div>
      <div id="contact-list">
        ${contacts.length ? contacts.map(contactRow).join('') : '<p class="muted">' + (filter ? 'No ' + filter + ' contacts yet.' : 'No contacts yet.') + '</p>'}
      </div>
    </section>`;

  el('filter').onchange = () => { sessionStorage.setItem('org_filter', el('filter').value); contactsView(); };
  el('add-form').onsubmit = async (e) => {
    e.preventDefault();
    el('add-error').textContent = '';
    const body = {
      name: el('c-name').value.trim(),
      category: el('c-cat').value,
      interests: parseInterests(el('c-interests').value),
      notes: el('c-notes').value.trim(),
    };
    const freq = parseInt(el('c-freq').value, 10);
    if (freq > 0) body.preferred_frequency_days = freq;
    const next = el('c-next').value;
    if (next) body.next_followup_at = new Date(next + 'T12:00:00').toISOString();
    try {
      await api('/api/me/contacts', { method: 'POST', body: JSON.stringify(body) });
      contactsView();
    } catch (err) { el('add-error').textContent = err.message; }
  };
  document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => go('#/contacts/' + encodeURIComponent(b.dataset.view)); });
  if (sessionStorage.getItem('org_new_contact')) {
    sessionStorage.removeItem('org_new_contact');
    el('c-name').focus();
  }
}

function contactRow(c) {
  return `
    <div class="row">
      <div><strong>${esc(c.name)}</strong> <span class="tag">${esc(catLabel(c.category))}</span>
        ${(c.interests || []).length ? `<div class="interest-pills">${c.interests.map((i) => `<span class="tag">${esc(i)}</span>`).join('')}</div>` : ''}
        ${c.next_followup_at ? `<div class="muted">Next check-in: ${esc(fmtDay(c.next_followup_at))}</div>` : ''}
      </div>
      <div class="actions"><button data-view="${esc(c.id)}">Open</button></div>
    </div>`;
}

// --- contact detail: profile + history, edit, delete ------------------------

async function contactDetailView(id) {
  renderLoading('Loading contact...');
  let contact, interactions;
  try {
    const r = await api('/api/me/contacts/' + encodeURIComponent(id));
    contact = r.contact || r;
    interactions = r.interactions || [];
  } catch (e) { return renderError(e, () => contactDetailView(id)); }

  el('app').innerHTML = `
    <p><button class="link-btn" id="back">← All contacts</button></p>
    <section class="card" id="profile-card">
      <div class="row spread">
        <h2>${esc(contact.name)}</h2>
        <div class="actions">
          <button id="c-edit">Edit</button>
          <button class="danger" id="c-del">Delete</button>
        </div>
      </div>
      <p><span class="tag">${esc(catLabel(contact.category))}</span></p>
      ${(contact.interests || []).length ? `<p class="interest-pills">${contact.interests.map((i) => `<span class="tag">${esc(i)}</span>`).join('')}</p>` : ''}
      ${contact.notes ? `<p>${esc(contact.notes)}</p>` : ''}
      <p class="muted">Check in every ${contact.preferred_frequency_days || 14} days
        ${contact.last_interaction_at ? ' · last interaction ' + esc(fmtDay(contact.last_interaction_at)) : ''}
        ${contact.next_followup_at ? ' · next check-in ' + esc(fmtDay(contact.next_followup_at)) : ''}</p>
    </section>
    <section class="card">
      <h2>Add a check-in</h2>
      <form id="log-form">
        <label>Note <input id="log-note" placeholder="What happened?"></label>
        <label>Next follow-up (optional) <input id="log-next" type="date"></label>
        <p class="error" id="log-error"></p>
        <button class="primary" type="submit">Save check-in</button>
      </form>
    </section>
    <section class="card">
      <h2>History</h2>
      ${interactions.length ? interactions.map((i) => `
        <div class="row">
          <div><strong>${esc((i.type || 'interaction').replace(/_/g, ' '))}</strong>
            <div class="muted">${esc(fmtDate(i.occurred_at))}</div>
            ${i.notes ? `<div class="muted">${esc(i.notes)}</div>` : ''}
          </div>
        </div>`).join('') : '<p class="muted">No interactions recorded yet.</p>'}
    </section>`;

  el('back').onclick = () => go('#/contacts');
  el('c-del').onclick = async () => {
    if (!confirm('Delete ' + (contact.name || 'this contact') + '?')) return;
    try {
      await api('/api/me/contacts/' + encodeURIComponent(id), { method: 'DELETE' });
      go('#/contacts');
    } catch (e) { alert(e.message); }
  };
  el('c-edit').onclick = () => editContactForm(id, contact);
  el('log-form').onsubmit = async (e) => {
    e.preventDefault();
    el('log-error').textContent = '';
    const body = { contact_id: id, type: 'check_in', notes: el('log-note').value.trim() };
    const next = el('log-next').value;
    if (next) body.next_followup_at = new Date(next + 'T12:00:00').toISOString();
    try {
      await api('/api/me/interactions', { method: 'POST', body: JSON.stringify(body) });
      contactDetailView(id);
    } catch (err) { el('log-error').textContent = err.message; }
  };
}

function editContactForm(id, c) {
  const card = el('profile-card');
  card.innerHTML = `
    <h2>Edit ${esc(c.name)}</h2>
    <div class="form-grid">
      <label>Name <input id="e-name" value="${esc(c.name)}"></label>
      <label>Category
        <select id="e-cat">${CATEGORIES.map((x) => `<option value="${x}" ${x === c.category ? 'selected' : ''}>${catLabel(x)}</option>`).join('')}</select>
      </label>
      <label class="full">Interests <input id="e-interests" value="${esc((c.interests || []).join(', '))}"></label>
      <label>Check in every (days) <input id="e-freq" type="number" min="1" value="${c.preferred_frequency_days || 14}"></label>
      <label>Next follow-up <input id="e-next" type="date" value="${c.next_followup_at ? esc(new Date(c.next_followup_at).toISOString().slice(0, 10)) : ''}"></label>
      <label class="full">Notes <input id="e-notes" value="${esc(c.notes || '')}"></label>
    </div>
    <p class="error" id="e-error"></p>
    <div class="actions">
      <button class="primary" id="e-save">Save</button>
      <button id="e-cancel">Cancel</button>
    </div>`;
  el('e-cancel').onclick = () => contactDetailView(id);
  el('e-save').onclick = async () => {
    el('e-error').textContent = '';
    const patch = {};
    const name = el('e-name').value.trim();
    if (name !== c.name) patch.name = name;
    const cat = el('e-cat').value;
    if (cat !== c.category) patch.category = cat;
    const interests = parseInterests(el('e-interests').value);
    if (JSON.stringify(interests) !== JSON.stringify(c.interests || [])) patch.interests = interests;
    const notes = el('e-notes').value.trim();
    if (notes !== (c.notes || '')) patch.notes = notes;
    const freq = parseInt(el('e-freq').value, 10);
    if (freq > 0 && freq !== c.preferred_frequency_days) patch.preferred_frequency_days = freq;
    const nextVal = el('e-next').value;
    const oldNext = c.next_followup_at ? new Date(c.next_followup_at).toISOString().slice(0, 10) : '';
    if (nextVal !== oldNext) patch.next_followup_at = nextVal ? new Date(nextVal + 'T12:00:00').toISOString() : null;
    if (!Object.keys(patch).length) return contactDetailView(id);
    try {
      await api('/api/me/contacts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) });
      contactDetailView(id);
    } catch (err) { el('e-error').textContent = err.message; }
  };
}

// --- meetups -----------------------------------------------------------------

async function meetupsView(created) {
  renderLoading('Loading meetups...');
  let meetups;
  try {
    const r = await api('/api/me/meetups');
    meetups = Array.isArray(r) ? r : (r.meetups || []);
  } catch (e) { return renderError(e, () => meetupsView()); }

  el('app').innerHTML = `
    <h1>Meetups</h1>
    ${created ? createdCard(created) : ''}
    <section class="card">
      <h2>Plan a meetup</h2>
      <p class="muted">Guests join through the room link - nothing is sent automatically.</p>
      <form id="m-form">
        <div class="form-grid">
          <label class="full">Title <input id="m-title" required placeholder="Coffee catch-up"></label>
          <label>Activity
            <select id="m-activity">${ACTIVITIES.map((a) => `<option>${a}</option>`).join('')}</select>
          </label>
          <label>Area <input id="m-area" placeholder="Indiranagar"></label>
          <label>Date &amp; time (optional) <input id="m-when" type="datetime-local"></label>
          <label>Budget per person (₹, optional) <input id="m-budget" type="number" min="0" step="50" placeholder="500"></label>
        </div>
        <p class="error" id="m-error"></p>
        <button class="primary" type="submit">Create meetup</button>
      </form>
    </section>
    <section class="card">
      <h2>Planned</h2>
      ${meetups.length ? meetups.map(meetupRow).join('') : '<p class="muted">No meetups yet.</p>'}
    </section>`;

  el('m-form').onsubmit = async (e) => {
    e.preventDefault();
    el('m-error').textContent = '';
    const body = { title: el('m-title').value.trim(), activity: el('m-activity').value };
    if (el('m-area').value.trim()) body.area = el('m-area').value.trim();
    const when = el('m-when').value;
    if (when) body.starts_at = toISO(when);
    const budget = parseInt(el('m-budget').value, 10);
    if (budget > 0) body.budget = budget;
    try {
      const r = await api('/api/me/meetups', { method: 'POST', body: JSON.stringify(body) });
      meetupsView(r);
    } catch (err) { el('m-error').textContent = err.message; }
  };
  wireMeetupRows();
}

function createdCard(r) {
  const m = r.meetup || {};
  const url = m.room_url || (m.room_token ? roomUrl(m.room_token) : '');
  return `
    <section class="card" id="created-card">
      <h2>Meetup created</h2>
      <p><strong>${esc(m.title || 'Your meetup')}</strong> is ready. Share the room link yourself - nothing is sent for you.</p>
      ${url ? `<p class="muted mono" id="room-url-text">${esc(url)}</p>
      <div class="quick-actions">
        <button class="primary" id="copy-room">Copy link</button>
        ${r.invite_text ? '<button id="copy-invite">Copy invite text</button>' : ''}
        <a href="${esc(url)}" target="_blank" rel="noopener"><button type="button">Open room</button></a>
      </div>` : ''}
      ${r.invite_text ? `<div class="invite-box">${esc(r.invite_text)}</div>` : ''}
    </section>`;
}

function meetupRow(m) {
  const url = m.room_url || (m.room_token ? roomUrl(m.room_token) : '');
  const closed = (m.status || 'open') !== 'open';
  return `
    <div class="row">
      <div><strong>${esc(m.title)}</strong>
        ${m.activity ? `<span class="tag">${esc(m.activity)}</span>` : ''}
        <span class="tag ${closed ? 'status-closed' : 'status-open'}">${esc(m.status || 'open')}</span>
        <div class="muted">${[m.area, fmtDate(m.starts_at), m.budget ? '₹' + m.budget + ' per person' : ''].filter(Boolean).join(' · ')}</div>
        ${url ? `<div class="muted mono">${esc(url)}</div>` : ''}
      </div>
      <div class="actions">
        ${url ? `<button data-copy="${esc(url)}">Copy link</button>` : ''}
        ${!closed ? `<button class="danger" data-close="${esc(m.id)}">Close</button>` : ''}
      </div>
    </div>`;
}

function wireMeetupRows() {
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b, 'Copy link'); });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Close this meetup? Guests will no longer be able to vote.')) return;
      try {
        await api('/api/me/meetups/' + encodeURIComponent(b.dataset.close), { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
        meetupsView();
      } catch (e) { alert(e.message); }
    };
  });
  const copyRoom = el('copy-room');
  if (copyRoom) copyRoom.onclick = () => copyText(el('room-url-text').textContent, copyRoom, 'Copy link');
  const copyInvite = el('copy-invite');
  if (copyInvite) copyInvite.onclick = () => copyText(document.querySelector('#created-card .invite-box').textContent, copyInvite, 'Copy invite text');
}

// --- onboarding: editable confirm screen ---------------------------------------
// C's voice extraction can pre-fill by setting window.ORGANIZER_PREFILL or
// sessionStorage 'org_prefill' to { contacts: [...], goals: {...} } before load.

function prefill() {
  try {
    const raw = window.ORGANIZER_PREFILL || sessionStorage.getItem('org_prefill');
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return p && typeof p === 'object' ? p : {};
  } catch { return {}; }
}

function emptyRow() { return { name: '', category: 'personal', interests: '', freq: 14 }; }

function onboardingView() {
  const p = prefill();
  const rows = (p.contacts && p.contacts.length ? p.contacts.slice(0, 5) : [emptyRow()]).map((c) => ({
    name: c.name || '',
    category: CATEGORIES.includes(c.category) ? c.category : 'personal',
    interests: Array.isArray(c.interests) ? c.interests.join(', ') : (c.interests || ''),
    freq: c.preferred_frequency_days || 14,
  }));
  const goals = { personal: 50, professional: 30, community: 20, ...(p.goals || {}) };
  let step = 1;

  const finish = () => {
    localStorage.setItem('org_onboarded', '1');
    sessionStorage.removeItem('org_prefill');
    go('#/dashboard');
  };

  function renderStep1() {
    el('app').innerHTML = `
      <section class="card">
        <div class="step-dots">Step 1 of 2 · People</div>
        <h1>Who do you want to stay in touch with?</h1>
        <p class="muted">Add up to 5 people. You can edit everything before confirming - nothing is saved yet.</p>
        <div id="ob-rows"></div>
        <p><button class="link-btn" id="ob-add">+ Add another</button></p>
        <p class="error" id="ob-error"></p>
        <div class="quick-actions">
          <button class="primary" id="ob-next">Next: goals</button>
          <button id="ob-skip">Skip for now</button>
        </div>
      </section>`;
    renderRows();
    el('ob-add').onclick = () => {
      if (rows.length >= 5) { el('ob-error').textContent = 'Up to 5 people for now - you can add more from Contacts later.'; return; }
      rows.push(emptyRow());
      renderRows();
    };
    el('ob-next').onclick = () => {
      collectRows();
      step = 2;
      renderStep2();
    };
    el('ob-skip').onclick = finish;
  }

  function renderRows() {
    el('ob-rows').innerHTML = rows.map((r, i) => `
      <div class="ob-row" data-row="${i}">
        <label>Name <input data-f="name" value="${esc(r.name)}" placeholder="Name"></label>
        <label>Category <select data-f="category">${CATEGORIES.map((c) => `<option value="${c}" ${c === r.category ? 'selected' : ''}>${catLabel(c)}</option>`).join('')}</select></label>
        <label>Interests <input data-f="interests" value="${esc(r.interests)}" placeholder="hiking, chai"></label>
        <label>Every (days) <input data-f="freq" type="number" min="1" value="${r.freq}"></label>
        ${rows.length > 1 ? '<button class="danger remove-row" data-rm="' + i + '">×</button>' : '<span></span>'}
      </div>`).join('');
    document.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { collectRows(); rows.splice(parseInt(b.dataset.rm, 10), 1); renderRows(); };
    });
  }

  function collectRows() {
    document.querySelectorAll('.ob-row').forEach((rowEl, i) => {
      rows[i] = {
        name: rowEl.querySelector('[data-f=name]').value.trim(),
        category: rowEl.querySelector('[data-f=category]').value,
        interests: rowEl.querySelector('[data-f=interests]').value,
        freq: parseInt(rowEl.querySelector('[data-f=freq]').value, 10) || 14,
      };
    });
  }

  function renderStep2() {
    el('app').innerHTML = `
      <section class="card">
        <div class="step-dots">Step 2 of 2 · Goals</div>
        <h1>How do you want to split your attention?</h1>
        <p class="muted">Must total 100%.</p>
        <div class="goals-grid">
          ${CATEGORIES.map((c) => `<label>${catLabel(c)} <input type="number" class="goal-input" data-cat="${c}" min="0" max="100" value="${goals[c] || 0}"></label>`).join('')}
        </div>
        <p>Total: <strong id="goals-total">0</strong>%</p>
        <p class="error" id="ob-error"></p>
        <div class="quick-actions">
          <button id="ob-back">Back</button>
          <button class="primary" id="ob-confirm">Confirm</button>
          <button id="ob-skip">Skip for now</button>
        </div>
      </section>`;
    const inputs = [...document.querySelectorAll('.goal-input')];
    const total = () => inputs.reduce((s, i) => s + (parseInt(i.value, 10) || 0), 0);
    const refresh = () => { el('goals-total').textContent = total(); };
    inputs.forEach((i) => { i.oninput = refresh; });
    refresh();
    el('ob-back').onclick = renderStep1;
    el('ob-skip').onclick = finish;
    el('ob-confirm').onclick = async () => {
      el('ob-error').textContent = '';
      if (total() !== 100) {
        el('ob-error').textContent = 'Goals must total 100% - currently ' + total() + '%.';
        return;
      }
      el('ob-confirm').disabled = true;
      const goalBody = Object.fromEntries(inputs.map((i) => [i.dataset.cat, parseInt(i.value, 10) || 0]));
      const contacts = rows.filter((r) => r.name).slice(0, 5).map((r) => ({
        name: r.name,
        category: r.category,
        interests: parseInterests(r.interests),
        preferred_frequency_days: r.freq,
      }));
      try {
        if (contacts.length) {
          await api('/api/me/contacts', { method: 'POST', body: JSON.stringify({ contacts }) });
        }
        await api('/api/me/goals', { method: 'PUT', body: JSON.stringify(goalBody) });
        finish();
      } catch (e) {
        el('ob-confirm').disabled = false;
        el('ob-error').textContent = e.message;
      }
    };
  }

  renderStep1();
}

// --- boot ------------------------------------------------------------------------

async function boot() {
  renderLoading();
  let d;
  try {
    d = await api('/api/me/dashboard');
  } catch (e) {
    if (e instanceof AuthError) return; // redirecting to /login
    return renderError(e, boot);
  }
  const onboarded = localStorage.getItem('org_onboarded') === '1';
  const hash = location.hash || '#/dashboard';
  if (d.is_empty && !onboarded && hash !== '#/onboarding') {
    return go('#/onboarding');
  }
  window.onhashchange = route;
  route();
}

boot();
