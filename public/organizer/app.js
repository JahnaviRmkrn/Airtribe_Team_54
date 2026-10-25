// Organizer app - Team 54, AI Builders Day.
// Talks only to Person A's real API: same-origin /api/me/* with a Supabase
// cookie session. Nothing is ever sent automatically - every action is an
// explicit tap. Contact-create retry intents also use owner-scoped browser storage.

const CATEGORIES = ['personal', 'professional', 'community'];
const ACTIVITIES = ['dinner', 'coffee', 'drinks', 'brunch', 'activity'];

const catLabel = (c) => (c ? c.charAt(0).toUpperCase() + c.slice(1) : '');
const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
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
// Follow-ups are calendar dates in Bengaluru (Asia/Kolkata), matching
// lib/due.ts. Keep these separate from device-local meetup/history timestamps.
const FOLLOWUP_TIME_ZONE = 'Asia/Kolkata';
const followupDayFormatter = new Intl.DateTimeFormat('en', {
  timeZone: FOLLOWUP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const followupDay = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const parts = followupDayFormatter.formatToParts(d);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
};
const fmtFollowupDay = (iso) => {
  if (!followupDay(iso)) return '';
  return new Date(iso).toLocaleDateString(undefined, { timeZone: FOLLOWUP_TIME_ZONE, dateStyle: 'medium' });
};
// A date-only input means noon IST, never noon in the device's timezone.
// Existing instants stay untouched when an edit/retry leaves the date unchanged.
const followupISO = (day) => {
  if (!day) return undefined;
  const d = new Date(day + 'T12:00:00+05:30');
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(day) || followupDay(d) !== day) {
    throw new Error('Choose a valid follow-up date.');
  }
  return d.toISOString();
};
// Whole IST calendar days: < 0 overdue, 0 today, null unscheduled/invalid.
// UTC midnight is only arithmetic on date labels, not a stored due instant.
const dueIn = (iso, now = new Date()) => {
  const due = followupDay(iso), today = followupDay(now);
  if (!due || !today) return null;
  return Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
};
const toISO = (local) => (local ? new Date(local).toISOString() : undefined);
const parseInterests = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

// --- API ---------------------------------------------------------------

class AuthError extends Error {}

async function api(path, opts = {}, authContext = 'view') {
  // A late auth failure belongs to the view that started this request, not
  // a newer navigation (including a hash change before hashchange runs).
  const requestNav = navGen;
  const requestHash = location.hash || '';
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    const currentHash = location.hash || '';
    // Boot reads authenticate before the hash router exists. A hash-only
    // change still belongs to that boot, but a newer generation never does.
    if (!stale(requestNav) && (authContext === 'boot' || currentHash === requestHash)) {
      const next = '/organizer/' + currentHash;
      location.href = '/login?next=' + encodeURIComponent(next);
    }
    throw new AuthError('Not signed in - redirecting to login.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.error || ('Request failed (' + res.status + ')'));
    error.code = err.code;
    error.status = res.status;
    throw error;
  }
  if (res.status === 201 && opts.method === 'POST' && path === '/api/me/meetups') {
    window.team54Track?.('meetup_created');
  }
  if (res.status === 204) return null;
  return res.json();
}

// A retry is a saved create intent, not a name match. Keep only the current
// intent for each owner/surface; never adopt another account's pending payload.
let contactCreateOwner = null;
let contactCreateRetryEnabled = false;
const contactIntentMemory = new Map();
function browserStore(kind, operation, ...args) {
  try { return window[kind][operation](...args); } catch { return null; }
}
function contactIntentStorageKey(kind) {
  if (!contactCreateOwner) throw new Error('Reload this page before saving contacts.');
  return 'org_contact_create_v1:' + contactCreateOwner + ':' + kind;
}
function readContactIntent(kind) {
  const key = contactIntentStorageKey(kind);
  let latest = contactIntentMemory.get(key) || null;
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      const value = JSON.parse(browserStore(storage, 'getItem', key) || 'null');
      if (value && value.version === 1 && typeof value.key === 'string' &&
          ['pending', 'complete'].includes(value.state) && Number.isFinite(value.updatedAt) &&
          (!latest || value.updatedAt > latest.updatedAt)) latest = value;
    } catch { /* Damaged storage is not a valid retry receipt. */ }
  }
  if (latest) contactIntentMemory.set(key, latest);
  return latest;
}
function writeContactIntent(kind, value) {
  const key = contactIntentStorageKey(kind);
  const previous = readContactIntent(kind);
  const entry = { ...value, version: 1, updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1) };
  contactIntentMemory.set(key, entry);
  const serialized = JSON.stringify(entry);
  let durable = false;
  for (const storage of ['localStorage', 'sessionStorage']) {
    browserStore(storage, 'setItem', key, serialized);
    if (browserStore(storage, 'getItem', key) === serialized) durable = true;
  }
  return durable;
}
function pendingContactIntent(kind) {
  const entry = contactCreateOwner && readContactIntent(kind);
  return entry?.state === 'pending' ? entry : null;
}
function startNewContactIntent(kind) {
  if (pendingContactIntent(kind) && !confirm('The previous save may already have succeeded. Check Contacts first. Starting a new add can create another person, even with identical details. Start a new add anyway?')) return false;
  writeContactIntent(kind, { key: '', state: 'complete', body: null });
  return true;
}
function acknowledgeContactIntent(kind, action) {
  // An old tab must not erase a newer deliberate create in another tab.
  if (action.entry && readContactIntent(kind)?.key === action.entry.key) {
    writeContactIntent(kind, { key: '', state: 'complete', body: null });
  }
}
function contactRetryBlocked(entry) {
  if (!entry) return '';
  if (entry.mode === 'legacy') return 'An earlier save may already have succeeded. Check Contacts before starting a new add. This save cannot be safely retried.';
  if (!contactCreateRetryEnabled) return 'Safe contact retries are temporarily unavailable. Check Contacts or wait until safe retries are available; this pending save will not be sent without its original key.';
  return '';
}
function contactRetryNotice(entry) {
  return contactRetryBlocked(entry) || (contactCreateRetryEnabled
    ? (entry ? 'An earlier save is awaiting confirmation. Retry these original details safely, then edit the saved person if needed.' : 'Retries reuse the same save key. Refresh recovery needs browser storage; if it is blocked, keep this tab open.')
    : 'Retry-safe saving is not enabled. If a save response is lost, check Contacts before adding again.');
}
function checkContactRetryBody(entry, body) {
  const blocked = contactRetryBlocked(entry);
  if (blocked) throw new Error(blocked);
  if (entry && JSON.stringify(entry.body) !== JSON.stringify(body)) {
    throw new Error('A previous save may already have succeeded. Retry the original details first, then edit the saved person. Or check Contacts and choose Start a new add.');
  }
}
async function createContactsOnce(kind, body, action) {
  const owner = action?.owner || contactCreateOwner;
  if (owner !== contactCreateOwner) throw new Error('Your signed-in account changed. Reload before saving.');
  const serialized = JSON.stringify(body);
  const stored = pendingContactIntent(kind);
  let entry = action?.entry || stored;
  checkContactRetryBody(entry, body);
  if (!entry) entry = { key: crypto.randomUUID(), mode: contactCreateRetryEnabled ? 'keyed' : 'legacy', state: 'pending', body: JSON.parse(serialized), attempts: 0 };
  // Missing mode means a pre-rollout keyed intent, never a legacy fallback.
  const keyed = entry.mode !== 'legacy';
  // Missing attempt history is conservatively treated as uncertain. Persist
  // the attempt before sending, so refresh cannot erase an ambiguous outcome.
  const priorAttempts = Number.isInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 1;
  entry = { ...entry, attempts: priorAttempts + 1 };
  if (action) action.entry = entry;
  // Legacy markers prevent accidental resubmission after an uncertain response;
  // their local ID is NOT sent as a server idempotency key or called retry-safe.
  const durable = stored && stored.key !== entry.key ? false : writeContactIntent(kind, entry);
  try {
    const receipt = await api('/api/me/contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Contact-Owner': owner, ...(keyed ? { 'Idempotency-Key': entry.key } : {}) },
      body: serialized,
    });
    return receipt;
  } catch (error) {
    // A first request explicitly rejected before any DB call is safe to edit.
    // Never clear on generic 400s, DB errors, or after a prior uncertain attempt:
    // a later schema change cannot disprove an earlier committed creation.
    const latest = readContactIntent(kind);
    if (error.code === 'contact_input_rejected' && priorAttempts === 0 && latest?.key === entry.key && latest.attempts === 1) {
      acknowledgeContactIntent(kind, action || { entry });
      if (action) action.entry = null;
    } else if (!(error instanceof AuthError)) {
      if (!keyed) error.message += ' ' + contactRetryBlocked(entry);
      if (!durable) error.message += keyed
        ? ' This retry is only available in this tab: keep this tab open to retry safely. After a refresh, check Contacts before adding again.'
        : ' Browser recovery storage is unavailable. After a refresh, check Contacts before adding again.';
    }
    throw error;
  }
}

// --- routing -------------------------------------------------------------

function go(hash) { location.hash = hash; }

// mailto: hand-off - opens the user's own mail app with a ready message.
function mailtoHref(to, subject, body) {
  return 'mailto:' + encodeURIComponent(to || '').replace(/%40/g, '@')
    + '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body || '');
}
function checkInEmail(c) {
  const first = String(c.name || '').split(/\s+/)[0] || 'there';
  const about = (c.interests || []).length ? ` How's the ${c.interests[0]} going?` : '';
  return mailtoHref(c.email, 'Catching up', `Hi ${first},\n\nIt's been a while - I was just thinking of you.${about} Free for a coffee or a call this week?\n\nCheers`);
}
function meetupInviteEmail(m, url) {
  const when = m.starts_at ? ' on ' + fmtDate(m.starts_at) : '';
  return mailtoHref('', `Join me: ${m.title}`, `Hi!\n\nI'm planning "${m.title}"${when}${m.area ? ' around ' + m.area : ''}. Pick a venue and tell us when you're free here:\n${url}\n\nNo sign-up needed. See you there!`);
}

// Every view, including direct refreshes and synchronous pages, invalidates
// outstanding work. Late reads or mutations must not paint over a newer view.
let navGen = 0;
const stale = (token) => token !== navGen;

// In-app back stack: pages you came from inside the app, latest last. Back
// pops instead of pushing, so two taps can never ping-pong. Never leaves the
// SPA, so state in other views survives exactly like ordinary nav taps.
let currentHash = null;
let navStack = [];
let goingBack = false;

