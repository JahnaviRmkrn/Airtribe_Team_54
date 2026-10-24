// Moup app - Team 54, AI Builders Day.
// Talks only to /api/* (mocked by routers/api.py until Person A's API is ready).
// Nothing is ever sent automatically - every action is an explicit button.

const state = {
  get token() { return localStorage.getItem('org_token'); },
  set token(v) { v ? localStorage.setItem('org_token', v) : localStorage.removeItem('org_token'); },
  get email() { return localStorage.getItem('org_email') || ''; },
  set email(v) { localStorage.setItem('org_email', v); },
  get onboarded() { return localStorage.getItem('org_onboarded') === '1'; },
  set onboarded(v) { localStorage.setItem('org_onboarded', v ? '1' : '0'); },
};

const CATEGORIES = ['Family', 'Friends', 'Work', 'Mentors'];

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

function go(hash) { location.hash = hash; }

async function quickLogin(email = 'alex@example.com') {
  const r = await api('/login', { method: 'POST', body: JSON.stringify({ email }) });
  state.token = r.token;
  state.email = r.email;
  go(state.onboarded ? '#/dashboard' : '#/onboarding');
}

function route() {
  const isAuth = !!state.token;
  const navPub = el('nav-public');
  const navAuth = el('nav-auth');
  if (navPub) navPub.classList.toggle('hidden', isAuth);
  if (navAuth) navAuth.classList.toggle('hidden', !isAuth);

  const hash = location.hash || '#/';

  // Public unauthenticated routes
  if (!isAuth) {
    if (hash === '#/login') return loginView();
    return landingView();
  }

  // Authenticated state machine
  if (!state.onboarded && hash !== '#/onboarding') return go('#/onboarding');
  if (state.onboarded && (hash === '#/' || hash === '#/login' || hash === '#/onboarding' || hash === '#/features' || hash === '#/how-it-works')) {
    return go('#/dashboard');
  }

  // Update active state in nav
  ['#nav-dash', '#nav-contacts', '#nav-meetups'].forEach((sel) => {
    const a = el(sel.replace('#', ''));
    if (a) a.classList.toggle('active', a.getAttribute('href') === hash);
  });

  const views = {
    '#/onboarding': onboardingView,
    '#/dashboard': dashboardView,
    '#/contacts': contactsView,
    '#/meetups': meetupsView,
  };
  (views[hash] || dashboardView)();
}

// --- landing page ----------------------------------------------------

