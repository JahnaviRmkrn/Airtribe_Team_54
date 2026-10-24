// Voice onboarding widget (ElevenLabs Agents) + typed fallback.
// Ported from Arindom Chetia's static/voice.js (PR #3).
//
// Usage: const v = Voice.mount(containerEl, (result) => { ... }); v.stop();
//   result = { contacts: [{ name, category, interests, preferred_frequency_days? }] (<=5),
//              goals: { personal, professional, community } (total 100), source, saved: false }
// Nothing is saved here: the caller pre-fills the editable confirm screen and
// only the user's explicit Confirm persists anything.
//
// Voice needs ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID on the server; the
// browser only ever sees a short-lived signed URL from /api/voice/signed-url.
// The typed fallback (POST /api/extract) always works.

(() => {
  // Pinned version + Subresource Integrity, loaded only when the mic is tapped.
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/dist/lib.iife.js';
  const SDK_SRI = 'sha384-ekuWfdL0BkeVAWv24yeCWtzVwYDQd4pCkPL5TKVDLmwDBeVxS2cTwo0wfsUNaFkJ';
  const EXAMPLE = 'e.g. I want to call my sister Priya every week, catch up with my colleague Arjun about climbing, '
    + 'and see my neighbour Meera. Personal 50%, professional 30%, community 20%.';

  let sdkPromise = null;
  function loadSdk() {
    if (window.ElevenLabsClient) return Promise.resolve(window.ElevenLabsClient);
    sdkPromise = sdkPromise || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.integrity = SDK_SRI;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = () => (window.ElevenLabsClient ? resolve(window.ElevenLabsClient) : reject(new Error('Voice library failed to load.')));
      s.onerror = () => { sdkPromise = null; s.remove(); reject(new Error('Voice library failed to load.')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }

  async function getJSON(url, opts = {}) {
    const res = await fetch(url, { credentials: 'include', ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.href = '/login?next=' + encodeURIComponent('/organizer/#/onboarding');
      throw new Error('Not signed in - redirecting to login.');
    }
    if (!res.ok) throw Object.assign(new Error(data.error || ('Request failed (' + res.status + ')')), { status: res.status });
    return data;
  }

  function mount(root, onResult) {
    const lines = []; // { who: 'user' | 'agent', text }
    let convo = null;
    let starting = false;
    let extracting = false;
    let left = false; // set once the user leaves this screen; late async work is dropped

    // Static markup only; all dynamic text below goes through textContent.
    root.innerHTML = `
      <div class="vx" data-mode="idle">
        <div class="vx-head">
          <button class="vx-orb" type="button" data-vx="orb" aria-label="Talk instead">
            <span class="vx-ring"></span><span class="vx-ring r2"></span>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>
          </button>
          <div class="vx-text">
            <div class="vx-title">Talk instead</div>
            <div class="vx-status" data-vx="status" aria-live="polite">Tap the mic and talk for about 30 seconds.</div>
          </div>
          <button class="vx-end hidden" type="button" data-vx="end">Done talking</button>
        </div>
        <div class="vx-log hidden" data-vx="log" aria-live="polite"></div>
        <details class="vx-fallback" data-vx="fallback">
          <summary>Type instead</summary>
          <textarea data-vx="text" rows="4" maxlength="20000"></textarea>
          <button type="button" data-vx="extract">Fill in from text</button>
        </details>
        <p class="vx-err" data-vx="err"></p>
      </div>`;

    const $ = (k) => root.querySelector('[data-vx="' + k + '"]');
    const box = root.querySelector('.vx');
    const status = (t) => { $('status').textContent = t; };
    const error = (t) => { $('err').textContent = t || ''; };
    const setMode = (m) => { box.dataset.mode = m; };
    $('text').placeholder = EXAMPLE;

    function addLine(who, text) {
      if (!text) return;
      lines.push({ who, text });
      const log = $('log');
      log.classList.remove('hidden');
      const row = document.createElement('div');
      row.className = 'vx-msg ' + who;
      const span = document.createElement('span');
      span.textContent = text;
      row.appendChild(span);
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }

    const transcriptText = () => lines.map((l) => (l.who === 'user' ? 'User: ' : 'Agent: ') + l.text).join('\n');

    async function extract(transcript) {
      if (extracting || !transcript.trim()) return;
      extracting = true;
      error('');
      status('Pulling out your people and goals...');
      setMode('thinking');
      $('extract').disabled = true;
      try {
        const res = await getJSON('/api/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript }),
        });
        if (left) return;
        const n = res.contacts.length;
        status('Found ' + n + ' ' + (n === 1 ? 'person' : 'people') + ' - review below. Nothing is saved until you confirm.');
        setMode('done');
        onResult(res);
      } catch (e) {
        error('Could not fill in: ' + e.message);
        status('Try again, or type it instead.');
        setMode('idle');
      } finally {
        extracting = false;
        $('extract').disabled = false;
      }
    }

    function voiceUnavailable(msg) {
      setMode('off');
      $('orb').disabled = true;
      status('Voice is unavailable - type instead.');
      if (msg) error(msg);
      $('fallback').open = true;
    }

    async function start() {
      if (starting || convo) return;
      starting = true;
      error('');
      try {
        status('Connecting...');
        setMode('connecting');
        let signed;
        try {
          signed = await getJSON('/api/voice/signed-url');
          if (left) return;
        } catch (e) {
          if (e.status === 503) return voiceUnavailable();
          throw e;
        }
        const sdk = await loadSdk();
        if (left) return;
        const session = await sdk.Conversation.startSession({
          signedUrl: signed.signed_url,
          onConnect: () => {
            status('Listening - tell me about the people who matter.');
            setMode('live');
            $('end').classList.remove('hidden');
          },
          onDisconnect: () => {
            convo = null;
            $('end').classList.add('hidden');
            if (left) return;
            if (lines.some((l) => l.who === 'user')) extract(transcriptText());
            else { status('Call ended. Tap the mic to try again.'); setMode('idle'); }
          },
          onMessage: (m) => addLine((m.role || m.source) === 'user' ? 'user' : 'agent', m.message),
          onModeChange: ({ mode }) => { if (convo) setMode(mode === 'speaking' ? 'speaking' : 'live'); },
          onError: (msg) => error('Voice error: ' + (msg && msg.message ? msg.message : msg)),
        });
        // Left while connecting: close the call so the mic doesn't stay on.
        if (left) { session.endSession().catch(() => {}); return; }
        convo = session;
      } catch (e) {
        convo = null;
        setMode('idle');
        status('Voice did not start - you can type instead.');
        error(e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : (e && e.message) || 'Voice failed.');
        $('fallback').open = true;
      } finally {
        starting = false;
      }
    }

    async function stop() {
      $('end').classList.add('hidden');
      if (convo) {
        const c = convo;
        convo = null;
        try { await c.endSession(); } catch { /* already closed */ }
      }
      if (lines.some((l) => l.who === 'user')) extract(transcriptText()); // extract() guards re-entry
    }

    // Leaving the onboarding screen ends any live call.
    const onLeave = () => {
      left = true;
      if (convo) { const c = convo; convo = null; c.endSession().catch(() => {}); }
    };
    window.addEventListener('hashchange', onLeave, { once: true });

    $('orb').onclick = () => (convo ? stop() : start());
    $('end').onclick = stop;
    $('extract').onclick = () => extract($('text').value);

    return { stop: onLeave };
  }

  window.Voice = { mount };
})();
