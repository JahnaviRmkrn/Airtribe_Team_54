// Moup App - Client Controller (TypeScript)
// Handles routing, auth, real-time onboarding form hydration, contacts, and meetup coordination.

(() => {
interface AppState {
  token: string | null;
  email: string;
  onboarded: boolean;
}

const state: AppState = {
  get token(): string | null {
    return localStorage.getItem('org_token');
  },
  set token(v: string | null) {
    if (v) localStorage.setItem('org_token', v);
    else localStorage.removeItem('org_token');
  },
  get email(): string {
    return localStorage.getItem('org_email') || '';
  },
  set email(v: string) {
    localStorage.setItem('org_email', v);
  },
  get onboarded(): boolean {
    return localStorage.getItem('org_onboarded') === '1';
  },
  set onboarded(v: boolean) {
    localStorage.setItem('org_onboarded', v ? '1' : '0');
  },
};

const CATEGORIES: RelationshipCategory[] = ['Family', 'Friends', 'Work', 'Mentors'];

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
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

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));

function go(hash: string): void {
  location.hash = hash;
}

async function quickLogin(email = 'alex@example.com'): Promise<void> {
  const r = await api<{ token: string; email: string }>('/login', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  state.token = r.token;
  state.email = r.email;
  go(state.onboarded ? '#/dashboard' : '#/onboarding');
}

function route(): void {
  const isAuth = !!state.token;
  const navPub = el('nav-public');
  const navAuth = el('nav-auth');
  if (navPub) navPub.classList.toggle('hidden', isAuth);
  if (navAuth) navAuth.classList.toggle('hidden', !isAuth);

  const hash = location.hash || '#/';

  // Public unauthenticated routes
  if (!isAuth) {
    if (hash === '#/login') return loginView();
    if (hash === '#/onboarding') {
      state.token = 'demo_token';
      state.email = state.email || 'alex@example.com';
      return onboardingView();
    }
    return landingView();
  }

  // Authenticated state machine
  if (!state.onboarded && hash !== '#/onboarding') return go('#/onboarding');
  if (
    state.onboarded &&
    (hash === '#/' ||
      hash === '#/login' ||
      hash === '#/features' ||
      hash === '#/how-it-works')
  ) {
    return go('#/dashboard');
  }

  // Update active state in nav
  ['#nav-dash', '#nav-contacts', '#nav-meetups'].forEach((sel) => {
    const a = el(sel.replace('#', ''));
    if (a) a.classList.toggle('active', a.getAttribute('href') === hash);
  });

  const views: Record<string, () => void> = {
    '#/onboarding': onboardingView,
    '#/dashboard': dashboardView,
    '#/contacts': contactsView,
    '#/meetups': meetupsView,
  };
  (views[hash] || dashboardView)();
}

// --- landing page ----------------------------------------------------

function landingView(): void {
  el('app').className = 'container wide';
  el('app').innerHTML = `
    <section class="landing-hero">
      <span class="pill accent">⚡ AI Builders Day · Team 54</span>
      <h1>Stay close to the people who actually matter.</h1>
      <p class="lead">Moup is your personal relationship manager powered by natural AI voice calibration and frictionless collaborative meetup rooms.</p>
      <div class="landing-cta-row">
        <button class="primary" id="hero-demo-btn">Try Interactive Demo</button>
        <button class="ghost" id="hero-signin-btn">Sign In</button>
        <a href="#/how-it-works" class="btn ghost">How it works ↓</a>
      </div>
    </section>

    <section class="showcase-card" id="how-it-works">
      <div>
        <span class="pill accent">🎙️ Voice Calibrated</span>
        <h2 style="margin-top:10px;">Setup at the speed of natural conversation</h2>
        <p class="muted">Speak naturally with our Conversational AI agent for 30 seconds. Share who matters to you, and your inner circle populates automatically in real-time.</p>
        <p class="muted"><strong>100% Consent Guarantee:</strong> Extraction is completely stateless. Nothing is saved to your account until you verify and click confirm.</p>
        <button class="primary sm" id="showcase-try-btn" style="margin-top:10px;">Try Voice Setup</button>
      </div>
      <div class="showcase-preview">
        <div class="preview-bubble agent">
          "Good day. Who are a few people you would like to prioritize staying close to?"
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

    <section class="showcase-card rev">
      <div class="showcase-preview">
        <div class="room-preview-box">
          <div class="row spread" style="padding:0;">
            <strong>Coffee & Catch-up</strong>
            <span class="pill">2 / 3 voted</span>
          </div>
          <div class="muted" style="margin: 8px 0 12px; font-size:13px;">📍 Third Wave Coffee, Indiranagar · Sat 4:00 PM</div>
          <div class="row spread" style="padding:0;">
            <span>Priya: ₹300-500 · Indiranagar</span>
            <span class="tag">Available Sat</span>
          </div>
        </div>
      </div>
      <div>
        <span class="pill accent">👥 Zero-Friction Rooms</span>
        <h2 style="margin-top:10px;">Stop the 40-message group chat debate</h2>
        <p class="muted">Send your friends a single link at <code>/m/&lt;token&gt;</code>. They input their budget, area, and free slots with no login required. Moup tallies the consensus automatically.</p>
      </div>
    </section>

    <section class="card" style="text-align:center; padding: 40px 20px; margin-top:20px;">
      <h2>Ready to organize your inner circle?</h2>
      <p class="muted" style="max-width:540px; margin: 8px auto 20px;">Experience how fast staying in touch becomes when voice AI handles network calibration.</p>
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

function loginView(): void {
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

  el<HTMLFormElement>('login-form').onsubmit = async (e) => {
    e.preventDefault();
    await quickLogin(el<HTMLInputElement>('login-email').value);
  };
  el('login-quick-demo').onclick = () => quickLogin('demo@team54.app');
}

// --- onboarding: editable confirm screen + text fallback -------------

function onboardingView(): void {
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

  const inputs = [...document.querySelectorAll<HTMLInputElement>('.goal-input')];
  const total = () => inputs.reduce((s, i) => s + (parseInt(i.value) || 0), 0);
  const refresh = () => {
    el('goals-total').textContent = String(total());
  };
  inputs.forEach((i) => {
    i.oninput = refresh;
  });

  el('goals-apply').onclick = () => {
    const area = el<HTMLTextAreaElement>('goals-text');
    area.value.split(',').forEach((part) => {
      const m = part.trim().match(/^(.+?)\s+(\d+)$/);
      if (m) {
        const inp = inputs.find((i) => i.dataset.cat?.toLowerCase() === m[1].trim().toLowerCase());
        if (inp) inp.value = m[2];
      }
    });
    refresh();
  };

  const renderExtracted = (contacts: Contact[]) => {
    el('ob-contacts-wrap').classList.toggle('hidden', !contacts.length);
    el('ob-contacts').innerHTML = contacts
      .map(
        (c) => `
      <div class="ob-contact">
        <input class="ob-c-name" value="${esc(c.name)}" aria-label="Name">
        <select class="ob-c-cat" aria-label="Category">${CATEGORIES.map((x) => `<option ${x === c.category ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input class="ob-c-notes ob-notes" value="${esc(c.notes || '')}" placeholder="Notes" aria-label="Notes">
        <button type="button" class="danger ob-c-del" aria-label="Remove ${esc(c.name)}">Remove</button>
      </div>`
      )
      .join('');

    el('ob-contacts')
      .querySelectorAll('.ob-c-del')
      .forEach((b) => {
        (b as HTMLElement).onclick = () => {
          b.closest('.ob-contact')?.remove();
          if (!el('ob-contacts').children.length) el('ob-contacts-wrap').classList.add('hidden');
        };
      });
  };

  if (window.Voice) {
    window.Voice.mount(el('voice-mount'), (res: ExtractResult) => {
      if (res.name && el('ob-name')) {
        el<HTMLInputElement>('ob-name').value = res.name;
      }
      if (res.goals) {
        inputs.forEach((i) => {
          const cat = i.dataset.cat as RelationshipCategory;
          if (res.goals[cat] !== undefined) i.value = String(res.goals[cat]);
        });
        refresh();
      }
      el('ob-source').textContent = res.source === 'rules' ? 'live voice' : 'voice AI';
      if (res.contacts && res.contacts.length) {
        renderExtracted(res.contacts);
      }
      if (res.action === 'confirm') {
        const btn = el('ob-save');
        btn.scrollIntoView({ behavior: 'smooth' });
        if (total() === 100) {
          btn.click();
        } else {
          el('ob-error').textContent = 'Please make sure goals total 100% before confirming.';
        }
      }
    });
  }

  el('ob-save').onclick = async () => {
    if (total() !== 100) {
      el('ob-error').textContent = 'Goals must total 100% - currently ' + total() + '%.';
      return;
    }
    const goals = Object.fromEntries(
      inputs.map((i) => [i.dataset.cat, parseInt(i.value) || 0])
    ) as AttentionGoals;

    await api('/goals', { method: 'PUT', body: JSON.stringify({ goals }) });
    const rows = [...document.querySelectorAll('.ob-contact')]
      .map((r) => ({
        name: (r.querySelector('.ob-c-name') as HTMLInputElement).value.trim(),
        category: (r.querySelector('.ob-c-cat') as HTMLSelectElement).value as RelationshipCategory,
        notes: (r.querySelector('.ob-c-notes') as HTMLInputElement).value.trim(),
      }))
      .filter((c) => c.name);

    for (const c of rows) await api('/contacts', { method: 'POST', body: JSON.stringify(c) });
    state.onboarded = true;
    go('#/dashboard');
  };
}

// --- dashboard ----------------------------------------------------------

async function dashboardView(): Promise<void> {
  el('app').className = 'container';
  const s = await api<any>('/summary');
  const contacts = await api<Contact[]>('/contacts');
  const nameOf = (id: string) => contacts.find((c) => c.id === id)?.name || 'Someone';

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
      ${
        s.open_followups.length
          ? s.open_followups
              .map(
                (f: any) => `
        <div class="row">
          <div><strong>${esc(nameOf(f.contact_id))}</strong> - due ${esc(f.due)}
            ${f.note ? `<div class="muted">${esc(f.note)}</div>` : ''}</div>
          <button data-done="${f.id}">Mark done</button>
        </div>`
              )
              .join('')
          : '<p class="muted">No open follow-ups.</p>'
      }
    </section>
    <section class="card">
      <h2>Upcoming meetups</h2>
      ${
        s.upcoming_meetups.length
          ? s.upcoming_meetups
              .map(
                (m: any) => `
        <div class="row">
          <div><strong>${esc(m.title)}</strong> - ${esc(m.when)}
            <div class="muted mono">${esc(m.room_link)}</div></div>
          <button data-copy="${esc(m.room_link)}">Copy link</button>
        </div>`
              )
              .join('')
          : '<p class="muted">No meetups planned.</p>'
      }
    </section>`;

  el('qa-add').onclick = () => {
    sessionStorage.setItem('org_new_contact', '1');
    go('#/contacts');
  };
  el('qa-meetup').onclick = () => go('#/meetups');
  document.querySelectorAll('[data-copy]').forEach((b) => {
    (b as HTMLElement).onclick = () => copyLink((b as HTMLElement).dataset.copy!, b as HTMLElement);
  });
  document.querySelectorAll('[data-done]').forEach((b) => {
    (b as HTMLElement).onclick = () => markDone((b as HTMLElement).dataset.done!);
  });
}

function copyLink(text: string, btn: HTMLElement): void {
  const done = () => {
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = 'Copy link';
    }, 1500);
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

async function markDone(fid: string): Promise<void> {
  const note = prompt('Add a note for this follow-up (optional):') || '';
  await api('/followups/' + fid + '/done', { method: 'POST', body: JSON.stringify({ note }) });
  dashboardView();
}

// --- contacts ---------------------------------------------------------

async function contactsView(): Promise<void> {
  el('app').className = 'container';
  const filter = sessionStorage.getItem('org_filter') || '';
  const contacts = await api<Contact[]>(
    '/contacts' + (filter ? '?category=' + encodeURIComponent(filter) : '')
  );

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
      ${
        contacts.length
          ? contacts
              .map(
                (c) => `
        <div class="row" data-cid="${c.id}">
          <div><strong>${esc(c.name)}</strong> <span class="tag">${esc(c.category)}</span>
            ${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ''}</div>
          <div>
            <button data-edit="${c.id}">Edit</button>
            <button class="danger" data-del="${c.id}">Delete</button>
          </div>
        </div>`
              )
              .join('')
          : '<p class="muted">No contacts yet.</p>'
      }
    </section>`;

  el<HTMLSelectElement>('filter').onchange = () => {
    sessionStorage.setItem('org_filter', el<HTMLSelectElement>('filter').value);
    contactsView();
  };
  el<HTMLFormElement>('add-form').onsubmit = async (e) => {
    e.preventDefault();
    await api('/contacts', {
      method: 'POST',
      body: JSON.stringify({
        name: el<HTMLInputElement>('c-name').value,
        category: el<HTMLSelectElement>('c-cat').value,
        notes: el<HTMLInputElement>('c-notes').value,
      }),
    });
    contactsView();
  };
  document.querySelectorAll('[data-del]').forEach((b) => {
    (b as HTMLElement).onclick = async () => {
      if (confirm('Delete this contact?')) {
        await api('/contacts/' + (b as HTMLElement).dataset.del, { method: 'DELETE' });
        contactsView();
      }
    };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => {
    (b as HTMLElement).onclick = () => {
      const cid = (b as HTMLElement).dataset.edit!;
      editRow(cid, contacts.find((c) => c.id === cid)!);
    };
  });
  if (sessionStorage.getItem('org_new_contact')) {
    sessionStorage.removeItem('org_new_contact');
    el('c-name').focus();
  }
}

function editRow(cid: string, c: Contact): void {
  const row = document.querySelector('[data-cid="' + cid + '"]') as HTMLElement;
  row.innerHTML = `
    <div class="inline-form">
      <input id="e-name" value="${esc(c.name)}">
      <select id="e-cat">${CATEGORIES.map((x) => `<option ${x === c.category ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <input id="e-notes" value="${esc(c.notes || '')}">
    </div>
    <div>
      <button class="primary" id="e-save">Save</button>
      <button id="e-cancel">Cancel</button>
    </div>`;
  el('e-cancel').onclick = () => contactsView();
  el('e-save').onclick = async () => {
    await api('/contacts/' + cid, {
      method: 'PUT',
      body: JSON.stringify({
        name: el<HTMLInputElement>('e-name').value,
        category: el<HTMLSelectElement>('e-cat').value,
        notes: el<HTMLInputElement>('e-notes').value,
      }),
    });
    contactsView();
  };
}

// --- meetups -----------------------------------------------------------

async function meetupsView(): Promise<void> {
  el('app').className = 'container';
  const [meetups, contacts] = await Promise.all([
    api<any[]>('/meetups'),
    api<Contact[]>('/contacts'),
  ]);

  el('app').innerHTML = `
    <h1>Meetups</h1>
    <section class="card">
      <h2>Plan a meetup</h2>
      <form id="m-form">
        <label>Title <input id="m-title" required placeholder="Coffee catch-up"></label>
        <label>When <input id="m-when" type="datetime-local" required></label>
        <fieldset>
          <legend>Who is invited</legend>
          ${
            contacts.length
              ? contacts
                  .map(
                    (c) => `<label class="check"><input type="checkbox" value="${c.id}"> ${esc(c.name)}</label>`
                  )
                  .join('')
              : '<p class="muted">Add contacts first.</p>'
          }
        </fieldset>
        <button class="primary" type="submit">Create meetup</button>
      </form>
    </section>
    <section class="card">
      <h2>Planned</h2>
      ${
        meetups.length
          ? meetups
              .map(
                (m) => `
        <div class="row">
          <div><strong>${esc(m.title)}</strong> - ${esc(m.when)}${m.venue ? ` · 📍 ${esc(m.venue)}` : ''}
            <div class="muted mono">${esc(m.room_link)}</div></div>
          <div>
            <button data-copy="${esc(m.room_link)}">Copy link</button>
            ${
              m.organizer_link
                ? `<a href="${esc(m.organizer_link)}" target="_blank" rel="noopener"><button type="button">Open room</button></a>`
                : ''
            }
          </div>
        </div>`
              )
              .join('')
          : '<p class="muted">No meetups yet.</p>'
      }
    </section>`;

  el<HTMLFormElement>('m-form').onsubmit = async (e) => {
    e.preventDefault();
    const ids = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map(
      (i) => i.value
    );
    await api('/meetups', {
      method: 'POST',
      body: JSON.stringify({
        title: el<HTMLInputElement>('m-title').value,
        when: el<HTMLInputElement>('m-when').value,
        contact_ids: ids,
      }),
    });
    meetupsView();
  };
  document.querySelectorAll('[data-copy]').forEach((b) => {
    (b as HTMLElement).onclick = () => copyLink((b as HTMLElement).dataset.copy!, b as HTMLElement);
  });
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
})();

