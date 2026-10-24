"use strict";
// Moup - Voice Onboarding Engine (TypeScript)
// Communicates with ElevenLabs Conversational AI using WebSocket session tokens.
// Captures conversation naturally and streams extracted relationship data in real-time.
(() => {
    const SDK_URL = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client/+esm';
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
    async function getJSON(url, opts) {
        const r = await fetch(url, opts);
        const d = await r.json().catch(() => ({}));
        if (!r.ok)
            throw new Error(d.detail || r.statusText);
        return d;
    }
    function mount(root, onResult) {
        const lines = [];
        let convo = null;
        let extracting = false;
        root.innerHTML = `
      <div class="vx">
        <div class="vx-head">
          <button class="vx-orb" id="vx-orb" type="button" aria-label="Start voice session">
            <span class="vx-ring"></span><span class="vx-ring r2"></span>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>
          </button>
          <div>
            <div class="vx-title">Voice Calibration</div>
            <div class="vx-status" id="vx-status">Initializing audio service…</div>
          </div>
          <div class="vx-actions">
            <button class="vx-clear hidden" id="vx-clear" type="button" title="Clear conversation history">Clear chat</button>
            <button class="vx-end hidden" id="vx-end" type="button">Conclude session</button>
          </div>
        </div>
        <div class="vx-log hidden" id="vx-log" aria-live="polite"></div>
        <details class="vx-fallback" id="vx-fallback">
          <summary>Prefer text input? Describe your key relationships</summary>
          <textarea id="vx-text" rows="4" placeholder="e.g., I would like to prioritize staying close to my sister Priya, my friend Arjun, and my mentor Meera. Family 40%, Friends 30%, Work 20%, Mentors 10%."></textarea>
          <button type="button" id="vx-extract">Extract</button>
        </details>
        <p class="vx-err" id="vx-err"></p>
      </div>`;
        const $ = (id) => root.querySelector('#' + id);
        const status = (t) => { $('vx-status').textContent = t; };
        const setMode = (m) => { root.querySelector('.vx').dataset.mode = m; };
        let liveTimer = null;
        function scheduleLiveExtract() {
            if (liveTimer)
                clearTimeout(liveTimer);
            liveTimer = setTimeout(async () => {
                const text = transcriptText();
                if (!text.trim())
                    return;
                try {
                    const res = await getJSON('/api/extract', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ transcript: text }),
                    });
                    if (res)
                        onResult(res);
                }
                catch (_) { }
            }, 350);
        }
        function clearChat() {
            if (liveTimer)
                clearTimeout(liveTimer);
            lines.length = 0;
            const log = $('vx-log');
            log.innerHTML = '';
            log.classList.add('hidden');
            $('vx-clear').classList.add('hidden');
            const area = $('vx-text');
            if (area)
                area.value = '';
            status(convo ? 'Chat cleared. Please speak your priority contacts.' : 'Chat cleared.');
        }
        function addLine(who, text) {
            if (!text)
                return;
            if (who === 'user' && /^\s*(?:clear\s+chat|clear\s+transcript|reset\s+chat|clear\s+messages)\s*$/i.test(text.trim())) {
                clearChat();
                return;
            }
            lines.push({ who, text });
            const log = $('vx-log');
            log.classList.remove('hidden');
            log.insertAdjacentHTML('beforeend', `<div class="vx-msg ${who}"><span>${esc(text)}</span></div>`);
            log.scrollTop = log.scrollHeight;
            $('vx-clear').classList.remove('hidden');
            scheduleLiveExtract();
        }
        async function extract(transcript) {
            if (extracting || !transcript.trim())
                return;
            extracting = true;
            if (liveTimer)
                clearTimeout(liveTimer);
            $('vx-err').textContent = '';
            status('Processing conversation details…');
            setMode('thinking');
            try {
                const res = await getJSON('/api/extract', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transcript }),
                });
                status(`Recorded ${res.contacts.length} ${res.contacts.length === 1 ? 'contact' : 'contacts'} — please review below.`);
                setMode('done');
                onResult(res);
            }
            catch (e) {
                $('vx-err').textContent = 'Unable to extract conversation: ' + e.message;
                status('Please try again or utilize the text option.');
                setMode('idle');
            }
            finally {
                extracting = false;
            }
        }
        const transcriptText = () => lines.map((l) => `${l.who === 'user' ? 'User' : 'Agent'}: ${l.text}`).join('\n');
        async function start() {
            $('vx-err').textContent = '';
            try {
                status('Requesting microphone access…');
                await navigator.mediaDevices.getUserMedia({ audio: true });
                status('Connecting with Moup assistant…');
                setMode('connecting');
                const [{ Conversation }, cfg] = await Promise.all([
                    import(SDK_URL),
                    getJSON('/api/voice/config'),
                ]);
                const session = cfg.mode === 'signed'
                    ? { signedUrl: (await getJSON('/api/voice/signed-url')).signed_url }
                    : { agentId: cfg.agent_id };
                convo = await Conversation.startSession({
                    ...session,
                    onConnect: () => {
                        status('Connected. Speak naturally to share your priority contacts.');
                        setMode('live');
                        $('vx-end').classList.remove('hidden');
                    },
                    onDisconnect: () => {
                        convo = null;
                        $('vx-end').classList.add('hidden');
                        if (lines.some((l) => l.who === 'user'))
                            extract(transcriptText());
                        else {
                            status('Session concluded. Tap the microphone to reconnect.');
                            setMode('idle');
                        }
                    },
                    onMessage: (m) => {
                        const role = (m.source === 'user' || m.role === 'user') ? 'user' : 'agent';
                        addLine(role, m.message);
                    },
                    onModeChange: ({ mode }) => {
                        if (convo) {
                            if (mode === 'speaking') {
                                setMode('speaking');
                                status('Moup is speaking…');
                            }
                            else {
                                setMode('live');
                                status('Listening… please speak.');
                            }
                        }
                    },
                    onError: (e) => {
                        console.error('ElevenLabs voice service error:', e);
                        $('vx-err').textContent = 'Audio service error: ' + (e?.message || e);
                    },
                });
            }
            catch (e) {
                convo = null;
                setMode('idle');
                status('Voice calibration unavailable — please use the text input below.');
                $('vx-err').textContent =
                    e.name === 'NotAllowedError' ? 'Microphone permission was not granted.' : e.message;
                const details = $('vx-fallback');
                if (details)
                    details.open = true;
            }
        }
        async function stop() {
            $('vx-end').classList.add('hidden');
            if (convo) {
                const c = convo;
                convo = null;
                await c.endSession();
            }
            extract(transcriptText());
        }
        $('vx-orb').onclick = () => (convo ? stop() : start());
        $('vx-end').onclick = stop;
        $('vx-clear').onclick = clearChat;
        $('vx-extract').onclick = () => {
            const area = $('vx-text');
            extract(area.value);
        };
        getJSON('/api/voice/config')
            .then((cfg) => {
            if (cfg.enabled) {
                status('Tap the microphone to begin voice calibration.');
                setMode('idle');
            }
            else {
                status('Voice service is offline — please enter details manually.');
                setMode('off');
                $('vx-orb').disabled = true;
                $('vx-fallback').open = true;
            }
        })
            .catch(() => {
            status('Please enter details manually.');
            setMode('off');
            $('vx-fallback').open = true;
        });
        return { stop: () => convo && convo.endSession() };
    }
    window.Voice = { mount };
})();
