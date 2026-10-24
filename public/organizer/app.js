// Organizer app - Team 54, AI Builders Day.
// Talks only to Person A's real API: same-origin /api/me/* with a Supabase
// cookie session. Nothing is ever sent automatically - every action is an
// explicit tap. All state lives on the server, so everything survives refresh.

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
  if (res.status === 201 && opts.method === 'POST' && path === '/api/me/meetups') {
    window.team54Track?.('meetup_created');
  }
  if (res.status === 204) return null;
  return res.json();
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

// Each navigation bumps navGen; a view that finishes loading after the user
// has moved on must not paint over the newer page.
let navGen = 0;
const navToken = () => navGen;
const stale = (token) => token !== navGen;

function route() {
  navGen++;
  window.OrganizerOnboarding = null;
  el('app').className = 'container';
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
    '#/onboarding': () => onboardingView(),
    '#/welcome': welcomeView,
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

// "Your people": every contact, soonest check-in first, with a due badge.
function peopleCard(contacts) {
  const DAY = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = (c) => {
    if (!c.next_followup_at) return null;
    const d = new Date(c.next_followup_at); d.setHours(0, 0, 0, 0);
    const n = Math.round((d - today) / DAY);
    return Number.isFinite(n) ? n : null;
  };
  const badge = (n) => n === null ? '' : n < 0 ? '<span class="due due-late">overdue</span>'
    : n === 0 ? '<span class="due due-today">today</span>'
    : n <= 7 ? '<span class="due">soon</span>' : `<span class="due">in ${n} days</span>`;
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const people = contacts.slice().sort((a, b) => (due(a) ?? 1e9) - (due(b) ?? 1e9) || (a.name || '').localeCompare(b.name || ''));
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
  const nav = navToken();
  renderLoading('Loading your dashboard...');
  let d, graphContacts = [];
  try {
    d = await api('/api/me/dashboard');
    try {
      const rc = await api('/api/me/contacts');
      graphContacts = Array.isArray(rc) ? rc : (rc.contacts || []);
    } catch (e2) { graphContacts = []; }
  } catch (e) { if (stale(nav)) return; return renderError(e, dashboardView); }

  const counts = d.contact_counts || {};
  const totalContacts = CATEGORIES.reduce((s, c) => s + (counts[c] || 0), 0);
  const act = d.recorded_activity || { label: 'Recorded activity', total: 0, by_category: {}, sufficient_data: false };
  const followups = d.followups || { overdue: [], upcoming: [] };
  const meetups = d.upcoming_meetups || [];
  const recent = d.recent_activity || [];

  if (d.is_empty) {
    if (stale(nav)) return;
  el('app').innerHTML = `
      <h1>Dashboard</h1>
      <div class="card state-box">
        <h2>Welcome to Organizer</h2>
        <p class="muted">Nothing here yet. Add your people and plan your first meetup.</p>
        <div class="quick-actions" style="justify-content:center">
          <button class="primary" id="qa-add">Add person</button>
          <button class="primary" id="qa-meetup">Plan a meetup</button>
        </div>
        <p><button class="link-btn" id="qa-guide">What can muop do?</button></p>
      </div>`;
    el('qa-guide').onclick = () => go('#/welcome');
    el('qa-add').onclick = () => { sessionStorage.setItem('org_new_contact', '1'); go('#/contacts'); };
    el('qa-meetup').onclick = () => go('#/meetups');
    return;
  }

  const followupRow = (f, overdue) => `
    <div class="row" data-fu-name="${esc(f.name || '')}">
      <div><strong>${esc(f.name || 'Someone')}</strong>
        ${f.category ? `<span class="tag">${esc(catLabel(f.category))}</span>` : ''}${overdue ? ' <span class="tag overdue">Overdue</span>' : ''}
        <div class="muted">${overdue ? 'Was due' : 'Due'} ${esc(fmtDay(f.next_followup_at))}</div>
      </div>
      <div class="actions"><button data-done="${esc(f.id || f.contact_id || '')}" data-name="${esc(f.name || '')}">Mark done</button></div>
    </div>`;

  if (stale(nav)) return;
  const nOver = (followups.overdue || []).length;
  const nWeek = (followups.upcoming || []).filter((f) => new Date(f.next_followup_at).getTime() < Date.now() + 7 * 864e5).length;
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
      ${(followups.overdue || []).map((f) => followupRow(f, true)).join('')}
      ${(followups.upcoming || []).map((f) => followupRow(f, false)).join('')}
      ${!(followups.overdue || []).length && !(followups.upcoming || []).length ? '<p class="muted">No follow-ups due.</p>' : ''}
    </section>
    <section class="card" id="sec-meetups">
      <h2>Upcoming meetups</h2>
      ${meetups.length ? meetups.map((m) => `
        <div class="row">
          <div><strong>${esc(m.title)}</strong>
            ${m.activity ? `<span class="tag">${esc(m.activity)}</span>` : ''}
            <div class="muted">${[m.area, fmtDate(m.starts_at)].filter(Boolean).join(' · ')}</div>
            ${m.room_token ? `<div class="muted mono">${esc(roomUrl(m.room_token))}</div>` : ''}
          </div>
          ${m.room_token ? `<div class="actions"><button data-copy="${esc(roomUrl(m.room_token))}">Copy link</button></div>` : ''}
        </div>`).join('') : '<p class="muted">No meetups planned yet. Plan one to get people together.</p>'}
    </section>
    </div>
    ${peopleCard(graphContacts)}
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

  document.querySelectorAll('[data-person]').forEach((b) => { b.onclick = () => go('#/contacts/' + encodeURIComponent(b.dataset.person)); });
  el('qa-add').onclick = () => { sessionStorage.setItem('org_new_contact', '1'); go('#/contacts'); };
  el('qa-meetup').onclick = () => go('#/meetups');
  document.querySelectorAll('[data-jump]').forEach((b) => { b.onclick = () => el(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  wireCalendar();
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyText(b.dataset.copy, b, 'Copy link'); });
  document.querySelectorAll('[data-done]').forEach((b) => { b.onclick = () => markDoneForm(b); });
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
  const now = Date.now();
  const WEEK = 7 * 24 * 3600 * 1000;
  const urgency = (c) => {
    if (!c.next_followup_at) return 2;
    const t = new Date(c.next_followup_at).getTime();
    if (isNaN(t)) return 2;
    if (t < now - 24 * 3600 * 1000) return 0;
    if (t < now + WEEK) return 1;
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
      const sub = c.next_followup_at ? ' · next check-in ' + fmtDay(c.next_followup_at) : ' · no check-in date';
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
const dayStart = (d) => { const t = new Date(d); t.setHours(0, 0, 0, 0); return t; };
const lateText = (n) => `${n} day${n === 1 ? '' : 's'} overdue`;
function calMarker(e) {
  if (e.kind === 'meetup') return `<i class="cal-mark meetup" title="${esc(e.label)}">📅</i>`;
  const tip = e.label + (e.status === 'overdue' ? ` - not connected, ${lateText(e.late)}` : ' - due soon');
  return `<i class="cal-mark ${e.status} cat-${esc(e.cat || 'personal')}" title="${esc(tip)}">${CAT_ICON[e.cat] || '●'}</i>`;
}
function calLine(e) {
  if (e.kind === 'meetup') return `Meetup: ${esc(e.label)}${e.time ? ` · ${esc(e.time)}` : ''}`;
  return e.status === 'overdue'
    ? `Haven't connected with <strong>${esc(e.label)}</strong> · ${lateText(e.late)}`
    : `Check in with ${esc(e.label)}`;
}

function calendarHTML(contacts, meetups) {
  const now = new Date();
  const today0 = dayStart(now);
  const year = now.getFullYear(), month = now.getMonth();
  const monthName = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const events = {};
  const add = (t, ev) => {
    if (t.getFullYear() !== year || t.getMonth() !== month) return;
    (events[t.getDate()] = events[t.getDate()] || []).push(ev);
  };
  const overdue = [];
  (contacts || []).forEach((c) => {
    const t = c.next_followup_at && new Date(c.next_followup_at);
    if (!t || isNaN(t)) return;
    const late = Math.round((today0 - dayStart(t)) / 864e5);
    const ev = { kind: 'followup', status: late > 0 ? 'overdue' : 'soon', cat: c.category, label: c.name || 'Someone', late };
    if (late > 0) overdue.push(ev);
    add(t, ev);
  });
  (meetups || []).forEach((m) => {
    const t = m.starts_at && new Date(m.starts_at);
    if (t && !isNaN(t)) add(t, { kind: 'meetup', label: m.title || 'Meetup', time: t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) });
  });
  overdue.sort((x, y) => y.late - x.late);
  // Read by wireCalendar() for the day detail panel.
  window.__calEvents = events;

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push('<div class="cal-cell cal-pad"></div>');
  for (let day = 1; day <= daysInMonth; day++) {
    const evs = events[day] || [];
    const isToday = day === now.getDate();
    const cls = (isToday ? ' cal-today' : '') + (evs.length ? ' has-ev' : '') + (evs.some((e) => e.status === 'overdue') ? ' cal-late' : '');
    const marks = evs.slice(0, 3).map(calMarker).join('') + (evs.length > 3 ? `<span class="cal-more">+${evs.length - 3}</span>` : '');
    const tip = evs.map((e) => (e.kind === 'meetup' ? 'Meetup: ' : e.status === 'overdue' ? 'Not connected: ' : 'Check-in: ') + e.label).join('; ');
    cells.push(`<button type="button" class="cal-cell${cls}" data-day="${day}"${isToday ? ' aria-current="date"' : ''} aria-label="${esc(monthName.split(' ')[0] + ' ' + day + (tip ? ': ' + tip : ': nothing planned'))}"><span class="cal-day">${day}</span><span class="cal-dots">${marks}</span></button>`);
  }
  const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<div class="cal-head">${d}</div>`).join('');
  const todayLabel = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const lines = overdue.map((e) => `<li class="late">${calMarker(e)}<span>${calLine(e)}</span></li>`);
  return `<div class="calendar">
    <div class="cal-todaybar"><strong>Today</strong> ${esc(todayLabel)}
      ${overdue.length ? `<span class="cal-overdue-count">${overdue.length} overdue</span>` : '<span class="cal-ok">All caught up</span>'}</div>
    ${lines.length ? `<ul class="cal-todaylist">${lines.join('')}</ul>` : ''}
    <div class="cal-month">${esc(monthName)}</div><div class="cal-grid">${names}${cells.join('')}</div>
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
  const box = el('cal-detail');
  if (!box) return;
  const show = (day) => {
    const list = ev[day] || [];
    document.querySelectorAll('.cal-cell[data-day]').forEach((b) => b.classList.toggle('selected', Number(b.dataset.day) === Number(day)));
    const when = new Date(new Date().getFullYear(), new Date().getMonth(), Number(day)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    box.innerHTML = `<strong>${esc(when)}</strong>` + (list.length
      ? list.map((e) => `<div class="cal-item${e.status === 'overdue' ? ' late' : ''}">${calMarker(e)}<span>${calLine(e)}</span></div>`).join('')
      : '<div class="muted">Nothing planned.</div>');
  };
  document.querySelectorAll('.cal-cell[data-day]').forEach((b) => { b.onclick = () => show(b.dataset.day); });
  show(new Date().getDate());
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
  const nav = navToken();
  renderLoading('Loading contacts...');
  const filter = sessionStorage.getItem('org_filter') || '';
  let contacts;
  try {
    const r = await api('/api/me/contacts' + (filter ? '?category=' + encodeURIComponent(filter) : ''));
    contacts = Array.isArray(r) ? r : (r.contacts || []);
  } catch (e) { if (stale(nav)) return; return renderError(e, contactsView); }

  if (stale(nav)) return;
  const openForm = !!sessionStorage.getItem('org_new_contact') || !contacts.length;
  el('app').innerHTML = `
    <div class="page-head"><div><h1>Contacts</h1><p class="muted lede">${contacts.length} ${contacts.length === 1 ? 'person' : 'people'}${filter ? ' in ' + esc(filter) : ''}</p></div></div>
    <section class="card">
      <div class="toolbar">
        <input id="c-search" type="search" placeholder="Search by name or interest" aria-label="Search contacts">
        <div class="chips" role="group" aria-label="Filter by category">
          ${['', ...CATEGORIES].map((c) => `<button type="button" class="chip${c === filter ? ' on' : ''}" data-filter="${c}">${c ? catLabel(c) : 'All'}</button>`).join('')}
        </div>
      </div>
      <div id="contact-list"></div>
    </section>
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
          <label>Next follow-up <input id="c-next" type="date"></label>
          <label>Email <input id="c-email" type="email" placeholder="name@example.com"></label>
          <label class="full">Notes <input id="c-notes" placeholder="Notes"></label>
        </div>
        <p class="error" id="add-error"></p>
        <button class="primary" type="submit">Add</button>
      </form>
    </details>`;

  const sorted = contacts.slice().sort((x, y) => {
    const tx = x.next_followup_at ? new Date(x.next_followup_at).getTime() : Infinity;
    const ty = y.next_followup_at ? new Date(y.next_followup_at).getTime() : Infinity;
    return tx - ty || String(x.name).localeCompare(String(y.name));
  });
  const paint = () => {
    const q = el('c-search').value.trim().toLowerCase();
    const list = sorted.filter((c) => !q || (c.name || '').toLowerCase().includes(q) || (c.interests || []).some((i) => String(i).toLowerCase().includes(q)));
    el('contact-list').innerHTML = list.length ? list.map(contactRow).join('')
      : `<p class="muted empty">${q ? 'No one matches "' + esc(q) + '".' : (filter ? 'No ' + filter + ' contacts yet.' : 'No contacts yet. Add your first person below.')}</p>`;
    document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => go('#/contacts/' + encodeURIComponent(b.dataset.view)); });
  };
  el('c-search').oninput = paint;
  paint();
  document.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { sessionStorage.setItem('org_filter', b.dataset.filter); contactsView(); }; });
  el('add-form').onsubmit = async (e) => {
    e.preventDefault();
    el('add-error').textContent = '';
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
    if (next) body.next_followup_at = new Date(next + 'T12:00:00').toISOString();
    try {
      await api('/api/me/contacts', { method: 'POST', body: JSON.stringify(body) });
      flash(body.name + ' added. Open them to log a check-in or plan a meetup.');
      contactsView();
    } catch (err) { el('add-error').textContent = err.message; }
  };
  if (sessionStorage.getItem('org_new_contact')) {
    sessionStorage.removeItem('org_new_contact');
    el('add-details').scrollIntoView({ block: 'center' });
    el('c-name').focus();
  }
}

