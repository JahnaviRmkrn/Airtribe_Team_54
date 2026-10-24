// Voice onboarding widget (ElevenLabs Conversational AI).
// Usage: Voice.mount(containerEl, (result) => { ... })
//   result = { contacts: [{name, category, notes}] (<=5), goals: {Family..Mentors}, source }
// Nothing is saved here - the caller shows result on the confirm screen and
// only the user's explicit confirm persists it.

(() => {
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client/+esm';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || r.statusText);
    return d;
  }

  function mount(root, onResult) {
    const lines = []; // {who: 'user'|'agent', text}
    let convo = null;
    let extracting = false;

    root.innerHTML = `
      <div class="vx">
        <div class="vx-head">
          <button class="vx-orb" id="vx-orb" type="button" aria-label="Start voice setup">
            <span class="vx-ring"></span><span class="vx-ring r2"></span>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>
          </button>
          <div>
            <div class="vx-title">Set up by talking</div>
            <div class="vx-status" id="vx-status">Checking voice…</div>
          </div>
          <button class="vx-end hidden" id="vx-end" type="button">Done talking</button>
        </div>
        <div class="vx-log hidden" id="vx-log" aria-live="polite"></div>
        <details class="vx-fallback" id="vx-fallback">
          <summary>Prefer typing? Describe your people instead</summary>
          <textarea id="vx-text" rows="4" placeholder="e.g. I want to call my sister Priya more, catch up with my friend Arjun, and my mentor Meera. Family 40%, friends 30%, work 20%, mentors 10%."></textarea>
          <button type="button" id="vx-extract">Extract</button>
        </details>
        <p class="vx-err" id="vx-err"></p>
      </div>`;

    const $ = (id) => root.querySelector('#' + id);
    const status = (t) => { $('vx-status').textContent = t; };
    const setMode = (m) => { root.querySelector('.vx').dataset.mode = m; };

    function addLine(who, text) {
      if (!text) return;
      lines.push({ who, text });
      const log = $('vx-log');
      log.classList.remove('hidden');
      log.insertAdjacentHTML('beforeend', `<div class="vx-msg ${who}"><span>${esc(text)}</span></div>`);
      log.scrollTop = log.scrollHeight;
    }

    async function extract(transcript) {
      if (extracting || !transcript.trim()) return;
      extracting = true;
      $('vx-err').textContent = '';
      status('Pulling out your people and goals…');
      setMode('thinking');
      try {
        const res = await getJSON('/api/extract', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript }),
        });
        status(`Found ${res.contacts.length} ${res.contacts.length === 1 ? 'person' : 'people'} - review below, nothing is saved yet.`);
        setMode('done');
        onResult(res);
      } catch (e) {
        $('vx-err').textContent = 'Could not extract: ' + e.message;
        status('Try again, or type it instead.');
        setMode('idle');
      } finally {
        extracting = false;
      }
    }

    const transcriptText = () => lines.map((l) => `${l.who === 'user' ? 'User' : 'Agent'}: ${l.text}`).join('\n');

    async function start() {
      $('vx-err').textContent = '';
      try {
        status('Asking for your microphone…');
        await navigator.mediaDevices.getUserMedia({ audio: true });
        status('Connecting…');
        setMode('connecting');
        const [{ Conversation }, cfg] = await Promise.all([import(SDK_URL), getJSON('/api/voice/config')]);
        const session = cfg.mode === 'signed'
          ? { signedUrl: (await getJSON('/api/voice/signed-url')).signed_url }
          : { agentId: cfg.agent_id };
        convo = await Conversation.startSession({
          ...session,
          onConnect: () => { status('Listening - tell me about the people who matter.'); setMode('live'); $('vx-end').classList.remove('hidden'); },
          onDisconnect: () => {
            convo = null;
            $('vx-end').classList.add('hidden');
            if (lines.some((l) => l.who === 'user')) extract(transcriptText());
            else { status('Call ended. Tap the mic to try again.'); setMode('idle'); }
          },
          onMessage: (m) => addLine((m.source || m.role) === 'user' ? 'user' : 'agent', m.message),
          onModeChange: ({ mode }) => { if (convo) { setMode(mode === 'speaking' ? 'speaking' : 'live'); } },
          onError: (e) => { $('vx-err').textContent = 'Voice error: ' + (e?.message || e); },
        });
      } catch (e) {
        convo = null;
        setMode('idle');
        status('Voice unavailable - use the typed option below.');
        $('vx-err').textContent = e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : e.message;
        $('vx-fallback').open = true;
      }
    }

    async function stop() {
      $('vx-end').classList.add('hidden');
      if (convo) { const c = convo; convo = null; await c.endSession(); }
      extract(transcriptText()); // onDisconnect may also fire; extract() guards re-entry
    }

    $('vx-orb').onclick = () => (convo ? stop() : start());
    $('vx-end').onclick = stop;
    $('vx-extract').onclick = () => extract($('vx-text').value);

    getJSON('/api/voice/config').then((cfg) => {
      if (cfg.enabled) { status('Tap the mic and talk for ~30 seconds.'); setMode('idle'); }
      else {
        status('Voice agent not configured - type instead.');
        setMode('off');
        $('vx-orb').disabled = true;
        $('vx-fallback').open = true;
      }
    }).catch(() => { status('Type instead.'); setMode('off'); $('vx-fallback').open = true; });

    return { stop: () => convo && convo.endSession() };
  }

  window.Voice = { mount };
})();
