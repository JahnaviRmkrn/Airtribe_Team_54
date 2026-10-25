// Guest meetup room at /m/<token> (served from /room/index.html via a Next rewrite).
// Talks only to Person A's public room API: /api/rooms/:token/*.
// Guests are identified by the httpOnly guest cookie set on join; this script
// never sees or stores the guest secret. The organiser is recognised by their
// Supabase session cookie (view.is_organizer).
// UI ported from Arindom Chetia's static/room.* (PR #3).

const match = location.pathname.match(/^\/m\/([A-Za-z0-9_-]{20,100})\/?$/);
const TOKEN = match ? match[1] : null;
const POLL_MS = 4000;

// Suggestion chips. They mirror the sample venue tags so picks affect the shortlist.
const FOOD = ['veg', 'non-veg', 'vegan', 'south-indian', 'north-indian', 'biryani', 'asian', 'continental', 'cafe', 'desserts', 'healthy', 'budget'];
const ACTIVITIES = ['board-games', 'bowling', 'pottery', 'live-music', 'outdoors', 'walk', 'rooftop', 'brewery', 'quiet'];
const SLOTS = ['Fri evening', 'Sat lunch', 'Sat evening', 'Sun brunch', 'Sun evening', 'Weekday evening'];

const STATUS_MESSAGES = {
  401: 'Join this room first.',
  404: 'This room link is not valid or has expired.',
  409: 'That is no longer possible - the room has changed.',
  410: 'This meetup room is closed.',
  429: 'This room is full.',
};

let view = null;
let busy = false;
let poll = null;
let prefsFor = null; // attendee id whose preferences form is on screen
let paymentBusy = false;
let paymentLoadedFor = null;
let payment = null;
let paymentMessage = '';
let paymentStartUncertain = false;
let paymentAvailability = 'unavailable';
let paymentGeneration = 0;

function checkoutBlocked() {
  return paymentAvailability !== 'ready' || paymentStartUncertain || (!!payment && (payment.checkout_state === 'creating' || payment.checkout_state === 'reconciliation_required' || (payment.status === 'pending' && !payment.redirect_url)));
}

function renderPayment() {
  const panel = $('payment-card');
  if (!panel || !view) return;
  const eligible = !!view.me && !!view.meetup.final_venue;
  panel.classList.toggle('hidden', !eligible);
  if (!eligible) return;
  const price = view.meetup.final_venue.price_per_person;
  const closed = view.meetup.status !== 'open';
  const recoveryMessage = paymentAvailability === 'setup_required'
    ? 'Checkout is unavailable until the operator completes the payment safety upgrade. You can still check an existing payment status.'
    : paymentAvailability !== 'ready' ? 'Check payment status before paying. Checkout is unavailable until that check succeeds.'
    : payment?.checkout_state === 'creating'
    ? 'Payment is being created. Check payment status; do not start another checkout.'
    : checkoutBlocked() ? 'Payment creation needs checking. Do not pay again. Check payment status or ask the organiser to reconcile it.' : '';
  $('payment-status').textContent = [payment && `Payment ${payment.status} · ${rupees(payment.amount_paise / 100)}`,
    paymentMessage || recoveryMessage].filter(Boolean).join('. ');
  $('pay-btn').textContent = paymentAvailability === 'setup_required' ? 'Checkout unavailable' : checkoutBlocked() ? 'Check status before paying' : payment?.status === 'pending' ? 'Continue checkout' : `Pay ${rupees(price)} with Pine Labs`;
  $('pay-btn').disabled = paymentBusy || checkoutBlocked() || closed || !(price > 0) || payment?.status === 'paid';
  $('payment-check').disabled = paymentBusy;
  if (paymentLoadedFor !== view.me.attendee_id) {
    paymentGeneration++; paymentBusy = false;
    paymentLoadedFor = view.me.attendee_id;
    payment = null; paymentAvailability = 'unavailable'; paymentStartUncertain = false;
    updatePayment(false);
  }
}