function landingView() {
  el('app').className = 'container wide';
  el('app').innerHTML = `
    <section class="landing-hero">
      <span class="pill accent">⚡ AI Builders Day · Team 54</span>
      <h1>Stay close to the people who actually matter.</h1>
      <p class="lead">Moup is the personal relationship organizer powered by 30-second AI voice check-ins and frictionless collaborative meetup rooms.</p>
      <div class="landing-cta-row">
        <button class="primary" id="hero-demo-btn">Try Interactive Demo</button>
        <button class="ghost" id="hero-signin-btn">Sign In</button>
        <a href="#/how-it-works" class="btn ghost">How it works ↓</a>
      </div>
    </section>

    <section class="showcase-card" id="how-it-works">
      <div>
        <span class="pill accent">🎙️ Voice Calibrated</span>
        <h2 style="margin-top:10px;">Onboarding at the speed of speech</h2>
        <p class="muted">No tedious form filling. Tap the glowing mic, speak naturally with our ElevenLabs Conversational AI agent for 30 seconds, and watch your inner circle populate in real-time.</p>
        <p class="muted"><strong>100% Consent Guarantee:</strong> Extraction is completely stateless. Nothing is saved to your account until you verify and click confirm.</p>
        <button class="primary sm" id="showcase-try-btn" style="margin-top:10px;">Try Voice Setup</button>
      </div>
      <div class="showcase-preview">
        <div class="preview-bubble agent">
          "Hi! Who are a few people you'd like to stay closer to this month?"
        </div>
        <div class="preview-bubble user">
          "My sister Priya in Pune, Arjun my college roommate, and Meera my engineering mentor."
        </div>
        <div class="row spread" style="margin-top:14px; padding:0;">
          <span class="tag">Priya · Family</span>
          <span class="tag">Arjun · Friends</span>
          <span class="tag">Meera · Mentors</span>
        </div>
      </div>
    </section>

    <div class="features-grid" id="features">
      <div class="feature-card">
        <div class="feature-icon">🎙️</div>
        <h3>ElevenLabs Voice Agent</h3>
        <p class="muted">Natural spoken dialogue powered by WebSocket streaming. Drop your thoughts in speech, and AI extracts contacts and attention splits effortlessly.</p>
      </div>

      <div class="feature-card">
        <div class="feature-icon">🤝</div>
        <h3>Collaborative Meetup Rooms</h3>
        <p class="muted">Create an <code>/m/&lt;token&gt;</code> room with 1 tap. Friends join without passwords, declare budget &amp; availability, and vote on ranked venue shortlists.</p>
      </div>

      <div class="feature-card">
        <div class="feature-icon">🎯</div>
        <h3>100% Attention Balance</h3>
        <p class="muted">Proactively divide your focus across Family, Friends, Work, and Mentors so you never let life's most valuable bonds fade into the background.</p>
      </div>
    </div>

    <section class="card" style="text-align:center; padding: 40px 20px;">
      <h2>Ready to organize your inner circle?</h2>
      <p class="muted">Zero setup required. Try the complete demo right in your browser.</p>
      <button class="primary" id="footer-demo-btn" style="margin-top:12px;">Launch Demo Workspace</button>
    </section>

    <footer class="landing-footer">
      <p>Built with ❤️ by Team 54 for AI Builders Day · Voice, Meetups, and Relational CRM</p>
    </footer>`;

  el('hero-demo-btn').onclick = () => quickLogin('demo@team54.app');
  el('hero-signin-btn').onclick = () => go('#/login');
  el('showcase-try-btn').onclick = () => quickLogin('alex@team54.app');
  el('footer-demo-btn').onclick = () => quickLogin('demo@team54.app');
}

// --- login -----------------------------------------------------------

function loginView() {
  el('app').className = 'container';
  el('app').innerHTML = `
    <section class="card narrow">
      <h1>Sign in</h1>
      <p class="muted">Enter your email to sign in or access your workspace.</p>
      <form id="login-form">
        <label>Email
          <input type="email" id="login-email" required placeholder="you@example.com" value="alex@example.com">
        </label>
        <button class="primary" type="submit" style="width:100%; margin-top:8px;">Continue</button>
      </form>
      <div style="text-align:center; margin: 18px 0; position:relative;">
        <span class="muted" style="background:var(--panel-solid); padding: 0 10px; position:relative; z-index:1;">or</span>
        <div style="position:absolute; top:50%; left:0; right:0; height:1px; background:var(--line);"></div>
      </div>
      <button class="btn ghost" id="login-quick-demo" type="button" style="width:100%;">⚡ One-Click Instant Demo</button>
      <p class="muted" style="text-align:center; margin-top:14px;">Demo mode enabled — no password needed.</p>
    </section>`;

  el('login-form').onsubmit = async (e) => {
    e.preventDefault();
    await quickLogin(el('login-email').value);
  };
  el('login-quick-demo').onclick = () => quickLogin('demo@team54.app');
}

// --- onboarding: editable confirm screen + text fallback -------------

