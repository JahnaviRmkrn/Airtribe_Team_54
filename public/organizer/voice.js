// Voice onboarding widget (ElevenLabs Agents) + typed fallback.
// Ported from Arindom Chetia's static/voice.js (PR #3).
//
// Usage: const v = Voice.mount(containerEl, (result) => { ... }); v.stop();
//   result = { contacts: [{ name, category, interests, preferred_frequency_days? }] (<=5),
//              goals: { personal, professional, community } (total 100), source, saved: false }
// Nothing is saved here: the caller pre-fills the editable confirm screen and
// only the user's explicit Confirm persists anything.
//
// Voice prefers a live spoken conversation with Gemini Live (live.js, token from
// /api/voice/live-token) that fills the rows as you talk. Next it uses ElevenLabs when ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID are set
// (the browser only ever sees a short-lived signed URL from /api/voice/signed-url).
// Otherwise it records a clip with the mic and POSTs it to /api/voice/transcribe,
// where Gemini (GEMINI_API_KEY, server-only) transcribes it. Either way the
// transcript goes through /api/extract. The typed fallback always works.

(() => {
  // Pinned version + Subresource Integrity, loaded only when the mic is tapped.
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.27.0/dist/lib.iife.js';
  const SDK_SRI = 'sha384-ekuWfdL0BkeVAWv24yeCWtzVwYDQd4pCkPL5TKVDLmwDBeVxS2cTwo0wfsUNaFkJ';
  // Match the pinned SDK above. Its default blob:/data: worklets are blocked
  // by our strict CSP. Self-host the processors and its conditional resampler;
  // no additional script origins, blob:, eval, or WebAssembly are needed.
  // See docs/voice-csp-worklets.md for upstream provenance and checksums.
  const WORKLET_PATHS = Object.freeze({
    rawAudioProcessor: '/vendor/elevenlabs/1.27.0/rawAudioProcessor.js',
    audioConcatProcessor: '/vendor/elevenlabs/1.27.0/audioConcatProcessor.js',
  });
  const LIBSAMPLERATE_PATH = '/vendor/libsamplerate/2.1.2/libsamplerate.worklet.js';
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
    let rec = null; // Gemini record path: { recorder, stream, chunks, timer }
    let live = null; // Gemini Live session (live.js)
    let fillTimer = null;
    let starting = false;
    let extracting = false;
    let left = false; // set once the user leaves this screen; late async work is dropped

    // Static markup only; all dynamic text below goes through textContent.
    root.innerHTML = `
      <div class="vx" data-mode="idle">
        <div class="vx-guide">
          <svg class="vx-char" viewBox="0 0 96 96" role="img" aria-label="Friendly muop guide">
            <g class="vx-sat s1"><circle cx="80" cy="24" r="8" fill="#04C1E1" stroke="#2E1F14" stroke-width="2.4"/></g>
            <g class="vx-sat s2"><circle cx="14" cy="30" r="6" fill="#75E4DE" stroke="#2E1F14" stroke-width="2.4"/></g>
            <g class="vx-body">
              <circle cx="48" cy="54" r="30" fill="#F6AC0D" stroke="#2E1F14" stroke-width="2.4"/>
              <ellipse cx="36" cy="64" rx="5" ry="3.2" fill="#FFF3C4" opacity="0.7"/>
              <ellipse cx="60" cy="64" rx="5" ry="3.2" fill="#FFF3C4" opacity="0.7"/>
              <g class="vx-eyes"><circle cx="38" cy="50" r="3.4" fill="#2E1F14"/><circle cx="58" cy="50" r="3.4" fill="#2E1F14"/></g>
              <path class="vx-smile" d="M38 61 Q48 70 58 61" fill="none" stroke="#2E1F14" stroke-width="2.6" stroke-linecap="round"/>
              <ellipse class="vx-mouth" cx="48" cy="64" rx="6" ry="5" fill="#2E1F14"/>
            </g>
          </svg>
          <div class="vx-bubble">
            <div class="vx-title">Talk to me.</div>
            <div class="vx-ask">Who are five people you'd love to stay in touch with?</div>
            <div class="vx-hint">Say their names, how you know them, and how often you'd like to catch up.</div>
          </div>
        </div>
        <div class="vx-head">
          <button class="vx-orb" type="button" data-vx="orb" aria-label="Tap to talk">
            <span class="vx-ring"></span><span class="vx-ring r2"></span>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>
          </button>
          <div class="vx-text">
            <div class="vx-label" data-vx="label">Tap to talk</div>
            <div class="vx-status" data-vx="status" aria-live="polite">Your browser will ask for microphone access. You can type instead.</div>
          </div>
          <button class="vx-end hidden" type="button" data-vx="end">Done talking</button>
        </div>
        <div class="vx-log hidden" data-vx="log" aria-live="polite"></div>
        <details class="vx-fallback" data-vx="fallback">
          <summary>Prefer typing? Tell me here</summary>
          <textarea data-vx="text" rows="4" maxlength="20000"></textarea>
          <button type="button" data-vx="extract">Fill in from text</button>
        </details>
        <p class="vx-err" data-vx="err"></p>
      </div>`;

    const $ = (k) => root.querySelector('[data-vx="' + k + '"]');
    const box = root.querySelector('.vx');
    const status = (t) => { $('status').textContent = t; };
    const error = (t) => { $('err').textContent = t || ''; };
    const LABELS = { idle: 'Tap to talk', connecting: 'Connecting...', live: "I'm listening", speaking: 'Speaking...', thinking: 'Thinking...', done: 'Tap to talk again', off: 'Voice unavailable' };
    const setMode = (m) => { box.dataset.mode = m; const l = $('label'); if (l) l.textContent = LABELS[m] || LABELS.idle; };
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

    // While talking live: refresh the rows in the background, without touching the call UI.
    function scheduleFill() {
      clearTimeout(fillTimer);
      fillTimer = setTimeout(async () => {
        if (left || extracting || !live) return;
        try {
          const res = await getJSON('/api/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript: transcriptText() }),
          });
          if (!left && live) onResult(res);
        } catch { /* the final extract on hang-up reports errors */ }
      }, 1200);
    }

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
        status('I found ' + n + ' ' + (n === 1 ? 'person' : 'people') + '. Check and fix them below. Nothing is saved until you confirm.');
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
      status('Voice is not available right now. Type it instead and I will fill in the form.');
      if (msg) error(msg);
      $('fallback').open = true;
    }

    const LIVE_INSTRUCTIONS = [
      "You are muop's onboarding guide, helping the user set up the people they want to stay in touch with.",
      'Have a short, friendly spoken conversation (about a minute). Ask one brief question at a time.',
      'Help them name up to 5 people: for each, how they know them (personal, professional or community), one or two interests, and roughly how often to check in.',
      'Then ask how they want to split their attention across personal, professional and community - it must add up to 100 percent.',
      'Repeat names back so spelling can be checked. Do not invent people or details.',
      "When you have enough, give a one-line summary and tell them to tap 'Done talking' to review and confirm. Nothing is saved until they confirm.",
    ].join('\n');

    async function startLive() {
      live = await window.LiveVoice.start({
        instructions: LIVE_INSTRUCTIONS,
        onUser: (t) => { addLine('user', t); scheduleFill(); },
        onModel: (t) => addLine('agent', t),
        onError: (msg) => error('Voice error: ' + msg),
        onState: (st) => {
          if (left) return;
          if (st === 'listening') { status('Listening - tell me about the people who matter.'); setMode('live'); $('end').classList.remove('hidden'); }
          else if (st === 'speaking') setMode('speaking');
          else if (st === 'ended') {
            live = null;
            clearTimeout(fillTimer);
            $('end').classList.add('hidden');
            if (lines.some((l) => l.who === 'user')) extract(transcriptText());
            else { status('Call ended. Tap the mic to try again.'); setMode('idle'); }
          }
        },
      });
      if (left) { live.stop(); live = null; }
    }

    async function start() {
      if (left || starting || convo || live || rec) return;
      starting = true;
      error('');
      try {
        status('Connecting...');
        setMode('connecting');
        if (window.LiveVoice) {
          try { await startLive(); return; } catch (e) { if (e.status !== 503) throw e; } // 503: no Gemini key -> next option
        }
        if (left) return;
        let signed;
        try {
          signed = await getJSON('/api/voice/signed-url');
          if (left) return;
        } catch (e) {
          if (left) return;
          // Await so microphone/recorder failures reach the recovery UI and
          // repeated taps cannot start another recording while this is pending.
          if (e.status === 503) return await startRecording(); // no ElevenLabs: record + Gemini
          throw e;
        }
        const sdk = await loadSdk();
        if (left) return;
        const session = await sdk.Conversation.startSession({
          signedUrl: signed.signed_url,
          workletPaths: WORKLET_PATHS,
          libsampleratePath: LIBSAMPLERATE_PATH,
          onConnect: () => {
            if (left) return;
            status('Go ahead. Tell me about the people who matter.');
            setMode('live');
            $('end').classList.remove('hidden');
          },
          onDisconnect: () => {
            if (left) return;
            convo = null;
            $('end').classList.add('hidden');
            if (lines.some((l) => l.who === 'user')) extract(transcriptText());
            else { status('Call ended. Tap the mic to try again.'); setMode('idle'); }
          },
          onMessage: (m) => { if (!left) addLine((m.role || m.source) === 'user' ? 'user' : 'agent', m.message); },
          onModeChange: ({ mode }) => { if (!left && convo) setMode(mode === 'speaking' ? 'speaking' : 'live'); },
          onError: (msg) => { if (!left) error('Voice error: ' + (msg && msg.message ? msg.message : msg)); },
        });
        // Left while connecting: close the call so the mic doesn't stay on.
        if (left) { session.endSession().catch(() => {}); return; }
        convo = session;
      } catch (e) {
        if (left) return;
        convo = null;
        setMode('idle');
        status('Voice did not start - you can type instead.');
        error(e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : (e && e.message) || 'Voice failed.');
        $('fallback').open = true;
      } finally {
        starting = false;
      }
    }

    // --- Gemini path: record a clip, transcribe on the server --------------
    const RECORD_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
    const MAX_RECORD_MS = 90_000;

    async function startRecording() {
      if (!window.MediaRecorder || typeof navigator.mediaDevices?.getUserMedia !== 'function') return voiceUnavailable('This browser cannot record audio.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (left) { stream.getTracks().forEach((t) => t.stop()); return; }
      let recorder;
      try {
        const mimeType = RECORD_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = () => uploadRecording(chunks, recorder.mimeType || mimeType || 'audio/webm');
        recorder.start();
        rec = { recorder, stream, timer: setTimeout(() => stop(), MAX_RECORD_MS) };
      } catch (e) {
        // The stream is already acquired, but endRecording cannot see it yet.
        // Do not leave the mic on or upload a failed recording during cleanup.
        if (recorder) {
          recorder.ondataavailable = null;
          recorder.onstop = null;
          try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
        }
        stream.getTracks().forEach((t) => t.stop());
        throw e;
      }
      status('Listening - tell me about the people who matter, then tap "Done talking".');
      setMode('live');
      $('end').classList.remove('hidden');
    }

    function endRecording(upload) {
      if (!rec) return;
      const { recorder, stream, timer } = rec;
      rec = null;
      clearTimeout(timer);
      if (!upload) { recorder.ondataavailable = null; recorder.onstop = null; }
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((t) => t.stop()); // mic light off right away
    }

    async function uploadRecording(chunks, type) {
      if (left) return;
      const blob = new Blob(chunks, { type });
      status('Transcribing...');
      setMode('thinking');
      try {
        const res = await getJSON('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': type.split(';')[0] },
          body: blob,
        });
        if (left) return;
        const transcript = (res.transcript || '').trim();
        if (!transcript) { status("Didn't catch that - tap the mic and try again."); setMode('idle'); return; }
        addLine('user', transcript);
        extract(transcript);
      } catch (e) {
        if (left) return;
        if (e.status === 503 && /not configured/i.test(e.message)) return voiceUnavailable();
        error('Could not transcribe: ' + e.message);
        status('Tap the mic to try again, or type it instead.');
        setMode('idle');
      }
    }

    async function stop() {
      $('end').classList.add('hidden');
      if (rec) return endRecording(true); // upload -> transcribe -> extract
      if (live) { const l = live; return l.stop(); } // onState('ended') runs the final extract
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
      endRecording(false);
      clearTimeout(fillTimer);
      if (live) { const l = live; live = null; l.stop(); }
    };
    window.addEventListener('hashchange', onLeave, { once: true });

    $('orb').onclick = () => (convo || rec || live ? stop() : start());
    $('end').onclick = stop;
    $('extract').onclick = () => extract($('text').value);

    return { stop: onLeave };
  }

  window.Voice = { mount };
})();