async function updatePayment(start) {
  if (paymentBusy || (start && checkoutBlocked())) return;
  const generation = paymentGeneration;
  const attendeeId = view?.me?.attendee_id;
  const roomPath = location.pathname;
  const current = () => generation === paymentGeneration && view?.me?.attendee_id === attendeeId && location.pathname === roomPath;
  paymentBusy = true;
  renderPayment();
  try {
    const data = await api('/pay', { method: start ? 'POST' : 'GET' });
    if (!current()) return;
    payment = data.payment;
    paymentAvailability = data.checkout_availability ?? 'unavailable';
    paymentStartUncertain = false;
    paymentMessage = paymentAvailability === 'ready' && !payment ? 'No payment yet.' : '';
    if (start && paymentAvailability === 'ready' && payment?.status === 'pending' && payment.redirect_url) {
      const url = new URL(payment.redirect_url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid checkout link');
      location.assign(url.href);
    }
  } catch (e) {
    if (!current()) return;
    paymentAvailability = 'unavailable';
    if (start) paymentStartUncertain = true;
    paymentMessage = e.message;
  } finally {
    if (current()) { paymentBusy = false; renderPayment(); }
  }
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const rupees = (n) => (n === 0 ? 'Free' : n != null ? '₹' + Number(n).toLocaleString('en-IN') : '');
const splitList = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// --- API ------------------------------------------------------------------

async function api(path = '', opts = {}) {
  const res = await fetch('/api/rooms/' + encodeURIComponent(TOKEN) + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || STATUS_MESSAGES[res.status] || 'Request failed (' + res.status + ')'), { status: res.status });
  }
  if (res.status === 201 && opts.method === 'POST' && path === '/join') window.team54Track?.('guest_joined');
  return data;
}
const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 3000);
}

function stopPolling() {
  clearInterval(poll);
  poll = null;
}

async function refresh() {
  try {
    view = await api('');
    $('conn').classList.add('hidden');
    render();
  } catch (e) {
    if (e.status === 404) return renderMissing();
    // Transient (network, 503): keep the last view and retry on the next poll.
    $('conn').textContent = 'Having trouble reaching the room - retrying…';
    $('conn').classList.remove('hidden');
  }
}

// Runs a mutation. Every room endpoint returns the updated room view; vote/me
// always report is_organizer=false, so keep the flag from the last GET.
async function act(fn, okMsg) {
  if (busy) return false;
  busy = true;
  try {
    const data = await fn();
    const next = data && data.room ? data.room : data;
    if (next && next.meetup) view = { ...next, is_organizer: next.is_organizer || !!(view && view.is_organizer) };
    if (okMsg) toast(okMsg);
    render();
    return true;
  } catch (e) {
    toast(e.message, true);
    if (e.status === 404) renderMissing();
    else if ([401, 409, 410, 429].includes(e.status)) refresh();
    return false;
  } finally {
    busy = false;
  }
}

// --- render ------------------------------------------------------------------

function render() {
  const m = view.meetup;
  const open = m.status === 'open';
  const confirmed = !!m.final_venue;
  document.title = m.title + ' · Meetup room';
  $('room-title').textContent = m.title;
  $('room-meta').textContent = [
    m.activity,
    m.area,
    fmtWhen(m.starts_at) || 'Time to be decided together',
    m.budget != null ? 'up to ' + rupees(m.budget) + ' per person' : '',
  ].filter(Boolean).join(' · ');

  const pill = $('status-pill');
  pill.className = 'pill ' + (!open ? 'closed' : confirmed ? 'confirmed' : 'open');
  pill.textContent = !open ? 'Closed' : confirmed ? 'Venue confirmed' : 'Open';

  const ps = view.attendees;
  $('avatar-stack').innerHTML = ps.slice(0, 6).map((p) => avatar(p.guest_name)).join('')
    + (ps.length > 6 ? '<span class="more">+' + (ps.length - 6) + '</span>' : '')
    + (ps.length ? '' : '<span class="muted">Be the first to join</span>');

  $('join-card').classList.toggle('hidden', !!view.me || !open);
  $('prefs-card').classList.toggle('hidden', !view.me);
  $('vote-hint').classList.toggle('hidden', !(view.me && open && !confirmed));

  renderBanner();
  renderPayment();
  renderOrganizer();
  renderPeople();
  renderSlots();
  renderShortlist();
  if (window.MeetMiddle) window.MeetMiddle.render(view);
  if (view.me && prefsFor !== view.me.attendee_id) renderPrefs();
  document.querySelectorAll('#prefs-form input, #prefs-form button').forEach((x) => { x.disabled = !open; });
}