function onboardingView() {
  el('app').className = 'container';
  const name = state.email.split('@')[0] || '';
  el('app').innerHTML = `
    <section class="card">
      <h1>Confirm your details</h1>
      <p class="muted">Check and edit anything before continuing.</p>
      <div id="voice-mount"></div>
      <label>Name <input id="ob-name" value="${esc(name)}"></label>
      <label>Email <input id="ob-email" value="${esc(state.email)}" readonly></label>
      <div id="ob-contacts-wrap" class="hidden">
        <h2>People we heard <span class="ob-pill" id="ob-source"></span></h2>
        <p class="muted">Edit or remove anyone. Nothing is saved until you confirm.</p>
        <div id="ob-contacts" class="ob-contacts"></div>
      </div>
      <h2>Attention goals</h2>
      <p class="muted">How do you want to split your attention? Must total 100%.</p>
      <div class="goals-grid">
        ${CATEGORIES.map((c) => `<label>${c} <input type="number" class="goal-input" data-cat="${c}" min="0" max="100" value="25"></label>`).join('')}
      </div>
      <p>Total: <strong id="goals-total">100</strong>%</p>
      <details>
        <summary>Prefer typing? Use the text fallback</summary>
        <textarea id="goals-text" rows="3" placeholder="Family 40, Friends 30, Work 20, Mentors 10"></textarea>
        <button id="goals-apply" type="button">Apply text</button>
      </details>
      <p id="ob-error" class="error"></p>
      <button id="ob-save" class="primary">Confirm &amp; continue</button>
    </section>`;
  const inputs = [...document.querySelectorAll('.goal-input')];
  const total = () => inputs.reduce((s, i) => s + (parseInt(i.value) || 0), 0);
  const refresh = () => { el('goals-total').textContent = total(); };
  inputs.forEach((i) => { i.oninput = refresh; });
  el('goals-apply').onclick = () => {
    el('goals-text').value.split(',').forEach((part) => {
      const m = part.trim().match(/^(.+?)\s+(\d+)$/);
      if (m) {
        const inp = inputs.find((i) => i.dataset.cat.toLowerCase() === m[1].trim().toLowerCase());
        if (inp) inp.value = m[2];
      }
    });
    refresh();
  };
  // Voice / typed extraction -> pre-fill only. Saved solely by the confirm button below.
  const renderExtracted = (contacts) => {
    el('ob-contacts-wrap').classList.toggle('hidden', !contacts.length);
    el('ob-contacts').innerHTML = contacts.map((c) => `
      <div class="ob-contact">
        <input class="ob-c-name" value="${esc(c.name)}" aria-label="Name">
        <select class="ob-c-cat" aria-label="Category">${CATEGORIES.map((x) => `<option ${x === c.category ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input class="ob-c-notes ob-notes" value="${esc(c.notes)}" placeholder="Notes" aria-label="Notes">
        <button type="button" class="danger ob-c-del" aria-label="Remove ${esc(c.name)}">Remove</button>
      </div>`).join('');
    el('ob-contacts').querySelectorAll('.ob-c-del').forEach((b) => {
      b.onclick = () => {
        b.closest('.ob-contact').remove();
        if (!el('ob-contacts').children.length) el('ob-contacts-wrap').classList.add('hidden');
      };
    });
  };
  if (window.Voice) {
    window.Voice.mount(el('voice-mount'), (res) => {
      inputs.forEach((i) => { i.value = res.goals[i.dataset.cat] ?? 0; });
      refresh();
      el('ob-source').textContent = res.source === 'rules' ? 'auto-detected' : 'from voice';
      renderExtracted(res.contacts);
    });
  }
  el('ob-save').onclick = async () => {
    if (total() !== 100) {
      el('ob-error').textContent = 'Goals must total 100% - currently ' + total() + '%.';
      return;
    }
    const goals = Object.fromEntries(inputs.map((i) => [i.dataset.cat, parseInt(i.value) || 0]));
    await api('/goals', { method: 'PUT', body: JSON.stringify({ goals }) });
    const rows = [...document.querySelectorAll('.ob-contact')]
      .map((r) => ({ name: r.querySelector('.ob-c-name').value.trim(), category: r.querySelector('.ob-c-cat').value, notes: r.querySelector('.ob-c-notes').value.trim() }))
      .filter((c) => c.name);
    for (const c of rows) await api('/contacts', { method: 'POST', body: JSON.stringify(c) });
    state.onboarded = true;
    go('#/dashboard');
  };
}

// --- dashboard ----------------------------------------------------------

async function dashboardView() {
  el('app').className = 'container';
  const s = await api('/summary');
  const contacts = await api('/contacts');
  const nameOf = (id) => (contacts.find((c) => c.id === id) || {}).name || 'Someone';
  el('app').innerHTML = `
    <h1>Dashboard</h1>
    <div class="stats">
      <div class="stat card">
        <div class="stat-num">${s.contact_count}</div>
        <div class="stat-label">Contacts</div>
        <div class="muted">people you know</div>
      </div>
      <div class="stat card">
        <div class="stat-num">${s.activity_count}</div>
        <div class="stat-label">Recorded activity</div>
        <div class="muted">things that happened</div>
      </div>
    </div>
    <div class="quick-actions">
      <button class="primary" id="qa-add">Add person</button>
      <button class="primary" id="qa-meetup">Plan a meetup</button>
    </div>
    <section class="card">
      <h2>Follow-ups</h2>
      ${s.open_followups.length ? s.open_followups.map((f) => `
        <div class="row">
          <div><strong>${esc(nameOf(f.contact_id))}</strong> - due ${esc(f.due)}
            ${f.note ? `<div class="muted">${esc(f.note)}</div>` : ''}</div>
          <button data-done="${f.id}">Mark done</button>
        </div>`).join('') : '<p class="muted">No open follow-ups.</p>'}
    </section>
    <section class="card">
      <h2>Upcoming meetups</h2>
      ${s.upcoming_meetups.length ? s.upcoming_meetups.map((m) => `
        <div class="row">
          <div><strong>${esc(m.title)}</strong> - ${esc(m.when)}
            <div class="muted mono">${esc(m.room_link)}</div></div>
          <button data-copy="${esc(m.room_link)}">Copy link</button>
        </div>`).join('') : '<p class="muted">No meetups planned.</p>'}
    </section>`;
  el('qa-add').onclick = () => { sessionStorage.setItem('org_new_contact', '1'); go('#/contacts'); };
  el('qa-meetup').onclick = () => go('#/meetups');
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyLink(b.dataset.copy, b); });
  document.querySelectorAll('[data-done]').forEach((b) => { b.onclick = () => markDone(b.dataset.done); });
}

function copyLink(text, btn) {
  const done = () => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
  };
  if (navigator.clipboard) {
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

async function markDone(fid) {
  const note = prompt('Add a note for this follow-up (optional):') || '';
  await api('/followups/' + fid + '/done', { method: 'POST', body: JSON.stringify({ note }) });
  dashboardView();
}

// --- contacts ---------------------------------------------------------

async function contactsView() {
  el('app').className = 'container';
  const filter = sessionStorage.getItem('org_filter') || '';
  const contacts = await api('/contacts' + (filter ? '?category=' + encodeURIComponent(filter) : ''));
  el('app').innerHTML = `
    <h1>Contacts</h1>
    <section class="card">
      <h2>Add person</h2>
      <form id="add-form" class="inline-form">
        <input id="c-name" placeholder="Name" required>
        <select id="c-cat">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select>
        <input id="c-notes" placeholder="Notes">
        <button class="primary" type="submit">Add</button>
      </form>
    </section>
    <section class="card">
      <div class="row spread">
        <h2>Your people</h2>
        <select id="filter">
          <option value="">All categories</option>
          ${CATEGORIES.map((c) => `<option ${c === filter ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      ${contacts.length ? contacts.map((c) => `
        <div class="row" data-cid="${c.id}">
          <div><strong>${esc(c.name)}</strong> <span class="tag">${esc(c.category)}</span>
            ${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ''}</div>
          <div>
            <button data-edit="${c.id}">Edit</button>
            <button class="danger" data-del="${c.id}">Delete</button>
          </div>
        </div>`).join('') : '<p class="muted">No contacts yet.</p>'}
    </section>`;
  el('filter').onchange = () => { sessionStorage.setItem('org_filter', el('filter').value); contactsView(); };
  el('add-form').onsubmit = async (e) => {
    e.preventDefault();
    await api('/contacts', { method: 'POST', body: JSON.stringify({ name: el('c-name').value, category: el('c-cat').value, notes: el('c-notes').value }) });
    contactsView();
  };
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (confirm('Delete this contact?')) {
        await api('/contacts/' + b.dataset.del, { method: 'DELETE' });
        contactsView();
      }
    };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => editRow(b.dataset.edit, contacts.find((c) => c.id === b.dataset.edit));
  });
  if (sessionStorage.getItem('org_new_contact')) {
    sessionStorage.removeItem('org_new_contact');
    el('c-name').focus();
  }
}

function editRow(cid, c) {
  const row = document.querySelector('[data-cid="' + cid + '"]');
  row.innerHTML = `
    <div class="inline-form">
      <input id="e-name" value="${esc(c.name)}">
      <select id="e-cat">${CATEGORIES.map((x) => `<option ${x === c.category ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <input id="e-notes" value="${esc(c.notes)}">
    </div>
    <div>
      <button class="primary" id="e-save">Save</button>
      <button id="e-cancel">Cancel</button>
    </div>`;
  el('e-cancel').onclick = () => contactsView();
  el('e-save').onclick = async () => {
    await api('/contacts/' + cid, { method: 'PUT', body: JSON.stringify({ name: el('e-name').value, category: el('e-cat').value, notes: el('e-notes').value }) });
    contactsView();
  };
}

// --- meetups -----------------------------------------------------------

async function meetupsView() {
  el('app').className = 'container';
  const results = await Promise.all([api('/meetups'), api('/contacts')]);
  const meetups = results[0];
  const contacts = results[1];
  el('app').innerHTML = `
    <h1>Meetups</h1>
    <section class="card">
      <h2>Plan a meetup</h2>
      <form id="m-form">
        <label>Title <input id="m-title" required placeholder="Coffee catch-up"></label>
        <label>When <input id="m-when" type="datetime-local" required></label>
        <fieldset>
          <legend>Who is invited</legend>
          ${contacts.length ? contacts.map((c) => `<label class="check"><input type="checkbox" value="${c.id}"> ${esc(c.name)}</label>`).join('') : '<p class="muted">Add contacts first.</p>'}
        </fieldset>
        <button class="primary" type="submit">Create meetup</button>
      </form>
    </section>
    <section class="card">
      <h2>Planned</h2>
      ${meetups.length ? meetups.map((m) => `
        <div class="row">
          <div><strong>${esc(m.title)}</strong> - ${esc(m.when)}${m.venue ? ` · 📍 ${esc(m.venue)}` : ''}
            <div class="muted mono">${esc(m.room_link)}</div></div>
          <div>
            <button data-copy="${esc(m.room_link)}">Copy link</button>
            ${m.organizer_link ? `<a href="${esc(m.organizer_link)}" target="_blank" rel="noopener"><button type="button">Open room</button></a>` : ''}
          </div>
        </div>`).join('') : '<p class="muted">No meetups yet.</p>'}
    </section>`;
  el('m-form').onsubmit = async (e) => {
    e.preventDefault();
    const ids = [...document.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    await api('/meetups', { method: 'POST', body: JSON.stringify({ title: el('m-title').value, when: el('m-when').value, contact_ids: ids }) });
    meetupsView();
  };
  document.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => copyLink(b.dataset.copy, b); });
}

// --- boot ---------------------------------------------------------------

if (el('top-demo-btn')) {
  el('top-demo-btn').onclick = () => quickLogin('demo@team54.app');
}
if (el('logout')) {
  el('logout').onclick = () => {
    state.token = null;
    state.onboarded = false;
    go('#/');
  };
}
window.onhashchange = route;
route();
