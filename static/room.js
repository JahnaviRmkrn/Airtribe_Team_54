"use strict";
// Guest Meetup Room at /m/<token> (TypeScript)
// Guests: join with name -> configure preferences -> vote on shortlist.
// Organizer (?key=...): confirm a venue or close the room.
const TOKEN = location.pathname.split('/').filter(Boolean).pop() || '';
const ID_KEY = `room_${TOKEN}`;
const ORG_KEY = `room_key_${TOKEN}`;
const POLL_MS = 4000;
const PRICE = (n) => '₹'.repeat(n || 0);
// Organizer key: move it from the URL into localStorage so the address bar is safe to share.
(() => {
    const k = new URLSearchParams(location.search).get('key');
    if (k) {
        localStorage.setItem(ORG_KEY, k);
        history.replaceState(null, '', location.pathname);
    }
})();
const me = {
    get id() {
        try {
            return JSON.parse(localStorage.getItem(ID_KEY) || '') || null;
        }
        catch {
            return null;
        }
    },
    set id(v) {
        if (v)
            localStorage.setItem(ID_KEY, JSON.stringify(v));
        else
            localStorage.removeItem(ID_KEY);
    },
    get key() {
        return localStorage.getItem(ORG_KEY);
    },
};
let room = null;
let prefsRenderedFor = null;
let busy = false;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
async function api(path, opts = {}) {
    const res = await fetch('/api/rooms/' + TOKEN + path, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
        throw Object.assign(new Error(data.detail || res.statusText), { status: res.status });
    return data;
}
const post = (path, body, method = 'POST') => api(path, { method, body: JSON.stringify(body) });
const auth = () => ({ pid: me.id?.pid, secret: me.id?.secret });
function toast(msg, bad = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => {
        t.className = 'toast' + (bad ? ' bad' : '');
    }, 2600);
}
function hue(name) {
    let h = 0;
    for (const ch of name)
        h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
}
function avatar(name) {
    const h = hue(name);
    const initials = name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    return `<span class="avatar" title="${esc(name)}" style="background:linear-gradient(135deg,hsl(${h} 80% 58%),hsl(${(h + 40) % 360} 80% 45%))">${esc(initials)}</span>`;
}
// --- data ------------------------------------------------------------------
async function refresh() {
    const q = new URLSearchParams();
    if (me.id)
        q.set('pid', me.id.pid);
    if (me.key)
        q.set('key', me.key);
    try {
        room = await api('?' + q.toString());
    }
    catch (e) {
        if (e.status === 404)
            return renderMissing();
        return;
    }
    if (me.id && !room.me)
        me.id = null;
    if (me.key && !room.is_organizer)
        localStorage.removeItem(ORG_KEY);
    render();
}
async function act(fn, okMsg) {
    if (busy)
        return;
    busy = true;
    try {
        await fn();
        if (okMsg)
            toast(okMsg);
        await refresh();
    }
    catch (e) {
        toast(e.message, true);
    }
    finally {
        busy = false;
    }
}
// --- render ----------------------------------------------------------------
function render() {
    const open = room.status === 'open';
    $('room-title').textContent = room.title;
    $('room-when').textContent = room.when + (room.confirmed_venue ? ` · Confirmed at ${room.confirmed_venue.name}` : '');
    $('status-pill').textContent = open ? 'Planning open' : (room.status === 'confirmed' ? 'Venue confirmed' : 'Closed');
    $('status-pill').className = 'pill ' + (open ? 'open' : (room.status === 'confirmed' ? 'done' : 'closed'));
    const stack = $('avatar-stack');
    stack.innerHTML = room.participants.map((p) => avatar(p.name)).join('');
    $('join-card').classList.toggle('hidden', !!room.me || !open);
    $('prefs-card').classList.toggle('hidden', !room.me);
    renderBanner();
    renderOrganizer();
    renderPeople();
    renderSlots();
    renderShortlist();
    if (room.me && prefsRenderedFor !== room.me.id) {
        renderPrefs();
    }
    renderSuggest();
    $('suggest').classList.toggle('hidden', !room.me || !open);
    setFormsDisabled(!open);
}
function renderMissing() {
    $('hero').innerHTML = `
    <h1 style="color:var(--danger)">Meetup not found</h1>
    <p class="sub">This room link is invalid or may have expired.</p>
    <a href="/" class="btn primary" style="margin-top:14px;">Return to Moup</a>`;
    $('status-pill').textContent = '404';
    $('status-pill').className = 'pill closed';
    ['join-card', 'prefs-card', 'org-panel'].forEach((id) => $(id).classList.add('hidden'));
}
function renderBanner() {
    const b = $('banner');
    if (room.status === 'confirmed' && room.confirmed_venue) {
        const v = room.confirmed_venue;
        b.innerHTML = `
      <section class="banner confirmed glass card">
        <div class="banner-badge">Venue confirmed</div>
        <h2>${esc(v.name)}</h2>
        <p class="muted">${esc(v.area)} · ${PRICE(v.price)}${v.blurb ? ' · ' + esc(v.blurb) : ''}</p>
      </section>`;
        return;
    }
    if (room.status === 'closed') {
        b.innerHTML = `
      <section class="banner closed glass card">
        <h2>Planning is closed</h2>
        <p class="muted">The host has closed this meetup session. Results are read-only.</p>
      </section>`;
        return;
    }
    b.innerHTML = '';
}
function renderOrganizer() {
    const panel = $('org-panel');
    panel.classList.toggle('hidden', !room.is_organizer);
    if (!room.is_organizer)
        return;
    const open = room.status === 'open';
    panel.innerHTML = `
    <div class="card-head">
      <div>
        <div class="org-label">Organizer controls</div>
        <div class="muted">You created this room. Lock the venue or close planning anytime.</div>
      </div>
      <div class="row">
        ${open ? '<button class="btn danger sm" id="org-close">Close room</button>' : '<button class="btn sm" id="org-reopen">Reopen room</button>'}
      </div>
    </div>`;
    if ($('org-close')) {
        $('org-close').onclick = () => {
            if (confirm('Close the room now? Guests will no longer be able to modify preferences.')) {
                act(() => post('/close', { key: me.key }), 'Room closed');
            }
        };
    }
    if ($('org-reopen')) {
        $('org-reopen').onclick = () => act(() => post('/reopen', { key: me.key }), 'Room reopened');
    }
    panel.querySelectorAll('[data-confirm]').forEach(bindConfirm);
}
function bindConfirm(btn) {
    btn.onclick = () => {
        const v = room.venues.find((x) => x.id === btn.dataset.confirm);
        if (v && confirm(`Confirm ${v.name} as the venue? This locks voting.`)) {
            act(() => post('/confirm', { key: me.key, venue_id: v.id }), `${v.name} confirmed`);
        }
    };
}
function prefTags(p) {
    if (!p)
        return '<span class="tag wait">Selecting preferences…</span>';
    const t = [];
    if (p.budget)
        t.push(PRICE(p.budget));
    if (p.area)
        t.push(p.area);
    t.push(...(p.kinds || []).slice(0, 3));
    if ((p.availability || []).length)
        t.push(`${p.availability.length} slot${p.availability.length === 1 ? '' : 's'}`);
    return t.map((x) => `<span class="tag">${esc(x)}</span>`).join('');
}
function renderPeople() {
    const ps = room.participants;
    $('people-count').textContent = ps.length;
    $('people').innerHTML = ps.length ? ps.map((p) => `
    <li class="person ${room.me && room.me.id === p.id ? 'me' : ''}">
      ${avatar(p.name)}
      <div>
        <div class="person-name">${esc(p.name)}${room.me && room.me.id === p.id ? ' <span class="muted">(you)</span>' : ''}</div>
        <div class="person-tags">${prefTags(p.prefs)}</div>
      </div>
    </li>`).join('') : '<li class="empty">Nobody here yet.</li>';
}
function renderSlots() {
    const max = Math.max(1, ...room.slots.map((s) => s.count));
    const any = room.slots.some((s) => s.count);
    $('slots').innerHTML = any ? room.slots.map((s) => `
    <div class="slot ${s.best ? 'best' : ''}">
      <span class="slot-name">${esc(s.slot)}</span>
      <span class="slot-bar"><i style="width:${(s.count / max) * 100}%"></i></span>
      <span class="slot-n">${s.count}</span>
    </div>`).join('') : '<p class="muted">Availability preferences will illuminate the optimal meeting time here.</p>';
}
function renderShortlist() {
    const vs = room.venues;
    const open = room.status === 'open';
    const maxVotes = Math.max(1, ...vs.map((v) => v.votes));
    const confirmedId = room.confirmed_venue && room.confirmed_venue.id;
    $('shortlist').innerHTML = vs.length ? vs.map((v, i) => `
    <article class="venue ${confirmedId === v.id ? 'chosen' : ''} ${!confirmedId && i === 0 && v.votes ? 'leader' : ''}" style="animation-delay:${i * 40}ms">
      <div class="venue-top">
        <div class="venue-name">${esc(v.name)}</div>
        ${confirmedId === v.id ? '<span class="badge lead">Confirmed</span>'
        : (!confirmedId && i === 0 && v.votes ? '<span class="badge lead">Leading</span>'
            : (v.source === 'guest' ? '<span class="badge guest">Guest pick</span>' : ''))}
      </div>
      <div class="venue-meta">${esc(v.area)} · <span class="price">${PRICE(v.price)}</span>${v.kinds.length ? ' · ' + v.kinds.map(esc).join(', ') : ''}</div>
      <div class="venue-meta">${esc(v.blurb || '')}</div>
      ${v.fit_of ? `<div><span class="badge fit">Fits ${v.fits}/${v.fit_of} preferences</span></div>` : ''}
      <div class="voters">${v.voters.length ? '♥ ' + v.voters.map(esc).join(', ') : ''}</div>
      <div class="vote-row">
        ${room.me && open
        ? `<button class="btn sm vote-btn ${v.mine ? 'on' : ''}" data-vote="${v.id}" aria-pressed="${v.mine}"><span class="heart">${v.mine ? '♥' : '♡'}</span> ${v.votes}</button>`
        : `<span class="muted">${v.votes} vote${v.votes === 1 ? '' : 's'}</span>`}
        <span class="vote-bar"><i style="width:${(v.votes / maxVotes) * 100}%"></i></span>
      </div>
      ${room.is_organizer && open ? `<button class="btn sm" data-confirm="${v.id}">Confirm this venue</button>` : ''}
    </article>`).join('') : '<div class="empty">The shortlist will populate as attendees join.</div>';
    $('shortlist').querySelectorAll('[data-vote]').forEach((b) => {
        b.onclick = () => act(() => post('/votes', { ...auth(), venue_id: b.dataset.vote }));
    });
    $('shortlist').querySelectorAll('[data-confirm]').forEach(bindConfirm);
}
function chipGroup(name, items, selected, type = 'checkbox', label = (x) => x) {
    return items.map((x) => `
    <label class="chip"><input type="${type}" name="${name}" value="${esc(x)}" ${selected.includes(x) ? 'checked' : ''}><span>${esc(label(x))}</span></label>`).join('');
}
function renderPrefs() {
    const o = room.options;
    const p = room.me.prefs || {};
    prefsRenderedFor = room.me.id;
    $('prefs-form').innerHTML = `
    <div class="field">
      <span class="field-label">Budget per person</span>
      <div class="chips seg">${chipGroup('budget', o.budgets.map(String), p.budget ? [String(p.budget)] : [], 'radio', (x) => PRICE(+x))}</div>
    </div>
    <div class="field">
      <span class="field-label">Area</span>
      <div class="chips">${chipGroup('area', ['Anywhere', ...o.areas], [p.area || 'Anywhere'], 'radio')}</div>
    </div>
    <div class="field">
      <span class="field-label">Food / activity</span>
      <div class="chips">${chipGroup('kinds', o.kinds, p.kinds || [])}</div>
    </div>
    <div class="field">
      <span class="field-label">When are you free?</span>
      <div class="chips">${chipGroup('availability', o.slots, p.availability || [])}</div>
    </div>
    <button class="btn primary" id="prefs-save" type="submit">${room.me.prefs ? 'Update preferences' : 'Save preferences'}</button>`;
    $('prefs-form').onsubmit = (e) => {
        e.preventDefault();
        const f = new FormData($('prefs-form'));
        const body = {
            ...auth(),
            budget: f.get('budget') ? +f.get('budget') : null,
            area: f.get('area') || 'Anywhere',
            kinds: f.getAll('kinds'),
            availability: f.getAll('availability'),
        };
        act(async () => {
            await post('/prefs', body, 'PUT');
            $('prefs-save').textContent = 'Update preferences';
            const s = $('prefs-saved');
            s.classList.remove('hidden');
            setTimeout(() => s.classList.add('hidden'), 2200);
        }, 'Preferences saved — shortlist updated');
    };
}
function renderSuggest() {
    const o = room.options;
    $('suggest-form').innerHTML = `
    <input id="sg-name" placeholder="Place name" maxlength="60" required>
    <select id="sg-area">${['Anywhere', ...o.areas].map((a) => `<option>${esc(a)}</option>`).join('')}</select>
    <select id="sg-price">${o.budgets.map((b) => `<option value="${b}" ${b === 2 ? 'selected' : ''}>${PRICE(b)}</option>`).join('')}</select>
    <select id="sg-kind">${o.kinds.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
    <button class="btn primary" id="sg-add" type="submit">Add</button>`;
    $('suggest-form').onsubmit = (e) => {
        e.preventDefault();
        const body = {
            ...auth(),
            name: $('sg-name').value,
            area: $('sg-area').value,
            price: +$('sg-price').value,
            kind: $('sg-kind').value,
        };
        act(async () => {
            await post('/venues', body);
            $('sg-name').value = '';
            $('suggest').open = false;
        }, 'Added to shortlist');
    };
}
function setFormsDisabled(disabled) {
    document.querySelectorAll('#prefs-form input, #prefs-form button, #suggest-form input, #suggest-form select, #suggest-form button')
        .forEach((x) => { x.disabled = disabled; });
}
// --- boot --------------------------------------------------------------------
$('join-form').onsubmit = async (e) => {
    e.preventDefault();
    $('join-error').textContent = '';
    $('join-btn').disabled = true;
    try {
        const nameVal = $('join-name').value.trim();
        const r = await post('/join', { name: nameVal });
        me.id = { pid: r.pid, secret: r.secret };
        toast(`Welcome, ${nameVal}! Please share your preferences.`);
        await refresh();
        $('prefs-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    catch (err) {
        $('join-error').textContent = err.message;
    }
    finally {
        $('join-btn').disabled = false;
    }
};
$('share-btn').onclick = async () => {
    const link = location.origin + location.pathname;
    try {
        await navigator.clipboard.writeText(link);
    }
    catch {
        prompt('Copy this link:', link);
        return;
    }
    $('share-btn').textContent = 'Copied!';
    setTimeout(() => {
        $('share-btn').textContent = 'Copy guest link';
    }, 1500);
};
refresh();
window.__poll = setInterval(() => {
    if (!document.hidden && !busy)
        refresh();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden)
        refresh();
});