function renderMissing() {
  stopPolling();
  locationGeneration++;
  pendingLocation = undefined;
  if (window.MeetMiddle) window.MeetMiddle.render(null);
  $('main').innerHTML = `
    <section class="card hero">
      <p class="eyebrow">Hmm</p>
      <h1>This room link isn't valid</h1>
      <p class="sub">It may have expired. Ask the organiser to send you a fresh link.</p>
    </section>`;
  $('status-pill').className = 'pill closed';
  $('status-pill').textContent = 'Not found';
  document.title = 'Room not found';
}

function hue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatar(name) {
  const h = hue(name);
  const initials = String(name).trim().split(/\s+/).map((w) => w[0] || '').slice(0, 2).join('').toUpperCase();
  return `<span class="avatar" title="${esc(name)}" style="background:hsl(${h} 65% 45%)">${esc(initials)}</span>`;
}

function renderBanner() {
  const m = view.meetup;
  const v = m.final_venue;
  let html = '';
  if (v) {
    html = `
      <section class="banner confirmed">
        <div class="banner-icon" aria-hidden="true">🎉</div>
        <div><h2>It's ${esc(v.name)}!</h2>
          <div class="muted">${esc([v.area, rupees(v.price_per_person) && rupees(v.price_per_person) + ' per person', fmtWhen(m.starts_at)].filter(Boolean).join(' · '))}</div>
          <div class="muted">Sample suggestion - check prices and availability before booking.</div></div>
      </section>`;
  }
  if (m.status !== 'open') {
    html += `
      <section class="banner closed"><div class="banner-icon" aria-hidden="true">🔒</div>
        <div><h2>This room is closed</h2><div class="muted">The organiser has closed planning. Everything here is read-only.</div></div>
      </section>`;
  }
  $('banner').innerHTML = html;
}

function venueById(id) {
  const s = view.shortlist.find((x) => x.venue.id === id);
  return s ? s.venue : null;
}

function renderOrganizer() {
  const panel = $('org-panel');
  panel.classList.toggle('hidden', !view.is_organizer);
  if (!view.is_organizer) return;
  const open = view.meetup.status === 'open';
  const leader = venueById(view.leading_venue_id);
  const leadVotes = leader ? view.votes[leader.id] || 0 : 0;
  panel.innerHTML = `
    <div class="org-row">
      <div>
        <div class="org-label">Organiser controls</div>
        <div class="muted">${open
          ? (leader ? `Leading: <strong>${esc(leader.name)}</strong> with ${leadVotes} vote${leadVotes === 1 ? '' : 's'}` : 'Waiting for votes - share the guest link.')
          : 'This room is closed.'}</div>
      </div>
      <div class="org-actions">
        ${open && leader && !view.meetup.final_venue
          ? `<button class="btn primary sm" data-confirm="${esc(leader.id)}">Confirm ${esc(leader.name)}</button>` : ''}
        ${open ? '<button class="btn danger sm" id="org-close">Close room</button>' : ''}
      </div>
    </div>`;
  const close = $('org-close');
  if (close) {
    close.onclick = () => {
      if (confirm('Close the room? Guests will no longer be able to join, change preferences or vote. This cannot be undone.')) {
        act(() => send('POST', '/close'), 'Room closed');
      }
    };
  }
  panel.querySelectorAll('[data-confirm]').forEach(bindConfirm);
}

function bindConfirm(btn) {
  btn.onclick = () => {
    const v = venueById(btn.dataset.confirm);
    if (v && confirm('Confirm ' + v.name + ' as the venue? Voting stops once a venue is confirmed.')) {
      act(() => send('POST', '/confirm', { venue_id: v.id }), v.name + ' confirmed');
    }
  };
}

function prefTags(a) {
  const p = a.preferences || {};
  const t = [];
  if (p.budget_min != null || p.budget_max != null) {
    t.push(p.budget_min != null && p.budget_max != null ? rupees(p.budget_min) + '-' + rupees(p.budget_max)
      : p.budget_max != null ? 'up to ' + rupees(p.budget_max) : 'from ' + rupees(p.budget_min));
  }
  if (p.area) t.push(p.area);
  t.push(...[...(p.food || []), ...(p.activities || [])].slice(0, 3));
  const slots = (a.availability || []).length;
  if (slots) t.push(slots + ' slot' + (slots === 1 ? '' : 's'));
  return t.length ? t.map((x) => `<span class="tag">${esc(x)}</span>`).join('') : '<span class="tag wait">No preferences yet</span>';
}