function contactRow(c) {
  const t = c.next_followup_at ? new Date(c.next_followup_at).getTime() : NaN;
  const overdue = !isNaN(t) && t < Date.now() - 24 * 3600 * 1000;
  return `
    <div class="row contact-row">
      <div><strong>${esc(c.name)}</strong> <span class="tag">${esc(catLabel(c.category))}</span>${overdue ? ' <span class="tag overdue">Overdue</span>' : ''}
        ${(c.interests || []).length ? `<div class="interest-pills">${c.interests.map((i) => `<span class="tag">${esc(i)}</span>`).join('')}</div>` : ''}
        <div class="muted">${c.next_followup_at ? (overdue ? 'Was due ' : 'Next check-in ') + esc(fmtDay(c.next_followup_at)) : 'No check-in scheduled'}</div>
      </div>
      <div class="actions"><button data-view="${esc(c.id)}">Open</button></div>
    </div>`;
}

// --- contact detail: profile + history, edit, delete ------------------------

async function contactDetailView(id) {
  const nav = navToken();
  renderLoading('Loading contact...');
  let contact, interactions;
  try {
    const r = await api('/api/me/contacts/' + encodeURIComponent(id));
    contact = r.contact || r;
    interactions = r.interactions || [];
  } catch (e) { if (stale(nav)) return; return renderError(e, () => contactDetailView(id)); }

  if (stale(nav)) return;
  const tt = contact.next_followup_at ? new Date(contact.next_followup_at).getTime() : NaN;
  const dueDays = isNaN(tt) ? null : Math.round((tt - Date.now()) / 864e5);
  const dueText = dueDays === null ? 'No check-in scheduled' : dueDays < -1 ? `Check-in overdue by ${-dueDays} days` : dueDays <= 0 ? 'Check-in due today' : `Next check-in in ${dueDays} day${dueDays === 1 ? '' : 's'}`;
  const dueCls = dueDays !== null && dueDays < -1 ? 'warn' : dueDays !== null && dueDays <= 7 ? 'soon' : 'ok';
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
        <span class="muted">${contact.next_followup_at ? esc(fmtDay(contact.next_followup_at)) + ' · ' : ''}every ${contact.preferred_frequency_days || 14} days${contact.last_interaction_at ? ' · last spoke ' + esc(fmtDay(contact.last_interaction_at)) : ''}</span></div>
      ${(contact.interests || []).length ? `<p class="interest-pills">${contact.interests.map((i) => `<span class="tag">${esc(i)}</span>`).join('')}</p>` : ''}
      ${contact.notes ? `<p class="notes">${esc(contact.notes)}</p>` : ''}
    </section>
    <section class="card">
      <h2>Log a check-in</h2>
      <form id="log-form">
        <label>What happened? <input id="log-note" placeholder="Coffee, a call, a message..."></label>
        <label>Next follow-up (optional) <input id="log-next" type="date"></label>
        <p class="muted">Leave the date blank to schedule by their check-in frequency.</p>
        <p class="error" id="log-error"></p>
        <button class="primary" type="submit">Save check-in</button>
      </form>
    </section>
    <section class="card">
      <h2>History</h2>
      ${interactions.length ? `<ol class="timeline">${interactions.map((i) => `
        <li><i class="tl-dot"></i><div><strong>${esc((i.type || 'interaction').replace(/_/g, ' '))}</strong>
          <span class="muted"> · ${esc(fmtDate(i.occurred_at))}</span>
          ${i.notes ? `<div>${esc(i.notes)}</div>` : ''}</div></li>`).join('')}</ol>` : '<p class="muted empty">No check-ins yet. Log the first one above.</p>'}
    </section>
    <div class="manage"><button class="primary" id="c-meetup">Plan a meetup with ${esc(String(contact.name || '').split(/\s+/)[0])}</button> <a class="button" id="c-email-link" href="${esc(checkInEmail(contact))}">Email</a> <button id="c-edit">Edit details</button> <button class="danger" id="c-del">Delete contact</button></div>`;

  el('back').onclick = () => go('#/contacts');
  el('c-meetup').onclick = () => { sessionStorage.setItem('org_meetup_title', 'Catch-up with ' + String(contact.name || '').split(/\s+/)[0]); go('#/meetups'); };
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
      flash('Check-in saved. Your next reminder is set.', [['Back to dashboard', '#/dashboard']]);
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
  const nav = navToken();
  renderLoading('Loading meetups...');
  let meetups;
  try {
    const r = await api('/api/me/meetups');
    meetups = Array.isArray(r) ? r : (r.meetups || []);
  } catch (e) { if (stale(nav)) return; return renderError(e, () => meetupsView()); }

  if (stale(nav)) return;
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
      ${meetups.length ? meetups.slice().sort((x, y) => ((x.status || 'open') !== 'open') - ((y.status || 'open') !== 'open')).map(meetupRow).join('') : '<p class="muted empty">No meetups yet. Plan one above and share the room link with your people.</p>'}
    </section>`;

  const pre = sessionStorage.getItem('org_meetup_title');
  if (pre) { sessionStorage.removeItem('org_meetup_title'); el('m-title').value = pre; el('m-title').focus(); }
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
    <div class="row${closed ? ' is-closed' : ''}">
      <div><strong>${esc(m.title)}</strong>
        ${m.activity ? `<span class="tag">${esc(m.activity)}</span>` : ''}
        <span class="tag ${closed ? 'status-closed' : 'status-open'}">${esc(m.status || 'open')}</span>
        <div class="muted">${[m.area, fmtDate(m.starts_at), m.budget ? '₹' + m.budget + ' per person' : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="actions">
        ${url ? `<button data-copy="${esc(url)}">Copy link</button>` : ''}
        ${url && !closed ? `<a class="button" href="${esc(meetupInviteEmail(m, url))}">Email invite</a>` : ''}
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
// On this screen, voice.js ("Talk instead" / "Type instead") calls /api/extract
// and pre-fills the rows + goals directly; it also stores org_prefill so a
// refresh keeps the result. Nothing is saved until Confirm.

function prefill() {
  try {
    const raw = window.ORGANIZER_PREFILL || sessionStorage.getItem('org_prefill');
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return p && typeof p === 'object' ? p : {};
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
  ['1', 'Keep your people close', 'Add friends, colleagues and community. Group them as Personal, Professional or Community and set how often you want to check in.'],
  ['2', 'See who needs you', 'Your dashboard shows a network map and a calendar. The closer someone is to the centre, the sooner a check-in is due.'],
  ['3', 'Log check-ins', 'Note what happened after a coffee or a call. The next reminder is set for you, or you pick the date.'],
  ['4', 'Plan meetups together', 'Create a meetup and share its room link. Guests add budget, area and free times, then vote on a shortlist of places. Nothing is ever sent for you.'],
  ['5', 'Balance your attention', 'Set goals for Personal, Professional and Community, then compare them with where your time actually went.'],
];

function welcomeView(opts = {}) {
  const returning = !!opts.returning || localStorage.getItem('org_onboarded') === '1';
  el('app').innerHTML = `
    <section class="card welcome">
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
  const done = () => { localStorage.setItem('org_onboarded', '1'); go('#/dashboard'); };
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
  const p = prefill();
  const rows = (p.contacts && p.contacts.length ? p.contacts.slice(0, 5) : [emptyRow()]).map(toRow);
  const goals = { personal: 50, professional: 30, community: 20, ...(p.goals || {}) };
  let step = 1;
  let voice = null;

  const finish = (added) => {
    if (voice) voice.stop();
    localStorage.setItem('org_onboarded', '1');
    sessionStorage.removeItem('org_prefill');
    if (added && added.length) return renderDone(added);
    go('#/dashboard');
  };

  function renderDone(added) {
    el('app').innerHTML = `
      <section class="card welcome">
        <p class="eyebrow">You are set</p>
        <h1>${added.length} ${added.length === 1 ? 'person' : 'people'} added. What next?</h1>
        <div class="next-grid">
          <button class="next-card" id="d-checkin"><strong>Log a check-in</strong><span class="muted">Record a recent catch-up with ${esc(added[0].name)}.</span></button>
          <button class="next-card" id="d-meetup"><strong>Plan a meetup</strong><span class="muted">Create a room link to share with friends.</span></button>
          <button class="next-card" id="d-dash"><strong>See your dashboard</strong><span class="muted">Your network map and calendar.</span></button>
        </div>
      </section>`;
    el('d-checkin').onclick = async () => {
      try {
        const r = await api('/api/me/contacts');
        const list = Array.isArray(r) ? r : (r.contacts || []);
        const m = list.find((c) => c.name === added[0].name);
        go(m ? '#/contacts/' + encodeURIComponent(m.id) : '#/contacts');
      } catch { go('#/contacts'); }
    };
    el('d-meetup').onclick = () => go('#/meetups');
    el('d-dash').onclick = () => go('#/dashboard');
  }

  // Voice / typed extraction -> pre-fill only. Rows the user already typed are
  // kept; extracted people fill the remaining slots (max 5).
  function applyExtraction(res) {
    if (step !== 1 || !el('ob-rows')) return; // late result after leaving the people step
    collectRows();
    el('ob-error').textContent = '';
    const kept = rows.filter((r) => r.name);
    const names = new Set(kept.map((r) => r.name.toLowerCase()));
    const added = (res.contacts || []).map(toRow).filter((r) => r.name && !names.has(r.name.toLowerCase()));
    const merged = [...kept, ...added].slice(0, 5);
    rows.splice(0, rows.length, ...(merged.length ? merged : [emptyRow()]));
    if (res.goals) Object.assign(goals, res.goals);
    try {
      sessionStorage.setItem('org_prefill', JSON.stringify({
        contacts: merged.map((r) => ({ name: r.name, category: r.category, interests: r.interests, preferred_frequency_days: r.freq })),
        goals,
      }));
    } catch { /* storage unavailable: pre-fill still applies on screen */ }
    renderRows();
    if (merged.length >= 5 && kept.length + added.length > 5) {
      el('ob-error').textContent = 'Only the first 5 people were kept - you can add more from Contacts later.';
    }
    // "That's everyone, save it": move on to the goals step. Saving still needs
    // the explicit Confirm there, so a misheard command can't write anything.
    if (res.action === 'confirm' && merged.some((r) => r.name)) el('ob-next').click();
  }

  function renderStep1() {
    if (voice) voice.stop();
    step = 1;
    el('app').innerHTML = `
      <section class="card">
        <div class="step-dots">Step 1 of 2 · People</div>
        <h1>Let's find your people</h1>
        <div id="voice-mount"></div>
        <h2 class="ob-sub">Your people <span class="muted">(up to 5)</span></h2>
        <p class="muted">Anyone I hear or you type appears here. Check and edit them. Nothing is saved until you finish setup.</p>
        <div id="ob-rows"></div>
        <p><button class="link-btn" id="ob-add">+ Add another</button></p>
        <p class="error" id="ob-error"></p>
        <div class="quick-actions">
          <button class="primary" id="ob-next">Next: goals</button>
          <button id="ob-skip">Skip for now</button>
        </div>
        <p><button class="link-btn" id="ob-welcome">← What can muop do?</button></p>
      </section>`;
    renderRows();
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
      collectRows();
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
          <button class="primary" id="ob-confirm">Save and finish</button>
          <button id="ob-skip">Skip for now</button>
        </div>
      </section>`;
    const inputs = [...document.querySelectorAll('.goal-input')];
    const total = () => inputs.reduce((s, i) => s + (parseInt(i.value, 10) || 0), 0);
    const refresh = () => { el('goals-total').textContent = total(); };
    inputs.forEach((i) => { i.oninput = refresh; });
    refresh();
    el('ob-back').onclick = renderStep1;
    el('ob-skip').onclick = () => finish();
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
        finish(contacts);
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
  window.onhashchange = route;
  installFlash();
  if (d.is_empty && !onboarded && hash !== '#/onboarding' && hash !== '#/welcome') {
    go('#/welcome');
  }
  route();
}

boot();