function route() {
  navGen++;
  window.OrganizerOnboarding = null;
  el('app').className = 'container';
  el('nav').classList.remove('hidden');
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', hash.startsWith('#/' + a.dataset.nav));
  });
  // Topbar back button: hidden on the first page, everywhere else goes to the
  // last in-app page - or the dashboard when entered directly (no history).
  const backBtn = el('nav-back');
  if (backBtn) {
    backBtn.classList.toggle('hidden', hash === '#/dashboard');
    backBtn.onclick = () => {
      const target = navStack.length ? navStack.pop() : '#/dashboard'; // direct entry: fall back to the first page
      goingBack = true;
      go(target);
    };
  }
  if (goingBack) goingBack = false;
  else if (currentHash && currentHash !== hash) navStack.push(currentHash);
  if (navStack.length > 50) navStack = navStack.slice(-50);
  currentHash = hash;
  if (hash === '#/gmail' || hash === '#/calendar') {
    const token = navGen;
    return window.GoogleActions.render(hash.slice(2), { api, esc, isCurrent: () => !stale(token) });
  }
  const contactMatch = hash.match(/^#\/contacts\/(.+)$/);
  if (contactMatch) return contactDetailView(decodeURIComponent(contactMatch[1]));
  const meetupEditMatch = hash.match(/^#\/meetups\/([^/]+)\/edit$/);
  if (meetupEditMatch) return meetupEditView(decodeURIComponent(meetupEditMatch[1]));
  const views = {
    '#/dashboard': dashboardView,
    '#/contacts': contactsView,
    '#/google-contacts': () => window.GoogleContacts.view(),
    '#/meetups': meetupsView,
    '#/onboarding': () => onboardingView(),
    '#/welcome': welcomeView,
    '#/profile': profileView,
  };
  (views[hash] || dashboardView)();
}

function renderLoading(msg) {
  const version = ++navGen;
  el('app').innerHTML = '<div class="card state-box"><span class="spinner"></span><p class="muted">' + esc(msg || 'Loading...') + '</p></div>';
  return version;
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

// A disabled button alone does not stop keyboard/programmatic submissions.
// Keep the guard synchronous, scoped to this rendered form, and ignore callbacks
// from older views. Contact creates also use durable idempotency below; other
// creates still only have this in-flight guard.
function wireCreateForm(formId, prefix, nav, pendingText, save) {
  const form = el(formId), button = el(prefix + '-submit');
  const error = el(prefix + '-error'), status = el(prefix + '-status');
  let pending = false;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (pending || stale(nav)) return;
    pending = true;
    const controls = [...new Set([button, ...form.querySelectorAll('input, select, textarea, button')])];
    const disabled = controls.map((control) => control.disabled);
    const label = button.textContent;
    controls.forEach((control) => { control.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    button.textContent = pendingText;
    status.textContent = pendingText;
    error.textContent = '';
    try {
      await save();
    } catch (err) {
      if (!stale(nav)) error.textContent = err.message;
    } finally {
      pending = false;
      if (!stale(nav)) {
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
        form.removeAttribute('aria-busy');
        button.textContent = label;
        status.textContent = '';
      }
    }
  };
}

// Room QR code: scan from a phone and join with no account. The generator is
// loaded only when someone taps "QR code", pinned with SRI like Leaflet/ElevenLabs.
const QR_JS = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const QR_SRI = 'sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k';
let qrLoading = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  qrLoading ??= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: QR_JS, integrity: QR_SRI, crossOrigin: 'anonymous', async: true });
    s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('QR library missing')));
    s.onerror = () => { qrLoading = null; reject(new Error('Could not load the QR code generator')); };
    document.head.appendChild(s);
  });
  return qrLoading;
}
async function toggleQr(btn) {
  const row = btn.closest('.row');
  const open = row.nextElementSibling;
  if (open && open.classList.contains('qr-slot')) { open.remove(); btn.textContent = 'QR code'; return; }
  const slot = document.createElement('div');
  slot.className = 'qr-slot';
  slot.innerHTML = '<p class="muted">Loading QR code...</p>';
  row.after(slot);
  btn.textContent = 'Hide QR';
  try {
    const qrcode = await loadQr();
    const qr = qrcode(0, 'M');
    qr.addData(btn.dataset.qr);
    qr.make();
    slot.innerHTML = `<div class="qr-box">${qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true, alt: 'QR code for the meetup room', title: 'Meetup room' })}</div>
      <p class="muted">Guests scan this to open the room on their phone. No account or app needed.</p>`;
  } catch (e) {
    slot.innerHTML = `<p class="error">${esc(e.message || 'Could not make the QR code')}. Use Copy link instead.</p>`;
  }
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

// --- draft a check-in message ------------------------------------------
// "Then you send the message": asks the server (DeepSeek, template fallback)
// for a short check-in text. Shown editable with Copy / Open in WhatsApp -
// nothing is ever sent for the user.

function rowSlot(btn) {
  const row = btn.closest('.row');
  const next = row.nextElementSibling;
  if (next && next.classList.contains('draft-slot')) return next;
  const slot = document.createElement('div');
  slot.className = 'draft-slot';
  return slot;
}

function draftPanel(container, contactId, name) {
  const existing = container.querySelector('.draft-box');
  if (existing) { existing.remove(); return; }
  const box = document.createElement('div');
  box.className = 'draft-box';
  container.appendChild(box);
  const load = async () => {
    box.innerHTML = '<p class="muted">Drafting a message for ' + esc(name || 'them') + '...</p>';
    try {
      const r = await api('/api/me/contacts/' + encodeURIComponent(contactId) + '/draft', { method: 'POST' });
      box.innerHTML = `
        <label class="draft-label">Suggested message <span class="muted">(${r.source === 'template' ? 'template' : 'drafted by ' + esc(r.source === 'deepseek' ? 'DeepSeek' : 'AI')} - edit before sending)</span>
          <textarea class="draft-text" rows="3">${esc(r.message)}</textarea>
        </label>
        ${(r.basis || []).length ? `<p class="draft-basis muted">Based on: ${(r.basis).map((b) => esc(b)).join(' · ')}</p>` : ''}
        <div class="actions">
          <button class="primary draft-copy">Copy</button>
          <a class="button-link draft-wa" target="_blank" rel="noopener">Open in WhatsApp</a>
          <button class="draft-again">Try another</button>
        </div>`;
      const text = box.querySelector('.draft-text');
      const wa = box.querySelector('.draft-wa');
      const syncWa = () => { wa.href = 'https://wa.me/?text=' + encodeURIComponent(text.value); };
      syncWa();
      text.oninput = syncWa;
      box.querySelector('.draft-copy').onclick = (e) => copyText(text.value, e.currentTarget, 'Copy');
      box.querySelector('.draft-again').onclick = load;
    } catch (e) {
      if (e instanceof AuthError) return;
      box.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  };
  load();
}

// --- dashboard -----------------------------------------------------------

// "Your people": every contact, soonest check-in first, with a due badge.
function peopleCard(contacts) {
  const due = (c) => dueIn(c.next_followup_at);
  const badge = (n) => n === null ? '' : n < 0 ? '<span class="due due-late">overdue</span>'
    : n === 0 ? '<span class="due due-today">today</span>'
    : n <= 7 ? '<span class="due">soon</span>' : `<span class="due">in ${n} days</span>`;
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const people = contacts.slice().sort((a, b) => (due(a) ?? 1e9) - (due(b) ?? 1e9) || String(a.name || '').localeCompare(String(b.name || '')));
  return `
    <section class="card people-card">
      <h2>Your people</h2>
      <p class="muted">${people.length} ${people.length === 1 ? 'person' : 'people'} on your mind. A little time for your people goes a long way.</p>
      ${people.length ? `<ul class="people-list">${people.map((c) => `
        <li><button class="person" data-person="${esc(c.id || '')}">
          <span class="avatar avatar-${esc(c.category || 'personal')}">${esc(initials(c.name))}</span>
          <span class="person-info"><strong>${esc(c.name || 'Someone')}</strong>
            <span class="muted">${esc(catLabel(c.category))}${c.interests && c.interests.length ? ' · ' + esc([].concat(c.interests).slice(0, 2).join(', ')) : ''}</span></span>
          ${badge(due(c))}
        </button></li>`).join('')}</ul>` : '<p class="muted">No one yet. Add your people to see them here.</p>'}
    </section>`;
}

async function dashboardView() {
  const nav = renderLoading('Loading your dashboard...');
  let d, graphContacts = [];
  try {
    d = await api('/api/me/dashboard');
    if (stale(nav)) return;
    try {
      const rc = await api('/api/me/contacts');
      if (stale(nav)) return;
      graphContacts = Array.isArray(rc) ? rc : (rc.contacts || []);
    } catch { graphContacts = []; }
  } catch (e) { if (stale(nav)) return; return renderError(e, dashboardView); }

  const counts = d.contact_counts || {};
  const totalContacts = CATEGORIES.reduce((s, c) => s + (counts[c] || 0), 0);
  const act = d.recorded_activity || { label: 'Recorded activity', total: 0, by_category: {}, sufficient_data: false };
  const followups = d.followups || { overdue: [], upcoming: [] };
  const meetups = d.upcoming_meetups || [];

  if (d.is_empty) {
    if (stale(nav)) return;
  el('app').innerHTML = `
      <h1>Dashboard</h1>
      <div class="card state-box">
        <h2>Welcome to muop 💛</h2>
        <p class="muted">Nothing here yet. Add your favourite people and plan your first get-together.</p>
        <div class="quick-actions" style="justify-content:center">
          <button class="primary" id="qa-add">Add person</button>
          <button class="primary" id="qa-meetup">Plan a meetup</button>
        </div>
        <p><button class="link-btn" id="qa-guide">What can muop do?</button></p>
      </div>`;
    el('qa-guide').onclick = () => go('#/welcome');
    el('qa-add').onclick = () => { browserStore('sessionStorage', 'setItem', 'org_new_contact', '1'); go('#/contacts'); };
    el('qa-meetup').onclick = () => go('#/meetups');
    return;
  }

  const followupActions = (f) => `
      <div class="actions">
        <button data-draft="${esc(f.id || f.contact_id || '')}" data-name="${esc(f.name || '')}">Draft message</button>
        <button data-done="${esc(f.id || f.contact_id || '')}" data-name="${esc(f.name || '')}">Mark done</button>
      </div>`;
  const followupRow = (f) => {
    const n = dueIn(f.next_followup_at);
    return `
    <div class="row" data-fu-name="${esc(f.name || '')}">
      <div><strong>${esc(f.name || 'Someone')}</strong>
        ${f.category ? `<span class="tag">${esc(catLabel(f.category))}</span>` : ''}${n < 0 ? ' <span class="tag overdue">Overdue</span>' : ''}
        <div class="muted">${n === null ? 'No check-in scheduled' : n < 0 ? `Was due ${esc(fmtFollowupDay(f.next_followup_at))}` : n === 0 ? 'Due today' : `Due ${esc(fmtFollowupDay(f.next_followup_at))}`}</div>
      </div>${followupActions(f)}
    </div>`;
  };

  if (stale(nav)) return;
  const allFollowups = [...(followups.overdue || []), ...(followups.upcoming || [])]
    .sort((a, b) => (dueIn(a.next_followup_at) ?? 1e9) - (dueIn(b.next_followup_at) ?? 1e9));
  const nOver = allFollowups.filter((f) => dueIn(f.next_followup_at) < 0).length;
  const nWeek = allFollowups.filter((f) => { const n = dueIn(f.next_followup_at); return n !== null && n >= 0 && n <= 7; }).length;
  const nMeet = meetups.length;
  const chip = (n, label, cls, target) => `<button class="sum-chip ${cls}" data-jump="${target}"><span class="sum-num">${n}</span><span>${label}</span></button>`;
  const summary = `<div class="summary" role="group" aria-label="At a glance">
      ${chip(nOver, nOver === 1 ? 'check-in overdue' : 'check-ins overdue', nOver ? 'warn' : 'ok', 'sec-followups')}
      ${chip(nWeek, 'due this week', 'soon', 'sec-followups')}
      ${chip(nMeet, nMeet === 1 ? 'meetup planned' : 'meetups planned', 'meet', 'sec-meetups')}
    </div>`;

  el('app').className = 'container wide';
  el('app').innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="muted lede">${nOver ? 'A few people are waiting to hear from you.' : 'You are up to date. Nice.'}</p></div>
      <div class="quick-actions">
        <button class="primary" id="qa-add">Add person</button>
        <button class="primary" id="qa-meetup">Plan a meetup</button>
      </div>
    </div>
    ${summary}
    ${guideCardHTML()}
    <div class="dash-grid">
    <section class="card">
      <h2>Your network</h2>
      <p class="muted">Each dot is a person, grouped by category. The closer to the centre, the sooner a check-in is due.</p>
      ${networkGraphSVG(graphContacts)}
    </section>
    <section class="card">
      <h2>Calendar</h2>
      <p class="muted">This month. Tap a day to see what is on it.</p>
      ${calendarHTML(graphContacts, meetups)}
    </section>
    </div>
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
    <div class="dash-grid">
    <section class="card" id="sec-followups">
      <h2>Follow-ups</h2>
      ${allFollowups.map(followupRow).join('')}
      ${!allFollowups.length ? '<p class="muted">No follow-ups due.</p>' : ''}
    </section>
    <section class="card" id="sec-meetups">
      <h2>Upcoming meetups</h2>
      ${meetups.length ? meetups.map((m) => `
        <div class="row">
          <div><strong>${esc(m.title)}</strong>
            ${m.activity ? `<span class="tag">${esc(m.activity)}</span>` : ''}
            <div class="muted">${esc([m.area, fmtDate(m.starts_at)].filter(Boolean).join(' · '))}</div>
            ${m.room_token ? `<div class="muted mono">${esc(roomUrl(m.room_token))}</div>` : ''}
          </div>
          ${m.room_token ? `<div class="actions"><a class="button" href="${esc(roomUrl(m.room_token))}" target="_blank" rel="noopener">Open room</a><button data-copy="${esc(roomUrl(m.room_token))}">Copy link</button><button data-qr="${esc(roomUrl(m.room_token))}">QR code</button></div>` : ''}
        </div>`).join('') : '<p class="muted">No meetups planned yet. Plan one to get people together.</p>'}
    </section>
    </div>
    ${peopleCard(graphContacts)}`;

  document.querySelectorAll('[data-person]').forEach((b) => { b.onclick = () => go('#/contacts/' + encodeURIComponent(b.dataset.person)); });
  el('qa-add').onclick = () => { browserStore('sessionStorage', 'setItem', 'org_new_contact', '1'); go('#/contacts'); };
  el('qa-meetup').onclick = () => go('#/meetups');
  document.querySelectorAll('[data-jump]').forEach((b) => { b.onclick = () => el(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  wireCalendar();
  wireGuideCard();
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b, 'Copy link'); });
  document.querySelectorAll('[data-qr]').forEach((b) => { b.onclick = () => toggleQr(b); });
  document.querySelectorAll('[data-done]').forEach((b) => { b.onclick = () => markDoneForm(b); });
  document.querySelectorAll('[data-draft]').forEach((b) => {
    b.onclick = () => draftPanel(b.closest('.row').parentElement.insertBefore(rowSlot(b), b.closest('.row').nextSibling), b.dataset.draft, b.dataset.name);
  });
  document.querySelectorAll('[data-gcontact]').forEach((n) => {
    const pick = () => {
      document.querySelectorAll('.g-dot.sel').forEach((x) => x.classList.remove('sel'));
      n.classList.add('sel');
      const box = el('graph-pick');
      if (!box) return;
      box.innerHTML = `<div><strong>${esc(n.dataset.gname)}</strong><div class="muted">${esc(n.dataset.gsub)}</div></div><button class="primary" id="graph-open">Open</button>`;
      el('graph-open').onclick = () => go('#/contacts/' + encodeURIComponent(n.dataset.gcontact));
    };
    n.onclick = pick;
    n.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  });
}

// --- network graph (dashboard) -------------------------------------------
// Sectors = real contact categories; rings = real follow-up timing buckets
// (overdue / due within 7 days / later or unscheduled). No invented ranks.

function networkGraphSVG(contacts) {
  const SIZE = 520, C = SIZE / 2;
  const RINGS = [92, 158, 220];
  const BANDS = [[36, 86], [100, 152], [166, 214]];
  const RING_LABELS = ['Overdue', 'This week', 'Later'];
  const DOT_FILL = { personal: '#E89B00', professional: '#04C1E1', community: '#3FAE9C' };
  const urgency = (c) => {
    const n = dueIn(c.next_followup_at);
    if (n === null) return 2;
    if (n < 0) return 0;
    if (n <= 7) return 1;
    return 2;
  };
  // Deterministic layout: dots in the same category + timing slot are spread
  // evenly across the sector (+-36deg) and over staggered radii, so they never
  // overlap. Ring labels sit on the gap between sectors (straight down).
  const slots = {};
  (contacts || []).forEach((c) => {
    const ci = Math.max(0, CATEGORIES.indexOf(c.category));
    (slots[ci + '-' + urgency(c)] = slots[ci + '-' + urgency(c)] || []).push(c);
  });
  const LABEL_W = 46, ROW_GAP = 25, HALF = 30;
  const dots = Object.entries(slots).map(([key, list]) => {
    const [ci, u] = key.split('-').map(Number);
    list.sort((x, y) => String(x.name || '').localeCompare(String(y.name || '')));
    const [r0, r1] = BANDS[u];
    const rows = Math.max(1, Math.min(Math.floor((r1 - r0) / ROW_GAP) + 1, Math.ceil(list.length / 2)));
    const showLabels = list.length <= rows * Math.max(1, Math.floor((2 * HALF * Math.PI / 180 * ((r0 + r1) / 2)) / LABEL_W));
    return list.map((c, i) => {
      const row = i % rows, k = Math.floor(i / rows);
      const inRow = Math.ceil((list.length - row) / rows);
      const r = rows === 1 ? (r0 + r1) / 2 : r0 + (r1 - r0) * row / (rows - 1);
      const step = 2 * HALF / inRow;
      const angleDeg = ci * 120 - 90 - HALF + step * (k + 0.5) + (rows > 1 ? (row % 2 ? 1 : -1) * step / 4 : 0);
      const a = angleDeg * Math.PI / 180;
      const x = C + r * Math.cos(a), y = C + r * Math.sin(a);
      const sub = followupDay(c.next_followup_at) ? ' · next check-in ' + fmtFollowupDay(c.next_followup_at) : ' · no check-in date';
      const first = String(c.name || '').split(/\s+/)[0].slice(0, 9);
      return `<g class="g-dot" data-gcontact="${esc(c.id || '')}" data-gname="${esc(c.name || 'Someone')}" data-gsub="${esc(catLabel(c.category) + sub)}" tabindex="0" role="link" aria-label="${esc((c.name || 'Someone') + sub)}"><circle class="g-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="20" fill="transparent"/><circle class="g-vis" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="${DOT_FILL[c.category] || '#9a9a9a'}" stroke="#fff" stroke-width="2"><title>${esc((c.name || 'Someone') + sub)}</title></circle>${showLabels ? `<text x="${x.toFixed(1)}" y="${(y + 20).toFixed(1)}" text-anchor="middle" class="graph-dot-label">${esc(first)}</text>` : ''}</g>`;
    }).join('');
  }).join('');
  const rings = RINGS.map((r) => `<circle cx="${C}" cy="${C}" r="${r}" fill="none" stroke="rgba(60,42,20,0.18)" stroke-width="1" stroke-dasharray="4 5"/>`).join('');
  const ringLabels = RING_LABELS.map((t, i) => {
    const r = (BANDS[i][0] + BANDS[i][1]) / 2;
    return `<text x="${C}" y="${(C + r + 4).toFixed(1)}" text-anchor="middle" class="graph-ring-label">${t}</text>`;
  }).join('');
  const spokes = CATEGORIES.map((cname, i) => {
    const a = (i * 120 - 90) * Math.PI / 180;
    const x2 = C + RINGS[2] * Math.cos(a), y2 = C + RINGS[2] * Math.sin(a);
    const lx = C + (RINGS[2] + 24) * Math.cos(a), ly = C + (RINGS[2] + 24) * Math.sin(a) + 4;
    return `<line x1="${C}" y1="${C}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(60,42,20,0.12)" stroke-width="1"/>` +
      `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" class="graph-sector-label" fill="${DOT_FILL[cname]}">${catLabel(cname)}</text>`;
  }).join('');
  const legend = CATEGORIES.map((cname) =>
    `<span class="graph-legend-item"><i style="background:${DOT_FILL[cname]}"></i>${catLabel(cname)}</span>`).join('');
  if (!(contacts || []).length) return '<p class="muted">Add your people to see them here.</p>';
  return `<div class="network-graph"><svg viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Network graph of your contacts">
    <circle cx="${C}" cy="${C}" r="${RINGS[2]}" fill="rgba(255,255,255,0.55)" stroke="rgba(60,42,20,0.22)" stroke-width="1"/>
    ${rings}${spokes}${ringLabels}
    <circle cx="${C}" cy="${C}" r="12" fill="#3d2b1f"/><text x="${C}" y="${(C + 4)}" text-anchor="middle" class="graph-you">You</text>
    ${dots}
  </svg><div class="graph-pick" id="graph-pick" aria-live="polite"><span class="muted">Tap a person to see who they are.</span></div><div class="graph-legend">${legend}</div></div>`;
}