function renderPeople() {
  const ps = view.attendees;
  const meId = view.me && view.me.attendee_id;
  $('people-count').textContent = ps.length;
  $('people').innerHTML = ps.length ? ps.map((a) => `
    <li class="person ${a.id === meId ? 'me' : ''}">
      ${avatar(a.guest_name)}
      <div>
        <div class="person-name">${esc(a.guest_name)}${a.id === meId ? ' <span class="muted">(you)</span>' : ''}</div>
        <div class="person-tags">${prefTags(a)}</div>
      </div>
    </li>`).join('') : '<li class="empty">Nobody here yet.</li>';
}

// Best time: count availability across guests (case-insensitive), most first.
function tallySlots() {
  const counts = new Map();
  for (const a of view.attendees) {
    const seen = new Set();
    for (const s of (a.availability || []).map((x) => String(x).trim()).filter(Boolean)) {
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = counts.get(k) || { slot: s, count: 0 };
      cur.count++;
      counts.set(k, cur);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.slot.localeCompare(b.slot));
}

function renderSlots() {
  const slots = tallySlots();
  if (!slots.length) {
    $('slots').innerHTML = '<p class="muted">Once people share availability, the best time lights up here.</p>';
    return;
  }
  const max = slots[0].count;
  $('slots').innerHTML = slots.slice(0, 8).map((s) => `
    <div class="slot ${s.count === max ? 'best' : ''}">
      <span class="slot-name">${esc(s.slot)}</span>
      <span class="slot-bar"><i style="width:${Math.round((s.count / max) * 100)}%"></i></span>
      <span class="slot-n">${s.count}</span>
    </div>`).join('');
}

function renderShortlist() {
  const open = view.meetup.status === 'open';
  const finalId = view.meetup.final_venue && view.meetup.final_venue.id;
  const myVote = view.me && view.me.voted_venue_id;
  const canVote = !!view.me && open && !finalId;
  const maxVotes = Math.max(1, ...Object.values(view.votes));
  $('shortlist-note').textContent = view.shortlist_note || '';

  $('shortlist').innerHTML = view.shortlist.length ? view.shortlist.map((s) => {
    const v = s.venue;
    const n = view.votes[v.id] || 0;
    const mine = myVote === v.id;
    const badge = finalId === v.id ? '<span class="badge lead">Confirmed</span>'
      : (!finalId && view.leading_venue_id === v.id ? '<span class="badge lead">Leading</span>' : '');
    let voteCtl = `<span class="muted">${n} vote${n === 1 ? '' : 's'}</span>`;
    if (canVote) {
      voteCtl = mine
        ? `<button class="btn sm vote-btn on" data-unvote="${esc(v.id)}" aria-pressed="true" title="Tap to withdraw your vote">♥ Your vote · ${n}</button>`
        : `<button class="btn sm vote-btn" data-vote="${esc(v.id)}" aria-pressed="false">♡ ${myVote ? 'Move vote here' : 'Vote'} · ${n}</button>`;
    }
    return `
      <article class="venue ${finalId === v.id ? 'chosen' : ''} ${!finalId && view.leading_venue_id === v.id ? 'leader' : ''}">
        <div class="venue-top">
          <div class="venue-name">${esc(v.name)}</div>
          ${badge}
        </div>
        <div><span class="badge sample">${esc(s.label || 'Sample suggestion')}</span></div>
        <div class="venue-meta">${esc([v.area, rupees(v.price_per_person) && rupees(v.price_per_person) + '/person'].filter(Boolean).join(' · '))}</div>
        ${(v.tags || []).length ? `<div class="venue-tags">${v.tags.slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        ${v.details ? `<div class="venue-meta">${esc(v.details)}</div>` : ''}
        ${(s.reasons || []).length ? `<ul class="reasons">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <div class="vote-row">
          ${voteCtl}
          <span class="vote-bar"><i style="width:${Math.round((n / maxVotes) * 100)}%"></i></span>
        </div>
        ${view.is_organizer && open && !finalId ? `<button class="btn sm" data-confirm="${esc(v.id)}">Confirm this venue</button>` : ''}
      </article>`;
  }).join('') : '<div class="empty">No suggestions yet. They appear once guests share an area, budget or food/activity preferences.</div>';

  $('shortlist').querySelectorAll('[data-vote]').forEach((b) => {
    b.onclick = () => act(() => send('POST', '/vote', { venue_id: b.dataset.vote }), 'Vote recorded');
  });
  $('shortlist').querySelectorAll('[data-unvote]').forEach((b) => {
    b.onclick = () => act(() => send('DELETE', '/vote'), 'Vote withdrawn');
  });
  $('shortlist').querySelectorAll('[data-confirm]').forEach(bindConfirm);
}

function chips(name, options, selected) {
  const sel = new Set(selected || []);
  const all = [...options, ...[...sel].filter((x) => !options.includes(x))];
  return all.map((x) => `
    <label class="chip"><input type="checkbox" name="${name}" value="${esc(x)}" ${sel.has(x) ? 'checked' : ''}><span>${esc(x)}</span></label>`).join('');
}

// Rendered once per guest (and after each save) so polling never wipes edits.
function renderPrefs() {
  const meId = view.me.attendee_id;
  const mine = view.attendees.find((a) => a.id === meId) || { guest_name: '', preferences: {}, availability: [] };
  const p = mine.preferences || {};
  prefsFor = meId;
  locationGeneration++;
  pendingLocation = undefined;
  const hasPrefs = !!(p.area || p.budget_max != null || p.budget_min != null || (p.food || []).length || (p.activities || []).length || (mine.availability || []).length);
  $('prefs-details').open = !hasPrefs;
  $('prefs-summary').textContent = hasPrefs ? [p.area, p.budget_max != null ? 'up to ₹' + p.budget_max : p.budget_min != null ? 'from ₹' + p.budget_min : '', (p.food || []).join(', '), (p.activities || []).join(', '), (mine.availability || []).length ? mine.availability.length + ' time slots' : ''].filter(Boolean).join(' · ') : 'Tell us your area, budget and when you are free so the shortlist fits everyone.';
  const areas = [...new Set([view.meetup.area, ...view.shortlist.map((s) => s.venue.area)].filter(Boolean))];
  $('prefs-form').innerHTML = `
    <label class="field"><span class="field-label">Your name</span>
      <input name="guest_name" maxlength="60" required value="${esc(mine.guest_name)}"></label>
    <div class="field"><span class="field-label">Budget per person (₹)</span>
      <div class="two">
        <input name="budget_min" type="number" min="0" step="50" inputmode="numeric" placeholder="Min" aria-label="Minimum budget" value="${p.budget_min == null ? '' : Number(p.budget_min)}">
        <input name="budget_max" type="number" min="0" step="50" inputmode="numeric" placeholder="Max" aria-label="Maximum budget" value="${p.budget_max == null ? '' : Number(p.budget_max)}">
      </div></div>
    <label class="field"><span class="field-label">Area</span>
      <input name="area" maxlength="80" list="area-list" placeholder="Anywhere" value="${esc(p.area || '')}">
      <datalist id="area-list">${areas.map((a) => `<option value="${esc(a)}"></option>`).join('')}</datalist></label>
    <div class="field"><span class="field-label">Where are you coming from?</span>
      <div class="loc-row">
        <button type="button" class="btn ghost sm" id="loc-btn">📍 Use my location</button>
        ${p.location ? '<button type="button" class="btn ghost sm" id="loc-clear">Stop sharing</button>' : ''}
        <span class="muted" id="loc-status">${p.location ? '✓ Location shared (others see about 1 km)' : 'Or type your area above - used to find a fair middle.'}</span>
      </div></div>
    <div class="field"><span class="field-label">Food</span>
      <div class="chips">${chips('food', FOOD, p.food)}</div>
      <input name="food_other" maxlength="200" placeholder="Other (comma-separated)" aria-label="Other food"></div>
    <div class="field"><span class="field-label">Activities</span>
      <div class="chips">${chips('activities', ACTIVITIES, p.activities)}</div>
      <input name="activities_other" maxlength="200" placeholder="Other (comma-separated)" aria-label="Other activities"></div>
    <div class="field"><span class="field-label">When are you free?</span>
      <div class="chips">${chips('availability', SLOTS, mine.availability)}</div>
      <input name="availability_other" maxlength="200" placeholder="Other times, e.g. Thu dinner" aria-label="Other times"></div>
    <button class="btn primary" type="submit">Save preferences</button>`;
  $('prefs-form').onsubmit = savePrefs;
  $('loc-btn').onclick = async () => {
    const generation = ++locationGeneration;
    const current = () => generation === locationGeneration && view?.me?.attendee_id === meId && view.meetup.status === 'open';
    $('loc-status').textContent = 'Finding you...';
    try {
      const at = await window.MeetMiddle.locate();
      if (!current()) return;
      pendingLocation = { ...at, label: 'Shared location' };
      $('loc-status').textContent = '✓ Got it - tap Save preferences to share (others see about 1 km).';
    } catch (err) { if (current()) $('loc-status').textContent = err.message; }
  };
  if ($('loc-clear')) $('loc-clear').onclick = () => { locationGeneration++; pendingLocation = null; $('loc-status').textContent = 'Location will be removed when you save.'; };
}

// undefined = unchanged (server keeps what it has), null = stop sharing, object = new location
let pendingLocation;
// Ignore results from a superseded request, saved/replaced form, or cleared location.
let locationGeneration = 0;

async function savePrefs(e) {
  e.preventDefault();
  $('prefs-error').textContent = '';
  const f = new FormData($('prefs-form'));
  const num = (k) => (String(f.get(k) || '').trim() === '' ? undefined : Math.round(Number(f.get(k))));
  const uniq = (xs) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const preferences = {};
  const min = num('budget_min');
  const max = num('budget_max');
  if ([min, max].some((x) => x !== undefined && (!Number.isFinite(x) || x < 0))) {
    $('prefs-error').textContent = 'Budget must be a positive number.';
    return;
  }
  if (min !== undefined && max !== undefined && min > max) {
    $('prefs-error').textContent = 'Minimum budget is more than the maximum.';
    return;
  }
  if (min !== undefined) preferences.budget_min = min;
  if (max !== undefined) preferences.budget_max = max;
  const area = String(f.get('area') || '').trim();
  if (area) preferences.area = area;
  const food = uniq([...f.getAll('food'), ...splitList(f.get('food_other'))]).slice(0, 20);
  const activities = uniq([...f.getAll('activities'), ...splitList(f.get('activities_other'))]).slice(0, 20);
  if (food.length) preferences.food = food;
  if (activities.length) preferences.activities = activities;
  if (pendingLocation !== undefined) preferences.location = pendingLocation;
  const body = {
    guest_name: String(f.get('guest_name') || '').trim(),
    preferences,
    availability: uniq([...f.getAll('availability'), ...splitList(f.get('availability_other'))]).slice(0, 20),
  };
  const saved = await act(() => send('PATCH', '/me', body), 'Preferences saved - shortlist updated');
  if (saved) {
    pendingLocation = undefined;
    prefsFor = null; // re-render with the saved values (folds "Other" into chips)
    render();
    $('prefs-saved').classList.remove('hidden');
    setTimeout(() => $('prefs-saved').classList.add('hidden'), 2200);
  }
}

// --- boot --------------------------------------------------------------------

$('pay-btn').onclick = () => updatePayment(true);
$('payment-check').onclick = () => updatePayment(false);

$('join-form').onsubmit = async (e) => {
  e.preventDefault();
  $('join-error').textContent = '';
  const name = $('join-name').value.trim();
  if (!name) return;
  $('join-btn').disabled = true;
  // The guest secret comes back in an httpOnly cookie; the copy in the JSON
  // body is ignored here on purpose so nothing secret lands in page storage.
  const ok = await act(() => send('POST', '/join', { guest_name: name }), 'Welcome, ' + name + '! Add your preferences.');
  $('join-btn').disabled = false;
  if (ok) $('prefs-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('share-btn').onclick = async () => {
  const link = location.origin + '/m/' + TOKEN;
  try {
    await navigator.clipboard.writeText(link);
    $('share-btn').textContent = 'Copied!';
    setTimeout(() => { $('share-btn').textContent = 'Copy guest link'; }, 1500);
  } catch {
    prompt('Copy this link:', link);
  }
};

// For the room voice helper (room-voice.js): read the view, call the room API, re-render.
window.Room = { token: TOKEN, view: () => view, send, refresh, tallySlots, SLOTS };

if (!TOKEN) {
  renderMissing();
} else {
  refresh();
  // Live-ish updates: poll while the tab is visible, pause while hidden.
  poll = setInterval(() => { if (!document.hidden && !busy) refresh(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && poll) refresh(); });
}
