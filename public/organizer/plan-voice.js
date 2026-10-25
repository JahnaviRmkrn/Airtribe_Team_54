// Plan a meetup by voice: talk it through with the muop agent (Gemini Live via
// live.js), it creates the meetup with a short summary note, then the organiser
// sends the invite from their OWN WhatsApp / SMS / email (hand-off links - muop
// never sends anything itself).
//
//   PlanByVoice.mount(containerEl, { onCreated(result) })   result = POST /api/me/meetups response
(() => {
  const ACTIVITIES = ['dinner', 'coffee', 'drinks', 'brunch', 'activity'];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SAVE_TOOL = {
    name: 'save_meetup_plan',
    description: 'Create the meetup once the organiser has agreed to the plan. Call exactly once, after reading the plan back and getting a yes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Short title, e.g. "Saturday brunch with the book club"' },
        activity: { type: 'STRING', enum: ACTIVITIES, description: 'Kind of meetup' },
        area: { type: 'STRING', description: 'Neighbourhood or city area, if any (e.g. Indiranagar). Leave empty if they want to meet in the middle.' },
        starts_at: { type: 'STRING', description: 'Start time as ISO 8601 with offset, e.g. 2026-10-31T11:00:00+05:30. Omit if undecided.' },
        budget: { type: 'NUMBER', description: 'Budget per person in INR, if mentioned' },
        invitees: { type: 'ARRAY', items: { type: 'STRING' }, description: 'First names of people they want to invite' },
        summary: { type: 'STRING', description: '2-4 sentence planning note for the organiser: who, what, when, where, budget and anything to remember (dietary needs, purpose, open questions).' },
        share_message: { type: 'STRING', description: 'A short, warm invite the organiser can send to friends (1-2 sentences, no link - the room link is added automatically).' },
      },
      required: ['title', 'activity', 'summary', 'share_message'],
    },
  };

  function instructions() {
    const now = new Date();
    return [
      'You are muop, helping the organiser plan a get-together by voice. Be warm and brief; ask one short question at a time.',
      'Find out: the occasion or a title, the kind of meetup (dinner, coffee, drinks, brunch or an activity), who they want to invite, roughly when, the area (or that they want to meet in the middle of everyone), and a budget per person if they have one.',
      'Do not invent details. If something is undecided, leave it out.',
      'When you have enough, read the plan back in one or two sentences and ask if you should create it. Only after a clear yes, call save_meetup_plan once.',
      'After it is created, tell them the room link and a summary are ready to send on WhatsApp, SMS or email, and that friends will share where they are coming from so muop can suggest a fair place in the middle.',
      `Right now it is ${now.toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })} and the local time zone offset is ${-now.getTimezoneOffset() / 60} hours from UTC (India is +05:30). Convert dates like "this Saturday at 11" to ISO 8601 with that offset.`,
      'Never schedule in the past: if the day they name is today but that time has already passed, use the same day next week, and say the date out loud when you read the plan back.',
    ].join('\n');
  }

  function shareLinks(text, subject) {
    const t = encodeURIComponent(text);
    return {
      whatsapp: 'https://wa.me/?text=' + t,
      sms: 'sms:?&body=' + t, // works on iOS and Android
      email: 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + t,
    };
  }

  function mount(root, { onCreated } = {}) {
    if (!window.LiveVoice) { root.innerHTML = ''; return { stop() {} }; }
    root.innerHTML = `
      <div class="pv">
        <div class="pv-head">
          <button type="button" class="pv-mic" data-pv="mic" aria-label="Plan by voice">🎙️</button>
          <div><strong>Plan it by voice</strong>
            <div class="muted" data-pv="status" aria-live="polite">Tap the mic and tell muop what you have in mind.</div></div>
        </div>
        <div class="pv-log hidden" data-pv="log" aria-live="polite"></div>
        <div class="pv-result hidden" data-pv="result"></div>
        <p class="error" data-pv="err"></p>
      </div>`;
    const $ = (k) => root.querySelector('[data-pv="' + k + '"]');
    const status = (t) => { $('status').textContent = t; };
    const line = (who, text) => {
      const log = $('log');
      log.classList.remove('hidden');
      const d = document.createElement('div');
      d.className = 'pv-line ' + who;
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };
    let session = null;
    let left = false;

    function showResult(created, plan) {
      const m = created.meetup || {};
      const msg = `${plan.share_message || created.invite_text || ''}\n${m.room_url || ''}`.trim();
      const links = shareLinks(msg, m.title || 'Meetup');
      const box = $('result');
      box.classList.remove('hidden');
      box.innerHTML = `
        <h3>${esc(m.title || plan.title)}</h3>
        <p class="pv-note"><span class="muted">Note</span><br>${esc(plan.summary || '')}</p>
        ${(plan.invitees || []).length ? `<p class="muted">Inviting: ${esc(plan.invitees.join(', '))}</p>` : ''}
        <label class="pv-msg-label">Message to send <span class="muted">(edit first if you like)</span>
          <textarea class="pv-msg" rows="3">${esc(msg)}</textarea></label>
        <div class="actions pv-share">
          <a class="button-link" data-share="whatsapp" target="_blank" rel="noopener">WhatsApp</a>
          <a class="button-link" data-share="sms">SMS</a>
          <a class="button-link" data-share="email">Email</a>
          <button type="button" class="pv-copy">Copy</button>
        </div>
        <p class="muted small">Sent from your own phone or email - muop never messages anyone for you.</p>`;
      const ta = box.querySelector('.pv-msg');
      const sync = () => {
        const l = shareLinks(ta.value, m.title || 'Meetup');
        box.querySelectorAll('[data-share]').forEach((a) => { a.href = l[a.dataset.share]; });
      };
      ta.oninput = sync;
      sync();
      box.querySelector('.pv-copy').onclick = async (e) => {
        try { await navigator.clipboard.writeText(ta.value); e.target.textContent = 'Copied!'; } catch { ta.select(); document.execCommand('copy'); e.target.textContent = 'Copied!'; }
        setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
      };
      void links;
    }

    async function save(args) {
      const body = { title: String(args.title || '').slice(0, 120) || 'Meetup', activity: ACTIVITIES.includes(args.activity) ? args.activity : 'dinner' };
      if (args.area) body.area = String(args.area).slice(0, 80);
      if (args.starts_at && !isNaN(Date.parse(args.starts_at))) {
        let t = new Date(args.starts_at);
        // "This Saturday at 11" said on a Saturday evening: roll a just-missed time forward a week.
        if (t < new Date() && Date.now() - t < 7 * 864e5) t = new Date(t.getTime() + 7 * 864e5);
        body.starts_at = t.toISOString();
      }
      if (Number(args.budget) > 0) body.budget = Math.round(Number(args.budget));
      const invitees = Array.isArray(args.invitees) ? args.invitees.map(String).slice(0, 20) : [];
      body.notes = [args.summary, invitees.length ? 'Inviting: ' + invitees.join(', ') : ''].filter(Boolean).join('\n').slice(0, 2000);
      const res = await fetch('/api/me/meetups', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: data.error || ('Could not create the meetup (' + res.status + ')') };
      showResult(data, { ...args, invitees });
      if (onCreated) onCreated(data);
      return { ok: true, room_url: data.meetup && data.meetup.room_url, title: data.meetup && data.meetup.title };
    }

    async function start() {
      $('err').textContent = '';
      try {
        session = await window.LiveVoice.start({
          instructions: instructions(),
          tools: [SAVE_TOOL],
          onToolCall: (name, args) => (name === 'save_meetup_plan' ? save(args) : { error: 'Unknown tool' }),
          onUser: (t) => line('user', t),
          onModel: (t) => line('agent', t),
          onError: (msg) => { $('err').textContent = 'Voice error: ' + msg; },
          onState: (st) => {
            if (left) return;
            $('mic').dataset.state = st;
            if (st === 'connecting') status('Connecting...');
            else if (st === 'listening') status('Listening - what are you planning? Tap the mic again to finish.');
            else if (st === 'speaking') status('muop is speaking...');
            else if (st === 'ended') { session = null; status('Done. Tap the mic to plan another.'); }
          },
        });
      } catch (e) {
        session = null;
        $('err').textContent = e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : (e && e.message) || 'Voice failed - use the form below.';
        status('Use the form below instead.');
      }
    }

    $('mic').onclick = () => (session ? session.stop() : start());
    const leave = () => { left = true; if (session) { session.stop(); session = null; } };
    window.addEventListener('hashchange', leave, { once: true });
    return { stop: leave };
  }

  window.PlanByVoice = { mount };
})();