// --- calendar (dashboard) --------------------------------------------------
// Current month grid; entries come only from real follow-up and meetup dates.

// Calendar markers. Colour = status (red: overdue, you haven't connected;
// yellow: due soon, turns red if you don't reach out). Icon = network:
// professional 💼, personal ❤️, community ● dot; meetups 📅.
const CAT_ICON = { professional: '💼', personal: '❤️', community: '●' };
const lateText = (n) => `${n} day${n === 1 ? '' : 's'} overdue`;
function calMarker(e) {
  if (e.kind === 'meetup') return `<i class="cal-mark meetup" title="${esc(e.label)}">📅</i>`;
  const tip = e.label + (e.status === 'overdue' ? ` - not connected, ${lateText(e.late)}` : ' - due soon');
  return `<i class="cal-mark ${e.status} cat-${esc(e.cat || 'personal')}" title="${esc(tip)}">${CAT_ICON[e.cat] || '●'}</i>`;
}
function calLine(e) {
  if (e.kind === 'meetup') return `Meetup: ${esc(e.label)}${e.time ? ` · ${esc(e.time)}` : ''} (device time)`;
  return e.status === 'overdue'
    ? `Haven't connected with <strong>${esc(e.label)}</strong> · ${lateText(e.late)}`
    : `Check in with ${esc(e.label)} (IST)`;
}

function calendarHTML(contacts, meetups) {
  const now = new Date();
  const today = followupDay(now);
  // The grid shows the current IST month, but mixes IST check-in dates with
  // device-local meetup dates. There is deliberately no shared Today cell;
  // separate summaries below use each event type's actual calendar day.
  const first = new Date(today.slice(0, 7) + '-01T00:00:00Z');
  const monthName = first.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const startOffset = first.getUTCDay();
  const last = new Date(first); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  const daysInMonth = last.getUTCDate();
  const events = {};
  const add = (day, ev) => {
    if (day.slice(0, 7) !== today.slice(0, 7)) return;
    const n = Number(day.slice(8, 10));
    (events[n] = events[n] || []).push(ev);
  };
  const overdue = [], dueToday = [], meetupsToday = [];
  const localDay = (t) => [t.getFullYear(), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0')].join('-');
  const deviceToday = localDay(now);
  (contacts || []).forEach((c) => {
    const n = dueIn(c.next_followup_at, now);
    if (n === null) return;
    const day = followupDay(c.next_followup_at);
    const late = -n;
    const ev = { kind: 'followup', status: late > 0 ? 'overdue' : 'soon', id: c.id, cat: c.category, label: c.name || 'Someone', late };
    if (late > 0) overdue.push(ev);
    if (n === 0) dueToday.push(ev);
    add(day, ev);
  });
  (meetups || []).forEach((m) => {
    const t = m.starts_at && new Date(m.starts_at);
    if (t && !isNaN(t)) {
      const day = localDay(t);
      const ev = { kind: 'meetup', label: m.title || 'Meetup', time: t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) };
      // A device-today meetup must remain visible even when IST has already
      // moved into another month and the grid cannot contain its local date.
      if (day === deviceToday) meetupsToday.push(ev);
      add(day, ev);
    }
  });
  overdue.sort((x, y) => y.late - x.late);
  // Read by wireCalendar() for the day detail panel.
  window.__calEvents = events;
  window.__calToday = today;

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push('<div class="cal-cell cal-pad"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const evs = events[day] || [];
    const cls = (evs.length ? ' has-ev' : '') + (evs.some((e) => e.status === 'overdue') ? ' cal-late' : '');
    const marks = evs.slice(0, 3).map(calMarker).join('') + (evs.length > 3 ? `<span class="cal-more">+${evs.length - 3}</span>` : '');
    const tip = evs.map((e) => (e.kind === 'meetup' ? 'Meetup: ' : e.status === 'overdue' ? 'Not connected: ' : 'Check-in: ') + e.label).join('; ');
    cells.push(`<button type="button" class="cal-cell${cls}" data-day="${day}" aria-label="${esc(monthName.split(' ')[0] + ' ' + day + (tip ? ': ' + tip : ': nothing planned'))}"><span class="cal-day">${day}</span><span class="cal-dots">${marks}</span></button>`);
  }
  const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<div class="cal-head">${d}</div>`).join('');
  const todayLabel = now.toLocaleDateString(undefined, { timeZone: FOLLOWUP_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const meetupZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const deviceTodayLabel = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  // Both due-today and overdue check-ins keep the Follow-ups card actions.
  const followupLine = (e) => `<li class="${e.status === 'overdue' ? 'late ' : ''}row"><span class="cal-line">${calMarker(e)}<span>${calLine(e)}</span></span>${e.id ? `
      <div class="actions">
        <button data-draft="${esc(e.id)}" data-name="${esc(e.label)}">Draft message</button>
        <button data-done="${esc(e.id)}" data-name="${esc(e.label)}">Mark done</button>
      </div>` : ''}</li>`;
  return `<div class="calendar">
    <section aria-label="Check-ins today in Asia/Kolkata">
      <div class="cal-todaybar"><strong>Check-ins today (IST)</strong> ${esc(todayLabel)}</div>
      ${dueToday.length ? `<ul class="cal-todaylist">${dueToday.map(followupLine).join('')}</ul>` : '<p class="muted">No check-ins due today.</p>'}
    </section>
    ${overdue.length ? `<div class="cal-overdue-count">${overdue.length} overdue check-in${overdue.length === 1 ? '' : 's'} (IST)</div><ul class="cal-todaylist">${overdue.map(followupLine).join('')}</ul>` : '<p class="cal-ok">No overdue check-ins.</p>'}
    <section aria-label="Meetups today in ${esc(meetupZone)}">
      <div class="cal-todaybar"><strong>Upcoming meetups today (${esc(meetupZone)})</strong> ${esc(deviceTodayLabel)}</div>
      ${meetupsToday.length ? `<ul class="cal-todaylist">${meetupsToday.map((e) => `<li>${calMarker(e)}<span>${calLine(e)}</span></li>`).join('')}</ul>` : '<p class="muted">No upcoming meetups today.</p>'}
    </section>
    <p class="muted">Calendar dates: check-ins use IST (Asia/Kolkata); meetups use your device (${esc(meetupZone)}). Today is shown separately above.</p>
    <div class="cal-month">${esc(monthName)} (current IST month)</div><div class="cal-grid">${names}${cells.join('')}</div>
    <div class="cal-detail" id="cal-detail" aria-live="polite"></div>
    <div class="graph-legend">
      <span class="graph-legend-item"><i class="cal-mark overdue">●</i>Haven't connected (overdue)</span>
      <span class="graph-legend-item"><i class="cal-mark soon">●</i>Due soon - turns red</span>
      <span class="graph-legend-item">💼 Professional</span><span class="graph-legend-item">❤️ Personal</span><span class="graph-legend-item">● Community</span>
      <span class="graph-legend-item">📅 Meetup</span>
    </div></div>`;
}

function wireCalendar() {
  const ev = window.__calEvents || {};
  const today = window.__calToday || followupDay(new Date());
  const box = el('cal-detail');
  if (!box) return;
  const show = (day) => {
    const list = ev[day] || [];
    document.querySelectorAll('.cal-cell[data-day]').forEach((b) => b.classList.toggle('selected', Number(b.dataset.day) === Number(day)));
    const when = new Date(today.slice(0, 8) + String(day).padStart(2, '0') + 'T00:00:00Z').toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
    box.innerHTML = `<strong>Calendar date: ${esc(when)}</strong>` + (list.length
      ? list.map((e) => `<div class="cal-item${e.status === 'overdue' ? ' late' : ''}">${calMarker(e)}<span>${calLine(e)}</span></div>`).join('')
      : '<div class="muted">Nothing planned.</div>');
  };
  document.querySelectorAll('.cal-cell[data-day]').forEach((b) => { b.onclick = () => show(b.dataset.day); });
  show(Number(today.slice(8, 10)));
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
    <p class="muted">Bars show where your recorded activity actually went, against your goals. This counts check-ins you logged, not the closeness of any relationship - a quiet week with no notes is not a failing friendship.</p></section>`;
}

// --- mark a follow-up done ------------------------------------------------

function markDoneForm(btn) {
  const nav = navGen;
  const row = btn.closest('.row');
  const contactId = btn.dataset.done;
  const field = (name) => row.querySelector('[data-fu="' + name + '"]');
  row.innerHTML = `
    <div style="flex:1">
      <strong>${esc(btn.dataset.name || 'Follow-up')}</strong>
      <label>Note <input data-fu="note" placeholder="How was the check-in?"></label>
      <label>Next follow-up (IST, optional) <input data-fu="next" type="date"></label>
      <p class="muted">Leave the date blank to schedule by this person's check-in frequency.</p>
      <p class="error" data-fu="error"></p>
      <div class="actions">
        <button class="primary" data-fu="save">Save</button>
        <button data-fu="cancel">Cancel</button>
      </div>
    </div>`;
  field('cancel').onclick = () => dashboardView();
  field('save').onclick = async () => {
    field('save').disabled = true;
    const body = { contact_id: contactId, type: 'check_in', notes: field('note').value.trim() };
    const next = field('next').value;
    try {
      if (next) body.next_followup_at = followupISO(next);
      await api('/api/me/interactions', { method: 'POST', body: JSON.stringify(body) });
      if (!stale(nav)) dashboardView();
    } catch (e) {
      if (stale(nav)) return;
      field('save').disabled = false;
      field('error').textContent = e.message;
    }
  };
}

// --- contacts --------------------------------------------------------------

async function contactsView() {
  const nav = renderLoading('Loading contacts...');
  const filter = browserStore('sessionStorage', 'getItem', 'org_filter') || '';
  let contacts;
  try {
    const r = await api('/api/me/contacts' + (filter ? '?category=' + encodeURIComponent(filter) : ''));
    contacts = Array.isArray(r) ? r : (r.contacts || []);
  } catch (e) { if (stale(nav)) return; return renderError(e, contactsView); }

  if (stale(nav)) return;
  const retry = pendingContactIntent('add');
  const createAction = { entry: retry, owner: contactCreateOwner };
  const retryNext = retry?.body?.next_followup_at;
  const retryDay = followupDay(retryNext);
  const openForm = !!browserStore('sessionStorage', 'getItem', 'org_new_contact') || !contacts.length || !!retry;
  el('app').innerHTML = `
    <div class="page-head"><div><h1>Contacts</h1><p class="muted lede">${contacts.length} ${contacts.length === 1 ? 'person' : 'people'}${filter ? ' in ' + esc(filter) : ''}</p></div></div>
    <p><a class="button" href="#/google-contacts">Import Google Contacts</a></p>
    <section class="card">
      <div class="toolbar">
        <input id="c-search" type="search" placeholder="Search by name or interest" aria-label="Search contacts">
        <div class="chips" role="group" aria-label="Filter by category">
          ${['', ...CATEGORIES].map((c) => `<button type="button" class="chip${c === filter ? ' on' : ''}" data-filter="${c}">${c ? catLabel(c) : 'All'}</button>`).join('')}
        </div>
      </div>
      <div id="contact-list"></div>
    </section>
    <p><a href="/integrations/google-sheets">Import or export with Google Sheets</a></p>
    <details class="card add-card" id="add-details" ${openForm ? 'open' : ''}>
      <summary>Add a person</summary>
      <form id="add-form">
        <div class="form-grid">
          <label>Name <input id="c-name" placeholder="Name" required></label>
          <label>Category
            <select id="c-cat">${CATEGORIES.map((c) => `<option value="${c}">${catLabel(c)}</option>`).join('')}</select>
          </label>
          <label class="full">Interests <input id="c-interests" placeholder="hiking, chai, board games (comma-separated)"></label>
          <label>Check in every (days) <input id="c-freq" type="number" min="1" value="14"></label>
          <label>Next follow-up (IST) <input id="c-next" type="date"></label>
          <label>Email <input id="c-email" type="email" placeholder="name@example.com"></label>
          <label class="full">Notes <input id="c-notes" placeholder="Notes"></label>
        </div>
        <p class="error" id="add-error" role="alert"></p>
        <p class="muted" id="add-status" role="status"></p>
        <p class="muted">${esc(contactRetryNotice(retry))}</p>
        <button class="primary" id="add-submit" type="submit">${retry ? (contactRetryBlocked(retry) ? 'Save pending review' : 'Retry save') : 'Add'}</button>
        <button id="add-new" type="button">Start a new add</button>
      </form>
    </details>`;

  const sorted = contacts.slice().sort((x, y) => {
    const tx = x.next_followup_at ? new Date(x.next_followup_at).getTime() : Infinity;
    const ty = y.next_followup_at ? new Date(y.next_followup_at).getTime() : Infinity;
    return tx - ty || String(x.name).localeCompare(String(y.name));
  });
  const paint = () => {
    const q = el('c-search').value.trim().toLowerCase();
    const list = sorted.filter((c) => !q || String(c.name ?? '').toLowerCase().includes(q) || (c.interests || []).some((i) => String(i).toLowerCase().includes(q)));
    el('contact-list').innerHTML = list.length ? list.map(contactRow).join('')
      : `<p class="muted empty">${q ? 'No one matches "' + esc(q) + '".' : (filter ? 'No ' + filter + ' contacts yet.' : 'No contacts yet. Add your first person below.')}</p>`;
    document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => go('#/contacts/' + encodeURIComponent(b.dataset.view)); });
  };
  el('c-search').oninput = paint;
  paint();
  document.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { browserStore('sessionStorage', 'setItem', 'org_filter', b.dataset.filter); contactsView(); }; });
  if (retry?.body) {
    const c = retry.body;
    el('c-name').value = c.name || ''; el('c-cat').value = c.category || 'personal';
    el('c-interests').value = (c.interests || []).join(', '); el('c-notes').value = c.notes || '';
    el('c-email').value = c.email || ''; el('c-freq').value = c.preferred_frequency_days || '';
    el('c-next').value = retryDay;
  }
  el('add-new').onclick = () => {
    if (!el('add-submit').disabled && !stale(nav) && startNewContactIntent('add')) contactsView();
  };
  wireCreateForm('add-form', 'add', nav, 'Adding person...', async () => {
    const body = {
      name: el('c-name').value.trim(),
      category: el('c-cat').value,
      interests: parseInterests(el('c-interests').value),
      notes: el('c-notes').value.trim(),
    };
    const email = el('c-email').value.trim();
    if (email) body.email = email;
    const freq = parseInt(el('c-freq').value, 10);
    if (freq > 0) body.preferred_frequency_days = freq;
    const next = el('c-next').value;
    // Preserve the original instant when retrying an unchanged restored date,
    // including after a timezone change. Editing the date is a changed body.
    if (next) body.next_followup_at = retryNext && next === retryDay ? retryNext : followupISO(next);
    const receipt = await createContactsOnce('add', body, createAction);
    if (stale(nav)) return;
    acknowledgeContactIntent('add', createAction);
    flash(receipt.missing_ids?.length
      ? 'That earlier save was already completed, but the person has since been deleted. Nothing was recreated.'
      : (receipt.contacts?.[0]?.name || body.name) + ' saved. Open them to log a check-in or plan a meetup.');
    contactsView();
  });
  if (browserStore('sessionStorage', 'getItem', 'org_new_contact')) {
    browserStore('sessionStorage', 'removeItem', 'org_new_contact');
    el('add-details').scrollIntoView({ block: 'center' });
    el('c-name').focus();
  }
}

function contactRow(c) {
  const n = dueIn(c.next_followup_at);
  const overdue = n !== null && n < 0;
  const when = n === null ? 'No check-in scheduled' : overdue ? 'Was due ' + esc(fmtFollowupDay(c.next_followup_at))
    : n === 0 ? 'Check-in due today' : 'Next check-in ' + esc(fmtFollowupDay(c.next_followup_at));
  return `
    <div class="row contact-row">
      <div><strong>${esc(c.name)}</strong> <span class="tag">${esc(catLabel(c.category))}</span>${overdue ? ' <span class="tag overdue">Overdue</span>' : ''}
        ${(c.interests || []).length ? `<div class="interest-pills">${c.interests.map((i) => `<span class="tag">${esc(i)}</span>`).join('')}</div>` : ''}
        <div class="muted">${when}</div>
      </div>
      <div class="actions"><button data-view="${esc(c.id)}">Open</button></div>
    </div>`;
}

// --- contact detail: profile + history, edit, delete ------------------------

async function contactDetailView(id) {
  const nav = renderLoading('Loading contact...');
  let contact, interactions;
  try {
    const r = await api('/api/me/contacts/' + encodeURIComponent(id));
    contact = r.contact || r;
    interactions = r.interactions || [];
  } catch (e) { if (stale(nav)) return; return renderError(e, () => contactDetailView(id)); }

  if (stale(nav)) return;
  const dueDays = dueIn(contact.next_followup_at);
  const dueText = dueDays === null ? 'No check-in scheduled' : dueDays < 0 ? `Check-in overdue by ${-dueDays} day${dueDays === -1 ? '' : 's'}` : dueDays === 0 ? 'Check-in due today' : `Next check-in in ${dueDays} day${dueDays === 1 ? '' : 's'}`;
  const dueCls = dueDays !== null && dueDays < 0 ? 'warn' : dueDays !== null && dueDays <= 7 ? 'soon' : 'ok';
  el('app').innerHTML = `
    <p><button class="link-btn" id="back">← All contacts</button></p>
    <section class="card profile" id="profile-card">
      <div class="profile-head">
        <div class="avatar" aria-hidden="true">${esc(String(contact.name || '?').trim().charAt(0).toUpperCase())}</div>
        <div>
          <h1 class="profile-name">${esc(contact.name)}</h1>
          <span class="tag">${esc(catLabel(contact.category))}</span>${contact.email ? ` <span class="muted">${esc(contact.email)}</span>` : ''}
        </div>
      </div>
      <div class="due-banner ${dueCls}"><strong>${esc(dueText)}</strong>
        <span class="muted">${contact.next_followup_at ? esc(fmtFollowupDay(contact.next_followup_at)) + ' · ' : ''}every ${contact.preferred_frequency_days || 14} days${contact.last_interaction_at ? ' · last spoke ' + esc(fmtDay(contact.last_interaction_at)) : ''}</span></div>
      ${(contact.interests || []).length ? `<p class="interest-pills">${contact.interests.map((i) => `<span class="tag">${esc(i)}</span>`).join('')}</p>` : ''}
      ${contact.notes ? `<p class="notes">${esc(contact.notes)}</p>` : ''}
    </section>
    <section class="card">
      <h2>Log a check-in</h2>
      <form id="log-form">
        <label>What happened? <input id="log-note" placeholder="Coffee, a call, a message..."></label>
        <label>Next follow-up (IST, optional) <input id="log-next" type="date"></label>
        <p class="muted">Leave the date blank to schedule by their check-in frequency.</p>
        <p class="error" id="log-error" role="alert"></p>
        <p class="muted" id="log-status" role="status"></p>
        <button class="primary" id="log-submit" type="submit">Save check-in</button>
      </form>
    </section>
    <section class="card">
      <h2>History</h2>
      ${interactions.length ? `<ol class="timeline">${interactions.map((i) => `
        <li><i class="tl-dot"></i><div><strong>${esc((i.type || 'interaction').replace(/_/g, ' '))}</strong>
          <span class="muted"> · ${esc(fmtDate(i.occurred_at))}</span>
          ${i.notes ? `<div>${esc(i.notes)}</div>` : ''}</div></li>`).join('')}</ol>` : '<p class="muted empty">No check-ins yet. Log the first one above.</p>'}
    </section>
    <div id="c-draft-slot"></div>
    <div class="manage"><button class="primary" id="c-draft">Draft message</button> <button id="c-meetup">Plan a meetup with ${esc(String(contact.name || '').split(/\s+/)[0])}</button> <a class="button" id="c-email-link" href="${esc(checkInEmail(contact))}">Email</a> <button id="c-edit">Edit details</button> <button class="danger" id="c-del">Delete contact</button></div>`;

  el('back').onclick = () => go('#/contacts');
  el('c-meetup').onclick = () => { sessionStorage.setItem('org_meetup_title', 'Catch-up with ' + String(contact.name || '').split(/\s+/)[0]); go('#/meetups'); };
  el('c-del').onclick = async () => {
    if (!confirm('Delete ' + (contact.name || 'this contact') + '?')) return;
    try {
      await api('/api/me/contacts/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!stale(nav)) go('#/contacts');
    } catch (e) { if (!stale(nav)) alert(e.message); }
  };
  el('c-edit').onclick = () => editContactForm(id, contact);
  el('c-draft').onclick = () => draftPanel(el('c-draft-slot'), id, contact.name);
  wireCreateForm('log-form', 'log', nav, 'Saving check-in...', async () => {
    const body = { contact_id: id, type: 'check_in', notes: el('log-note').value.trim() };
    const next = el('log-next').value;
    if (next) body.next_followup_at = followupISO(next);
    await api('/api/me/interactions', { method: 'POST', body: JSON.stringify(body) });
    if (stale(nav)) return;
    flash('Check-in saved. Your next reminder is set.', [['Back to dashboard', '#/dashboard']]);
    contactDetailView(id);
  });
}

function editContactForm(id, c) {
  const nav = ++navGen;
  // Editing invalidates this detail view's save callbacks but leaves its log
  // form visible. Make that temporary pause explicit until Save or Cancel.
  el('log-form').querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
  el('log-status').textContent = 'Save or cancel contact edits before logging a check-in.';
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
      <label>Next follow-up (IST) <input id="e-next" type="date" value="${esc(followupDay(c.next_followup_at))}"></label>
      <label>Email <input id="e-email" type="email" value="${esc(c.email || '')}" placeholder="name@example.com"></label>
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
    const email = el('e-email').value.trim();
    if (email !== (c.email || '')) patch.email = email || null;
    const freq = parseInt(el('e-freq').value, 10);
    if (freq > 0 && freq !== c.preferred_frequency_days) patch.preferred_frequency_days = freq;
    const nextVal = el('e-next').value;
    const oldNext = followupDay(c.next_followup_at);
    try {
      if (nextVal !== oldNext) patch.next_followup_at = nextVal ? followupISO(nextVal) : null;
      if (!Object.keys(patch).length) return contactDetailView(id);
      await api('/api/me/contacts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) });
      if (!stale(nav)) contactDetailView(id);
    } catch (err) { if (!stale(nav)) el('e-error').textContent = err.message; }
  };
}

// --- meetups -----------------------------------------------------------------

let meetupNotice = '';

async function meetupsView(created) {
  const nav = renderLoading('Loading meetups...');
  let meetups;
  try {
    const r = await api('/api/me/meetups');
    meetups = Array.isArray(r) ? r : (r.meetups || []);
  } catch (e) { if (stale(nav)) return; return renderError(e, () => meetupsView()); }

  if (stale(nav)) return;
  el('app').innerHTML = `
    <h1>Meetups</h1>
    ${meetupNotice ? `<p class="card" role="status">${esc(meetupNotice)}</p>` : ''}
    ${created ? createdCard(created) : ''}
    <section class="card">
      <h2>Plan a meetup</h2>
      <p class="muted">Guests join through the room link - nothing is sent automatically.</p>
      <div id="plan-voice"></div>
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
        <p class="error" id="m-error" role="alert"></p>
        <p class="muted" id="m-status" role="status"></p>
        <button class="primary" id="m-submit" type="submit">Create meetup</button>
      </form>
    </section>
    <section class="card">
      <h2>Planned</h2>
      ${meetups.length ? meetups.slice().sort((x, y) => ((x.status || 'open') !== 'open') - ((y.status || 'open') !== 'open')).map(meetupRow).join('') : '<p class="muted empty">No meetups yet. Plan one above and share the room link with your people.</p>'}
    </section>`;
  meetupNotice = '';

  if (window.PlanByVoice) window.PlanByVoice.mount(el('plan-voice'));
  const pre = sessionStorage.getItem('org_meetup_title');
  if (pre) { sessionStorage.removeItem('org_meetup_title'); el('m-title').value = pre; el('m-title').focus(); }
  wireCreateForm('m-form', 'm', nav, 'Creating meetup...', async () => {
    const body = { title: el('m-title').value.trim(), activity: el('m-activity').value };
    if (el('m-area').value.trim()) body.area = el('m-area').value.trim();
    const when = el('m-when').value;
    if (when) body.starts_at = toISO(when);
    const budget = parseInt(el('m-budget').value, 10);
    if (budget >= 0) body.budget = budget;
    const r = await api('/api/me/meetups', { method: 'POST', body: JSON.stringify(body) });
    if (!stale(nav)) meetupsView(r);
  });
  wireMeetupRows();
  if (el('created-dash')) el('created-dash').onclick = () => go('#/dashboard');
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
      <p class="muted">Next: send the link to your guests. They add their preferences and vote, then you confirm a place from the room.</p>
      <p><button class="link-btn" id="created-dash">Back to dashboard</button></p>
    </section>`;
}

function meetupRow(m) {
  const url = m.room_url || (m.room_token ? roomUrl(m.room_token) : '');
  const closed = (m.status || 'open') !== 'open';
  return `
    <div class="row meetup-row${closed ? ' is-closed' : ''}">
      <div><strong>${esc(m.title)}</strong>
        ${m.activity ? `<span class="tag">${esc(m.activity)}</span>` : ''}
        <span class="tag ${closed ? 'status-closed' : 'status-open'}">${esc(m.status || 'open')}</span>
        <div class="muted">${esc([m.area, fmtDate(m.starts_at), m.budget != null ? '₹' + m.budget + ' per person' : ''].filter(Boolean).join(' · '))}</div>
        ${url ? `<div class="muted mono">${esc(url)}</div>` : ''}
      </div>
      <div class="actions">
        ${!closed ? `<a class="button" href="#/meetups/${encodeURIComponent(m.id)}/edit">Edit / reschedule</a>` : ''}
        ${url ? `<button data-copy="${esc(url)}">Copy link</button>` : ''}
        ${url && !closed ? `<button data-qr="${esc(url)}">QR code</button>` : ''}
        ${url && !closed ? `<a class="button" href="${esc(meetupInviteEmail(m, url))}">Email invite</a>` : ''}
        ${!closed ? `<button class="danger" data-close="${esc(m.id)}">Close</button>` : ''}
      </div>
    </div>`;
}

// The editor deliberately uses UTC, not the device's local wall clock. That
// avoids silently selecting one of two DST-fold instants or normalizing a gap.
function meetupUtcInput(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, -1)
    .replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/:00$/, '');
}

function meetupUtcISO(value) {
  if (!value) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!parts) throw new Error('Enter a valid date and time in UTC.');
  const [, year, month, day, hour, minute, second = '0', fraction = ''] = parts;
  const date = new Date(value + 'Z');
  if (+year < 1 || !Number.isFinite(date.getTime()) ||
      date.getUTCFullYear() !== +year || date.getUTCMonth() + 1 !== +month || date.getUTCDate() !== +day ||
      date.getUTCHours() !== +hour || date.getUTCMinutes() !== +minute || date.getUTCSeconds() !== +second ||
      date.getUTCMilliseconds() !== +(fraction.padEnd(3, '0'))) {
    throw new Error('Enter a real calendar date and time in UTC; invalid dates are not adjusted automatically.');
  }
  return date.toISOString();
}

function meetupEditPatch(meetup, values, originalTime) {
  const patch = {};
  for (const [field, max, required] of [['title', 120, true], ['activity', 40, true], ['area', 80, false], ['notes', 2000, false]]) {
    const value = values[field].trim();
    if ((required && !value) || value.length > max) throw new Error(`${catLabel(field)} ${required ? 'must contain 1 to' : 'must not exceed'} ${max} characters.`);
    if (value !== (meetup[field] ?? '')) patch[field] = required ? value : (value || null);
  }
  const budgetText = values.budget.trim();
  if (budgetText && (!/^\d+$/.test(budgetText) || Number(budgetText) > 1000000)) {
    throw new Error('Budget must be a whole number from ₹0 to ₹1,000,000, or left blank.');
  }
  const budget = budgetText ? Number(budgetText) : null;
  if (budget !== (meetup.budget ?? null)) patch.budget = budget;
  // Never round-trip an unchanged timestamp through Date: the stored offset,
  // seconds and sub-millisecond precision must survive unrelated detail edits.
  if (values.starts_at !== originalTime) patch.starts_at = meetupUtcISO(values.starts_at);
  return patch;
}

async function meetupEditView(id) {
  const nav = renderLoading('Loading meetup details...');
  const editHash = location.hash;
  // hashchange runs later than a link/Back click. Check the URL too so a
  // response settling in that gap cannot redirect over the user's navigation.
  const isCurrent = () => !stale(nav) && location.hash === editHash;
  let meetup;
  try {
    const result = await api('/api/me/meetups/' + encodeURIComponent(id));
    meetup = result.meetup;
    if (!meetup || !meetup.updated_at) throw new Error('Could not load the current meetup version. Try again.');
  } catch (error) { if (isCurrent()) renderError(error, () => meetupEditView(id)); return; }
  if (!isCurrent()) return;
  const back = '<a class="button" href="#/meetups">Back to meetups</a>';
  if (meetup.status !== 'open') {
    el('app').innerHTML = `<h1>Meetup closed</h1><section class="card"><p>Closed rooms cannot be edited or reopened.</p>${back}</section>`;
    return;
  }
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'device timezone';
  const localTime = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }) : 'Not scheduled';
  el('app').innerHTML = `
    <h1>Edit / reschedule meetup</h1>
    <p>${back}</p>
    <section class="card">
      <p>Keep the same room link, guests, votes and confirmed venue. Guests are not automatically notified of changes; tell them yourself.</p>
      <p class="muted">No email, calendar update or message is sent when you save.</p>
      <p><strong>Current schedule in ${esc(localZone)}:</strong> ${esc(localTime(meetup.starts_at))}</p>
      <form id="me-form">
        <div class="form-grid">
          <label class="full">Title <input id="me-title" required maxlength="120"></label>
          <label>Activity <input id="me-activity" required maxlength="40" list="me-activities"><datalist id="me-activities">${ACTIVITIES.map((a) => `<option value="${a}">`).join('')}</datalist></label>
          <label>Area (optional) <input id="me-area" maxlength="80"></label>
          <label>Date &amp; time (UTC, optional) <input id="me-when" type="datetime-local" step="0.001" min="0001-01-01T00:00" max="9999-12-31T23:59:59.999" aria-describedby="me-timezone"></label>
          <label>Budget per person (₹, optional) <input id="me-budget" type="number" min="0" max="1000000" step="1"></label>
          <p class="muted full" id="me-timezone">This date and time is in UTC (UTC+00:00), not your device's local timezone. Clear it to remove the scheduled time.</p>
          <p class="full" id="me-local-preview" role="status" aria-live="polite"></p>
          <label class="full">Private organizer notes (optional) <textarea id="me-notes" maxlength="2000" rows="3"></textarea></label>
        </div>
        <p class="error" id="me-error" role="alert"></p>
        <p class="muted" id="me-status" role="status"></p>
        <div class="quick-actions"><button class="primary" id="me-submit" type="submit">Save changes</button><button id="me-cancel" type="button">Cancel</button><button id="me-reload" type="button" hidden>Reload latest details</button></div>
      </form>
    </section>`;
  for (const field of ['title', 'activity', 'area', 'budget', 'notes']) el('me-' + field).value = meetup[field] ?? '';
  el('me-when').value = meetupUtcInput(meetup.starts_at);
  const originalTime = el('me-when').value;
  const previewTime = () => {
    if (!isCurrent()) return;
    try {
      const value = el('me-when').value;
      const iso = value === originalTime ? meetup.starts_at : meetupUtcISO(value);
      el('me-local-preview').textContent = `Proposed schedule in ${localZone}: ${localTime(iso)}`;
    } catch (error) { el('me-local-preview').textContent = error.message; }
  };
  el('me-when').oninput = previewTime;
  previewTime();
  el('me-cancel').onclick = () => { if (isCurrent()) { navGen++; go('#/meetups'); } };
  el('me-reload').onclick = () => {
    if (isCurrent() && confirm('Reload the latest meetup details? Your unsaved edits will be discarded.')) return meetupEditView(id);
  };
  let blocked = false;
  wireCreateForm('me-form', 'me', nav, 'Saving changes...', async () => {
    if (!isCurrent()) return;
    if (blocked) throw new Error('Reload the latest details before saving again. Your edits have not been discarded.');
    const patch = meetupEditPatch(meetup, {
      title: el('me-title').value, activity: el('me-activity').value, area: el('me-area').value,
      starts_at: el('me-when').value, budget: el('me-budget').value, notes: el('me-notes').value,
    }, originalTime);
    if (Object.keys(patch).length) {
      try {
        await api('/api/me/meetups/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ ...patch, expected_updated_at: meetup.updated_at }) });
      } catch (error) {
        if (isCurrent() && [404, 409, 410].includes(error.status)) {
          blocked = true;
          el('me-reload').hidden = false;
        }
        throw error;
      }
    }
    if (isCurrent()) {
      meetupNotice = Object.keys(patch).length ? 'Meetup updated. Guests are not automatically notified; tell them about the changes yourself.' : 'No meetup changes to save.';
      navGen++;
      go('#/meetups');
    }
  });
}

function wireMeetupRows() {
  const nav = navGen;
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b, 'Copy link'); });
  document.querySelectorAll('[data-qr]').forEach((b) => { b.onclick = () => toggleQr(b); });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Close this meetup? Guests will no longer be able to vote.')) return;
      try {
        await api('/api/me/meetups/' + encodeURIComponent(b.dataset.close), { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
        if (!stale(nav)) meetupsView();
      } catch (e) { if (!stale(nav)) alert(e.message); }
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
// On this screen, voice.js ("Talk instead" / "Type instead") calls /api/extract
// and pre-fills the rows + goals directly; it also stores org_prefill so a
// refresh keeps the result. Nothing is saved until Confirm.

function prefill() {
  try {
    const raw = window.ORGANIZER_PREFILL || sessionStorage.getItem('org_prefill');
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return p && typeof p === 'object' && (!p.owner || p.owner === contactCreateOwner) ? p : {};
  } catch { return {}; }
}

function emptyRow() { return { name: '', category: 'personal', interests: '', freq: 14 }; }

const toRow = (c) => ({
  name: c.name || '',
  category: CATEGORIES.includes(c.category) ? c.category : 'personal',
  interests: Array.isArray(c.interests) ? c.interests.join(', ') : (c.interests || ''),
  freq: c.preferred_frequency_days || 14,
});


// --- welcome / how it works -------------------------------------------------
// Shown to new users before setup, and reachable any time from "Guide".

const CAPABILITIES = [
  ['💛', 'Keep your people close', 'Add friends, colleagues and community. Group them as Personal, Professional or Community and set how often you want to check in.'],
  ['🧭', 'See who needs you', 'Your dashboard shows a network map and a calendar. The closer someone is to the centre, the sooner a check-in is due.'],
  ['☕', 'Log check-ins', 'Note what happened after a coffee or a call. The next reminder is set for you, or you pick the date.'],
  ['🎉', 'Plan meetups together', 'Create a meetup and share its room link. Guests add budget, area and free times, then vote on a shortlist of places. Nothing is ever sent for you.'],
  ['⚖️', 'Balance your attention', 'Set goals for Personal, Professional and Community, then compare them with where your time actually went.'],
];


// The friendly muop guide character (same face as the voice onboarding widget).
const MUOP_CHAR = `
  <svg class="vx-char" viewBox="0 0 96 96" role="img" aria-label="muop, your friendly guide">
    <g class="vx-sat s1"><circle cx="80" cy="24" r="8" fill="#04C1E1" stroke="#2E1F14" stroke-width="2.4"/></g>
    <g class="vx-sat s2"><circle cx="14" cy="30" r="6" fill="#75E4DE" stroke="#2E1F14" stroke-width="2.4"/></g>
    <g class="vx-body">
      <circle cx="48" cy="54" r="30" fill="#F6AC0D" stroke="#2E1F14" stroke-width="2.4"/>
      <ellipse cx="36" cy="64" rx="5" ry="3.2" fill="#FFF3C4" opacity="0.7"/>
      <ellipse cx="60" cy="64" rx="5" ry="3.2" fill="#FFF3C4" opacity="0.7"/>
      <g class="vx-eyes"><circle cx="38" cy="50" r="3.4" fill="#2E1F14"/><circle cx="58" cy="50" r="3.4" fill="#2E1F14"/></g>
      <path class="vx-smile" d="M38 61 Q48 70 58 61" fill="none" stroke="#2E1F14" stroke-width="2.6" stroke-linecap="round"/>
    </g>
  </svg>`;

// Pretty, collapsible guide card on the first page. Open on the first visit,
// collapsed after that so returning users see their people first; an explicit
// open/close choice is remembered.
function guideCardHTML() {
  return `
    <details class="card guide-card" id="guide-card">
      <summary>
        <span class="guide-char" aria-hidden="true">${MUOP_CHAR}</span>
        <span class="guide-title">
          <span class="eyebrow">Your muop guide</span>
          <span class="guide-h">Five little things muop does for you</span>
        </span>
        <span class="guide-caret" aria-hidden="true">&#9662;</span>
      </summary>
      <ul class="cap-list pretty">
        ${CAPABILITIES.map(([ic, t, d], i) => `<li class="cap-${i + 1}"><span class="cap-ic" aria-hidden="true">${ic}</span><div><strong>${esc(t)}</strong><div class="muted">${esc(d)}</div></div></li>`).join('')}
      </ul>
    </details>`;
}

function wireGuideCard() {
  const gc = el('guide-card');
  if (!gc) return;
  try {
    const pref = localStorage.getItem('org_guide_open');
    gc.open = pref === null ? localStorage.getItem('org_guide_seen') !== '1' : pref === '1';
    localStorage.setItem('org_guide_seen', '1');
  } catch { gc.open = true; }
  // Opening it here fires one 'toggle' too; only the user's own clicks are saved.
  let skip = gc.open;
  gc.addEventListener('toggle', () => {
    if (skip) { skip = false; return; }
    try { localStorage.setItem('org_guide_open', gc.open ? '1' : '0'); } catch { /* ignore */ }
  });
}

function welcomeView(opts = {}) {
  ++navGen;
  const returning = !!opts.returning || browserStore('localStorage', 'getItem', 'org_onboarded') === '1';
  el('app').innerHTML = `
    <section class="card welcome ob-cute">
      <div class="ob-deco" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
      <div class="welcome-char" aria-hidden="true">${MUOP_CHAR}</div>
      <p class="eyebrow">${returning ? 'Guide' : 'Welcome to muop'}</p>
      <h1>${returning ? 'What you can do with muop' : 'Stay close to the people who matter'}</h1>
      <p class="muted lede-lg">muop helps you remember to check in, and makes meeting up easy. Here is what you can do.</p>
      <ul class="cap-list">
        ${CAPABILITIES.map(([ic, t, d]) => `<li><span class="cap-ic" aria-hidden="true">${ic}</span><div><strong>${esc(t)}</strong><div class="muted">${esc(d)}</div></div></li>`).join('')}
      </ul>
      <p class="muted">Setup takes about a minute. You can skip any step and change everything later.</p>
      <div class="quick-actions">
        ${returning
          ? '<button class="primary" id="w-dash">Back to dashboard</button><button id="w-setup">Run setup again</button>'
          : '<button class="primary" id="w-start">Get started</button><button id="w-skip">Skip, take me to the dashboard</button>'}
      </div>
    </section>`;
  const done = () => { browserStore('localStorage', 'setItem', 'org_onboarded', '1'); go('#/dashboard'); };
  if (returning) { el('w-dash').onclick = () => go('#/dashboard'); el('w-setup').onclick = () => go('#/onboarding'); }
  else { el('w-start').onclick = () => go('#/onboarding'); el('w-skip').onclick = done; }
}

// One-shot message shown at the top of the next page that renders.
function flash(msg, links) { try { sessionStorage.setItem('org_flash', JSON.stringify({ msg, links: links || [] })); } catch { /* ignore */ } }
function installFlash() {
  new MutationObserver(() => {
    const host = el('app');
    if (!host || host.querySelector('.flash') || !host.querySelector('h1')) return;
    let f; try { f = JSON.parse(sessionStorage.getItem('org_flash') || 'null'); } catch { f = null; }
    if (!f) return;
    sessionStorage.removeItem('org_flash');
    const div = document.createElement('div');
    div.className = 'flash';
    div.setAttribute('role', 'status');
    div.innerHTML = `<span>${esc(f.msg)}</span>${(f.links || []).map((l) => `<button class="link-btn" data-flash-go="${esc(l[1])}">${esc(l[0])}</button>`).join('')}`;
    host.prepend(div);
    div.querySelectorAll('[data-flash-go]').forEach((b) => { b.onclick = () => go(b.dataset.flashGo); });
  }).observe(el('app'), { childList: true });
}

function onboardingView() {
  const nav = ++navGen;
  const p = prefill();
  const retry = pendingContactIntent('onboarding');
  const createAction = { entry: retry, owner: contactCreateOwner };
  if (retry?.body?.contacts) p.contacts = retry.body.contacts;
  const rows = (p.contacts && p.contacts.length ? p.contacts.slice(0, 5) : [emptyRow()]).map(toRow);
  const goals = { personal: 50, professional: 30, community: 20, ...(p.goals || {}) };
  // Who understood the extraction: kept with the rows (and in org_prefill) so
  // the attribution survives Back from goals and a refresh.
  // Only extractions that actually added someone count, so a later fallback
  // that added nobody can't take credit for people DeepSeek found.
  const sources = Array.isArray(p.sources) ? p.sources.filter((x) => typeof x === 'string') : typeof p.source === 'string' ? [p.source] : [];
  let step = 1;
  let voice = null;
  let saving = false;
  let stepGen = 0;

  const SOURCE_LABELS = { deepseek: 'DeepSeek', gemini: 'Gemini', openai: 'AI', agenticorg: 'AgenticOrg', rules: 'built-in rules' };
  const showSource = () => {
    const box = el('ob-source');
    if (!box) return;
    const label = sources.filter((x) => Object.hasOwn(SOURCE_LABELS, x)).map((x) => SOURCE_LABELS[x]).join(' + ');
    box.textContent = label && rows.some((r) => r.name) ? `Filled from what you said (understood by ${label}). Review each person - nothing is saved until you finish.` : '';
  };

  const finish = (added, missing = 0) => {
    if (stale(nav)) return;
    if (voice) voice.stop();
    browserStore('localStorage', 'setItem', 'org_onboarded', '1');
    browserStore('sessionStorage', 'removeItem', 'org_prefill');
    delete window.ORGANIZER_PREFILL;
    step = 3;
    if (added?.length || missing) return renderDone(added || [], missing);
    go('#/dashboard');
  };

  function renderDone(added, missing) {
    el('app').innerHTML = `
      <section class="card welcome ob-cute">
        <div class="ob-deco" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
        <p class="ob-yay" aria-hidden="true">🎉 ⭐ 💛</p>
        <p class="eyebrow">All set</p>
        <h1>${missing ? 'Earlier save confirmed' : `${added.length} ${added.length === 1 ? 'person' : 'people'} added - lovely! What next?`}</h1>
        ${missing ? `<p class="muted">${added.length} saved ${added.length === 1 ? 'person is' : 'people are'} still available. ${missing} ${missing === 1 ? 'person has' : 'people have'} since been deleted. Nothing was recreated.</p>` : ''}
        <div class="next-grid">
          ${added.length ? `<button class="next-card" id="d-checkin"><strong>Log a check-in</strong><span class="muted">Record a recent catch-up with ${esc(added[0].name)}.</span></button>` : ''}
          <button class="next-card" id="d-meetup"><strong>Plan a meetup</strong><span class="muted">Create a room link to share with friends.</span></button>
          <button class="next-card" id="d-dash"><strong>See your dashboard</strong><span class="muted">Your network map and calendar.</span></button>
        </div>
      </section>`;
    if (added.length) el('d-checkin').onclick = async () => {
      try {
        const m = added[0];
        if (stale(nav)) return;
        go(m?.id ? '#/contacts/' + encodeURIComponent(m.id) : '#/contacts');
      } catch { if (!stale(nav)) go('#/contacts'); }
    };
    el('d-meetup').onclick = () => go('#/meetups');
    el('d-dash').onclick = () => go('#/dashboard');
  }

  // Voice / typed extraction -> pre-fill only. Rows the user already typed are
  // kept; extracted people fill the remaining slots (max 5).
  function applyExtraction(res) {
    if (stale(nav) || step !== 1 || !el('ob-rows')) return; // late result after leaving the people step
    collectRows();
    el('ob-error').textContent = '';
    const kept = rows.filter((r) => r.name);
    const names = new Set(kept.map((r) => r.name.toLowerCase()));
    const added = (res.contacts || []).map(toRow).filter((r) => r.name && !names.has(r.name.toLowerCase()));
    const merged = [...kept, ...added].slice(0, 5);
    rows.splice(0, rows.length, ...(merged.length ? merged : [emptyRow()]));
    if (res.goals) Object.assign(goals, res.goals);
    // Credit only providers whose additions survived the five-person limit.
    if (merged.length > kept.length && typeof res.source === 'string' && !sources.includes(res.source)) sources.push(res.source);
    persistDraft();
    renderRows();
    showSource();
    if (merged.length >= 5 && kept.length + added.length > 5) {
      el('ob-error').textContent = 'Only the first 5 people were kept - you can add more from Contacts later.';
    }
    // "That's everyone, save it": move on to the goals step. Saving still needs
    // the explicit Confirm there, so a misheard command can't write anything.
    if (res.action === 'confirm' && merged.some((r) => r.name)) el('ob-next').click();
  }

  function persistDraft() {
    const draft = {
      owner: contactCreateOwner,
      contacts: rows.map((r) => ({ name: r.name, category: r.category, interests: r.interests, preferred_frequency_days: r.freq })),
      goals: { ...goals },
      sources: [...sources],
    };
    // Keep the in-memory prefill in sync too, rather than letting it override a
    // newer session draft if setup is opened again without reloading the page.
    window.ORGANIZER_PREFILL = draft;
    try { sessionStorage.setItem('org_prefill', JSON.stringify(draft)); } catch { /* keep the current draft in memory */ }
  }

  function renderStep1() {
    if (saving || stale(nav)) return;
    ++stepGen;
    if (voice) voice.stop();
    step = 1;
    el('app').innerHTML = `
      <section class="card ob-cute">
        <div class="ob-deco" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
        <div class="step-dots step-pill">Step 1 of 2 · Your people 🌷</div>
        <h1>Who do you want to stay close to?</h1>
        <div id="voice-mount"></div>
        <h2 class="ob-sub">Your people <span class="muted">(up to 5)</span></h2>
        <p class="muted">Anyone I hear or you type appears here. Check them, fix them, make them yours. Nothing is saved until you finish setup.</p>
        <div id="ob-rows"></div>
        <p class="muted" id="ob-source"></p>
        <p><button class="link-btn" id="ob-add">+ Add another</button></p>
        <p class="muted">${esc(contactRetryNotice(createAction.entry || pendingContactIntent('onboarding')))}</p>
        <p><button class="link-btn" id="ob-new">Start a new add</button></p>
        <p class="error" id="ob-error"></p>
        <div class="quick-actions">
          <button class="primary" id="ob-next">Next: your goals →</button>
          <button id="ob-skip">Skip for now</button>
        </div>
        <p><button class="link-btn" id="ob-welcome">← What can muop do?</button></p>
      </section>`;
    renderRows();
    showSource();
    el('ob-new').onclick = () => {
      if (saving || stale(nav) || !startNewContactIntent('onboarding')) return;
      createAction.entry = null;
      rows.splice(0, rows.length, emptyRow()); persistDraft(); renderStep1();
    };
    el('ob-welcome').onclick = () => go('#/welcome');
    voice = window.Voice ? window.Voice.mount(el('voice-mount'), applyExtraction) : null;
    // Lets the voice assistant (assistant.js) fill this form and move on.
    window.OrganizerOnboarding = { apply: applyExtraction };
    el('ob-add').onclick = () => {
      if (rows.length >= 5) { el('ob-error').textContent = 'Up to 5 people for now - you can add more from Contacts later.'; return; }
      collectRows();
      rows.push(emptyRow());
      renderRows();
    };
    el('ob-next').onclick = () => {
      if (saving || stale(nav) || step !== 1) return;
      collectRows();
      persistDraft();
      if (voice) voice.stop();
      step = 2;
      renderStep2();
    };
    el('ob-skip').onclick = () => finish();
  }

  function renderRows() {
    el('ob-rows').innerHTML = rows.map((r, i) => `
      <div class="ob-row" data-row="${i}">
        <label>Name <input data-f="name" value="${esc(r.name)}" placeholder="Name"></label>
        <label>Category <select data-f="category">${CATEGORIES.map((c) => `<option value="${c}" ${c === r.category ? 'selected' : ''}>${catLabel(c)}</option>`).join('')}</select></label>
        <label>Interests <input data-f="interests" value="${esc(r.interests)}" placeholder="hiking, chai"></label>
        <label>Every (days) <input data-f="freq" type="number" min="1" value="${Number(r.freq) || 14}"></label>
        ${rows.length > 1 ? '<button class="danger remove-row" data-rm="' + i + '" aria-label="Remove this person">Remove</button>' : '<span></span>'}
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
    const version = ++stepGen;
    const inactive = () => stale(nav) || step !== 2 || version !== stepGen;
    el('app').innerHTML = `
      <section class="card ob-cute">
        <div class="ob-deco" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
        <div class="step-dots step-pill">Step 2 of 2 · Your goals 🎈</div>
        <h1>How do you want to share your time?</h1>
        <p class="muted">Split 100% between the parts of your life. You can change this anytime from your Profile.</p>
        <div class="goals-grid">
          ${CATEGORIES.map((c) => `<label>${catLabel(c)} <input type="number" class="goal-input" data-cat="${c}" min="0" max="100" value="${esc(goals[c] ?? 0)}"></label>`).join('')}
        </div>
        <p>Total: <strong id="goals-total">0</strong>%</p>
        <p class="error" id="ob-error" role="alert"></p>
        <p class="muted" id="ob-status" role="status"></p>
        <div class="quick-actions">
          <button id="ob-back">Back</button>
          <button class="primary" id="ob-confirm">Save and finish 🎉</button>
          <button id="ob-skip">Skip for now</button>
        </div>
      </section>`;
    const inputs = [...document.querySelectorAll('.goal-input')];
    const total = () => inputs.reduce((sum, input) => sum + (Number(input.value) || 0), 0);
    const collectGoals = () => {
      inputs.forEach((input) => { goals[input.dataset.cat] = input.value === '' ? '' : Number(input.value); });
      persistDraft();
    };
    const refresh = () => { el('goals-total').textContent = total(); };
    inputs.forEach((input) => { input.oninput = () => {
      if (saving || inactive()) return;
      collectGoals();
      refresh();
    }; });
    refresh();
    el('ob-back').onclick = () => {
      if (saving || inactive()) return;
      collectGoals();
      renderStep1();
    };
    el('ob-skip').onclick = () => { if (!saving && !inactive()) finish(); };
    el('ob-confirm').onclick = async () => {
      if (saving || inactive()) return;
      el('ob-error').textContent = '';
      collectGoals();
      if (inputs.some((input) => input.value === '' || !Number.isInteger(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 100)) {
        el('ob-error').textContent = 'Use whole percentages between 0 and 100 for each goal.';
        return;
      }
      if (total() !== 100) {
        el('ob-error').textContent = 'Goals must total 100% - currently ' + total() + '%.';
        return;
      }
      saving = true;
      const controls = [...inputs, el('ob-back'), el('ob-skip'), el('ob-confirm')];
      const status = el('ob-status');
      controls.forEach((control) => { control.disabled = true; });
      status.textContent = 'Saving your setup...';
      const goalBody = { ...goals };
      const contacts = rows.filter((r) => r.name).slice(0, 5).map((r) => ({
        name: r.name,
        category: r.category,
        interests: parseInterests(r.interests),
        preferred_frequency_days: r.freq,
      }));
      try {
        checkContactRetryBody(createAction.entry || pendingContactIntent('onboarding'), { contacts });
        // Goals are an idempotent PUT. Save them before creating contacts so a
        // failed goals request can be retried without duplicating every person.
        await api('/api/me/goals', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Contact-Owner': createAction.owner }, body: JSON.stringify(goalBody) });
        if (inactive()) return;
        let added = []; let missing = 0;
        if (contacts.length) {
          const receipt = await createContactsOnce('onboarding', { contacts }, createAction);
          added = receipt.contacts || contacts;
          missing = receipt.missing_ids?.length || 0;
        }
        if (!inactive()) {
          finish(added, missing);
          acknowledgeContactIntent('onboarding', createAction);
        }
      } catch (e) {
        if (!inactive()) el('ob-error').textContent = e.message;
      } finally {
        saving = false;
        if (!inactive()) {
          controls.forEach((control) => { control.disabled = false; });
          status.textContent = '';
        }
      }
    };
  }

  renderStep1();
}


// --- profile: your account, your goals, and recent activity -----------------

async function profileView() {
  const nav = renderLoading('Loading your profile...');
  const hash = location.hash || '';
  const isCurrent = () => !stale(nav) && (location.hash || '') === hash;
  let me = null, d = null;
  try {
    [me, d] = await Promise.all([api('/api/me'), api('/api/me/dashboard')]);
  } catch (e) { if (!isCurrent()) return; return renderError(e, profileView); }
  if (!isCurrent()) return;

  const u = (me && me.user) || {};
  const counts = d.contact_counts || {};
  const totalContacts = CATEGORIES.reduce((sum, c) => sum + (counts[c] || 0), 0);
  const act = d.recorded_activity || { total: 0 };
  const meetups = d.upcoming_meetups || [];
  const goals = { personal: 50, professional: 30, community: 20, ...(d.goals || {}) };
  const initial = (String(u.email || 'm').trim().charAt(0) || 'm').toUpperCase();
  const CAT_META = { personal: ['#F6AC0D', '\u{1F49B}'], professional: ['#04C1E1', '\u{1F4BC}'], community: ['#3FAE9C', '\u{1F331}'] };

  el('app').className = 'container';
  el('app').innerHTML = `
    <div class="page-head">
      <div><h1>Profile</h1><p class="muted lede">Your account, your goals, and your recent activity.</p></div>
    </div>
    <section class="card me-card">
      <div class="me-head">
        <span class="me-avatar" aria-hidden="true">${esc(initial)}</span>
        <div>
          <h2 class="me-name">${esc(u.email || 'muop member')}</h2>
          ${u.created_at ? `<div class="muted">With muop since ${esc(fmtDay(u.created_at))}</div>` : ''}
        </div>
      </div>
      <div class="me-grid">
        <div class="me-item"><div class="me-num">${totalContacts}</div><div class="me-k">${totalContacts === 1 ? 'person' : 'people'}</div><div class="muted">${CATEGORIES.map((c) => `${catLabel(c)} ${counts[c] || 0}`).join(' · ')}</div></div>
        <div class="me-item"><div class="me-num">${act.total || 0}</div><div class="me-k">check-ins logged</div><div class="muted">${esc(act.label || 'interactions on record')}</div></div>
        <div class="me-item"><div class="me-num">${meetups.length}</div><div class="me-k">${meetups.length === 1 ? 'meetup planned' : 'meetups planned'}</div><div class="muted">open right now</div></div>
      </div>
    </section>
    <section class="card">
      <h2>Your goals</h2>
      <p class="muted">How you want to split your attention.</p>
      <div class="me-goal-bars">
        ${CATEGORIES.map((c) => `
          <div class="goal-bar"><strong>${CAT_META[c][1]} ${catLabel(c)}</strong> · ${goals[c] || 0}%
            <div class="bar-track"><div class="bar-actual" style="width:${Math.min(100, Math.max(0, goals[c] || 0))}%; background:${CAT_META[c][0]}"></div></div>
          </div>`).join('')}
      </div>
      <div class="quick-actions"><button id="me-edit-goals">Edit goals</button></div>
      <div id="me-goals-form" class="hidden">
        <div class="goals-grid">
          ${CATEGORIES.map((c) => `<label>${catLabel(c)} <input type="number" class="me-goal-input" data-cat="${c}" min="0" max="100" value="${goals[c] || 0}"></label>`).join('')}
        </div>
        <p>Total: <strong id="me-goals-total">100</strong>% <span class="muted">(must be 100)</span></p>
        <p class="error" id="me-goals-error" role="alert"></p>
        <p class="muted" id="me-goals-status" role="status"></p>
        <div class="quick-actions">
          <button class="primary" id="me-goals-save">Save goals</button>
          <button id="me-goals-cancel">Cancel</button>
        </div>
      </div>
    </section>
    <section class="card">
      <h2>Activity log</h2>
      <p class="muted">Your most recent 100 check-ins, newest first.</p>
      <div id="me-activity-log"></div>
    </section>`;

  // Activity is optional to this page. Retry only this region, never the whole
  // profile: re-rendering would silently discard an open goals draft.
  let loadingActivity = false;
  const loadActivity = async () => {
    if (!isCurrent() || loadingActivity) return;
    loadingActivity = true;
    const log = el('me-activity-log');
    log.innerHTML = '<p class="muted" role="status">Loading activity...</p>';
    try {
      const result = await api('/api/me/interactions?limit=100');
      if (!isCurrent()) return;
      const interactions = result.interactions || [];
      log.innerHTML = interactions.length ? `<ol class="timeline me-log">${interactions.map((i) => `
        <li><span class="tl-dot"></span>
          <strong>${esc((i.contact && i.contact.name) || 'Someone')}</strong>
          ${i.contact && i.contact.category ? `<span class="tag">${esc(catLabel(i.contact.category))}</span>` : ''}
          <div class="muted">${esc(String(i.type || '').replace(/_/g, ' '))} · ${esc(fmtDate(i.occurred_at))}</div>
          ${i.notes ? `<div class="notes muted">${esc(i.notes)}</div>` : ''}
        </li>`).join('')}</ol>`
        : '<p class="muted">Nothing logged yet. Log a check-in from a contact page or the dashboard.</p>';
    } catch (e) {
      if (!isCurrent() || e instanceof AuthError) return;
      log.innerHTML = `<p class="error" role="alert">Could not load activity. ${esc(e.message || 'Please try again.')}</p>
        <button id="me-activity-retry">Retry activity</button>`;
      el('me-activity-retry').onclick = loadActivity;
    } finally {
      loadingActivity = false;
    }
  };

  let savingGoals = false;
  let editingGoals = false;
  el('me-edit-goals').onclick = () => {
    if (!isCurrent() || savingGoals) return;
    editingGoals = true;
    el('me-goals-form').classList.remove('hidden');
    el('me-edit-goals').classList.add('hidden');
  };
  el('me-goals-cancel').onclick = () => {
    if (!isCurrent() || savingGoals) return;
    editingGoals = false;
    el('me-goals-form').classList.add('hidden');
    el('me-edit-goals').classList.remove('hidden');
  };
  const inputs = [...document.querySelectorAll('.me-goal-input')];
  const total = () => inputs.reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  inputs.forEach((input) => { input.oninput = () => {
    if (isCurrent()) el('me-goals-total').textContent = total();
  }; });
  el('me-goals-save').onclick = async () => {
    if (!isCurrent() || savingGoals || !editingGoals) return;
    const error = el('me-goals-error'), status = el('me-goals-status');
    error.textContent = '';
    if (inputs.some((input) => input.value === '' || !Number.isInteger(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 100)) {
      error.textContent = 'Use whole percentages between 0 and 100 for each goal.';
      return;
    }
    if (total() !== 100) { error.textContent = 'Goals must total 100% - currently ' + total() + '%.'; return; }
    savingGoals = true;
    const controls = [...inputs, el('me-goals-save'), el('me-goals-cancel')];
    controls.forEach((control) => { control.disabled = true; });
    status.textContent = 'Saving goals...';
    try {
      const body = Object.fromEntries(inputs.map((input) => [input.dataset.cat, Number(input.value)]));
      await api('/api/me/goals', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Contact-Owner': contactCreateOwner }, body: JSON.stringify(body) });
      if (!isCurrent()) return;
      flash('Goals saved.');
      profileView();
    } catch (e) {
      if (isCurrent()) error.textContent = e.message;
    } finally {
      savingGoals = false;
      if (isCurrent()) {
        controls.forEach((control) => { control.disabled = false; });
        status.textContent = '';
      }
    }
  };
  await loadActivity();
}

// --- boot ------------------------------------------------------------------------

async function boot() {
  renderLoading();
  let d;
  try {
    const [dashboard, me] = await Promise.all([api('/api/me/dashboard', {}, 'boot'), api('/api/me', {}, 'boot')]);
    if (!me?.user?.id) throw new Error('Could not verify your account. Please reload.');
    contactCreateOwner = me.user.id;
    contactCreateRetryEnabled = me.capabilities?.contact_create_retry === true;
    d = dashboard;
  } catch (e) {
    contactCreateOwner = null;
    contactCreateRetryEnabled = false;
    if (e instanceof AuthError) return; // redirecting to /login
    return renderError(e, boot);
  }
  const onboarded = browserStore('localStorage', 'getItem', 'org_onboarded') === '1';
  const hash = location.hash || '#/dashboard';
  window.onhashchange = route;
  installFlash();
  // OAuth returns must keep their destination even before first-run onboarding.
  const directEntry = ['#/onboarding', '#/welcome', '#/google-contacts', '#/gmail', '#/calendar'].includes(hash);
  if (d.is_empty && !onboarded && !directEntry) {
    go('#/welcome');
  }
  route();
}

boot();
