// Gemini Live voice for the organizer: real spoken back-and-forth.
//
//   const s = await LiveVoice.start({ instructions, tools, onToolCall, onUser, onModel, onState, tokenUrl? });
//   s.stop();
//
// The browser gets a single-use ephemeral token from /api/voice/live-token (the
// API key never leaves the server), opens the Live WebSocket, streams the mic as
// 16 kHz PCM and plays the model's 24 kHz audio. Input/output transcriptions are
// reported as text so the UI can show the conversation. Tool calls are handed to
// onToolCall(name, args) and its JSON result is sent back.
//
// Also mounts a floating mic button (site-wide assistant) when window.Assistant
// (public/organizer/assistant.js) provides tools - nothing is ever done without
// the user talking to it, and destructive tools ask for a spoken yes first.

(() => {
  const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

  // Mic -> 16 kHz mono Int16 frames, done in an AudioWorklet so the UI thread stays free.
  // Served as a file so the page CSP can keep script-src free of blob:.
  const WORKLET_URL = '/organizer/pcm16-worklet.js';

  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  async function getToken(url, signal, owner) {
    const u = new URL(url || '/api/voice/live-token', location.origin);
    if (u.origin !== location.origin) throw new Error('Voice token URL must be same-origin');
    const res = await fetch(u.href, { credentials: 'include', signal, ...(owner ? { headers: { 'X-Contact-Owner': owner } } : {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Voice is unavailable'), { status: res.status });
    return data;
  }

  async function start(opts) {
    const { instructions = '', tools = [], onToolCall, onUser, onModel, onState = () => {} } = opts;
    const checkStartup = () => { if (opts.signal?.aborted) throw Object.assign(new Error('Voice startup cancelled'), { name: 'AbortError' }); };
    checkStartup();
    onState('connecting');
    const { token, model, voice } = await getToken(opts.tokenUrl, opts.signal, opts.owner);
    checkStartup();
    let stream, micCtx, outCtx, node, ws;
    const releaseAudio = () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (micCtx) micCtx.close().catch(() => {});
      if (outCtx) outCtx.close().catch(() => {});
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      checkStartup();
      micCtx = new AudioContext();
      outCtx = new AudioContext({ sampleRate: 24000 });
      await micCtx.audioWorklet.addModule(WORKLET_URL);
      checkStartup();
      const src = micCtx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(micCtx, 'pcm16');
      src.connect(node);
      ws = new WebSocket(WS_URL + '?access_token=' + encodeURIComponent(token));
    } catch (error) {
      releaseAudio();
      throw error;
    }
    let ready = false;
    let closed = false;
    let playAt = 0;
    const playing = new Set();
    let userLine = '';
    let modelLine = '';
    // Transport replay is scoped to this connection. This is not server-side
    // mutation idempotency: an unknown outcome stops all further tool work.
    const calls = new Map();
    const cancelledCalls = new Set();
    let toolQueue = Promise.resolve();
    let uncertain = false;
    function runTool(f) {
      if (!f || typeof f.id !== 'string' || !f.id || typeof f.name !== 'string') return Promise.resolve({ error: 'Invalid tool call' });
      const signature = JSON.stringify({ name: f.name, args: f.args || {} }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
      if (calls.has(f.id)) {
        const previous = calls.get(f.id);
        return previous.signature === signature ? previous.result : Promise.resolve({ error: 'Conflicting replay: this tool ID was already used for different action details.' });
      }
      if (calls.size >= 256) return Promise.resolve({ error: 'Voice tool limit reached; start a new conversation.' });
      const controller = new AbortController();
      if (cancelledCalls.has(f.id) || closed) controller.abort();
      const result = toolQueue.then(async () => {
        if (closed || controller.signal.aborted) return { error: 'Tool call cancelled.', cancelled: true };
        if (uncertain) return { error: 'A previous action has an unknown outcome. Check current data before continuing.', uncertain: true };
        let response;
        try { response = onToolCall ? await onToolCall(f.name, f.args || {}, { signal: controller.signal, id: f.id }) : { error: 'No tools here' }; }
        catch (e) { response = { error: e.message || String(e), ...(e.uncertain ? { uncertain: true } : {}) }; }
        if (response?.uncertain) {
          uncertain = true;
          if (!closed && opts.onError) opts.onError('An action has an unknown outcome. Check current data before trying again.');
        }
        return response && typeof response === 'object' ? response : { result: response };
      });
      calls.set(f.id, { controller, result, signature });
      toolQueue = result.then(() => {});
      return result;
    }

    const flushUser = () => { if (userLine.trim()) onUser?.(userLine.trim()); userLine = ''; };
    const flushModel = () => { if (modelLine.trim()) onModel?.(modelLine.trim()); modelLine = ''; };

    function play(pcmBytes) {
      const i16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength >> 1);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
      const buf = outCtx.createBuffer(1, f32.length, 24000);
      buf.copyToChannel(f32, 0);
      const s = outCtx.createBufferSource();
      s.buffer = buf;
      s.connect(outCtx.destination);
      playAt = Math.max(playAt, outCtx.currentTime + 0.03);
      s.start(playAt);
      playAt += buf.duration;
      playing.add(s);
      s.onended = () => { playing.delete(s); if (!playing.size && ready) onState('listening'); };
      onState('speaking');
    }
    function hush() { // user barged in: drop queued speech
      playing.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
      playing.clear();
      playAt = 0;
    }

    node.port.onmessage = (e) => {
      if (ready && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(e.data), mimeType: 'audio/pcm;rate=16000' } } }));
      }
    };

    ws.onopen = () => {
      if (closed) return;
      ws.send(JSON.stringify({
        setup: {
          model: 'models/' + model,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
          systemInstruction: { parts: [{ text: instructions }] },
          ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }));
    };

    ws.onmessage = async (ev) => {
      if (closed) return;
      const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      if (closed) return;
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.toolCallCancellation && Array.isArray(m.toolCallCancellation.ids)) {
        for (const id of m.toolCallCancellation.ids) { cancelledCalls.add(id); calls.get(id)?.controller.abort(); }
      }
      if (m.setupComplete) { ready = true; onState('listening'); return; }
      const sc = m.serverContent;
      if (sc) {
        if (sc.interrupted) { hush(); flushModel(); }
        if (sc.inputTranscription && sc.inputTranscription.text) { if (modelLine) flushModel(); userLine += sc.inputTranscription.text; }
        if (sc.outputTranscription && sc.outputTranscription.text) { if (userLine) flushUser(); modelLine += sc.outputTranscription.text; }
        for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
          if (p.inlineData && /^audio\/pcm/.test(p.inlineData.mimeType || '')) play(unb64(p.inlineData.data));
        }
        if (sc.turnComplete) { flushUser(); flushModel(); }
      }
      if (m.toolCall && m.toolCall.functionCalls) {
        flushUser();
        // Reserve IDs immediately, including queued calls, so replay and
        // cancellation messages cannot launch a second execution.
        const pending = m.toolCall.functionCalls.map((f) => ({ f, result: runTool(f) }));
        const functionResponses = [];
        for (const { f, result } of pending) {
          const response = await result;
          if (closed) return;
          if (!cancelledCalls.has(f.id)) functionResponses.push({ id: f.id, name: f.name, response });
        }
        if (functionResponses.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
      }
      if (m.goAway) onState('ending');
    };

    function stop() {
      if (closed) return;
      closed = true;
      ready = false;
      opts.signal?.removeEventListener('abort', stop);
      calls.forEach(({ controller }) => controller.abort());
      flushUser(); flushModel();
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch { /* closing */ }
      try { ws.close(); } catch { /* closed */ }
      hush();
      releaseAudio(); // mic light off, including failed or cancelled startup
      onState('ended');
    }
    ws.onclose = (e) => { if (!closed) { stop(); if (e.code !== 1000 && opts.onError) opts.onError(e.reason || 'Voice connection closed'); } };
    ws.onerror = () => { if (!closed && opts.onError) opts.onError('Voice connection failed'); };
    opts.signal?.addEventListener('abort', stop, { once: true });

    return {
      stop,
      say(text) { // e.g. page context after a navigation
        if (ready && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false } }));
        }
      },
    };
  }

  window.LiveVoice = { start };

  // --- floating site-wide assistant mic ------------------------------------
  const ASSISTANT_RULES = [
    'You are muop, a warm, concise voice assistant inside the muop app, which helps people stay in touch with friends, family, colleagues and community.',
    'Use the tools to do what the user asks: navigate, look people up, add or update contacts, log check-ins, plan meetups, read the page.',
    'Speak briefly (one or two sentences), confirm what you did, and say room links are ready to copy rather than reading URLs aloud.',
    'Never invent data - if a tool returns an error, say so plainly.',
    'Before anything destructive (deleting, closing a room, signing out) ask for a clear spoken yes, then call the tool with confirmed: true.',
  ].join('\n');

  function mountFab() {
    if (!window.Assistant || !Array.isArray(window.Assistant.tools) || document.getElementById('voice-fab')) return;
    const fab = document.createElement('button');
    fab.id = 'voice-fab';
    fab.type = 'button';
    fab.className = 'voice-fab';
    fab.setAttribute('aria-label', 'Talk to muop');
    fab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>';
    const panel = document.createElement('div');
    panel.className = 'voice-panel hidden';
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = '<div class="voice-panel-status"></div><div class="voice-panel-log"></div>';
    document.body.append(panel, fab);
    const statusEl = panel.querySelector('.voice-panel-status');
    const logEl = panel.querySelector('.voice-panel-log');
    const line = (who, text) => {
      const d = document.createElement('div');
      d.className = 'voice-line ' + who;
      d.textContent = text;
      logEl.appendChild(d);
      while (logEl.children.length > 6) logEl.firstChild.remove();
    };
    const LABEL = { connecting: 'Connecting...', listening: 'Listening - ask me anything', speaking: 'Speaking...', ending: 'Wrapping up...', ended: 'Tap the mic to talk' };
    let session = null;
    let controller = null;
    let generation = 0;

    fab.onclick = async () => {
      if (controller || session) {
        generation++;
        controller?.abort(); controller = null;
        const previous = session; session = null; previous?.stop();
        fab.classList.remove('on'); fab.dataset.state = 'ended';
        statusEl.textContent = LABEL.ended;
        return;
      }
      const run = ++generation;
      const owner = window.Assistant.currentOwner?.();
      if (!owner) { panel.classList.remove('hidden'); statusEl.textContent = 'Reload this page to verify your signed-in account before starting voice.'; return; }
      const attempt = new AbortController(); controller = attempt;
      const active = () => generation === run && !attempt.signal.aborted;
      panel.classList.remove('hidden');
      logEl.textContent = '';
      fab.classList.add('on');
      try {
        const ctx = typeof window.Assistant.context === 'function' ? window.Assistant.context() : '';
        const created = await start({
          signal: attempt.signal, owner,
          instructions: ASSISTANT_RULES + (window.Assistant.instructions ? '\n' + window.Assistant.instructions : '') + (ctx ? '\n\nCurrent page:\n' + ctx : ''),
          tools: window.Assistant.tools,
          onToolCall: async (name, args, context) => {
            if (!active()) return { error: 'Voice request cancelled.', cancelled: true };
            const r = await window.Assistant.call(name, args, { ...context, owner });
            if (active() && (name === 'navigate' || name === 'open_contact')) setTimeout(() => { if (active()) session?.say('[page changed] ' + (window.Assistant.context ? window.Assistant.context() : '')); }, 600);
            return r;
          },
          onUser: (t) => { if (active()) line('user', t); },
          onModel: (t) => { if (active()) line('agent', t); },
          onState: (st) => {
            if (!active()) return;
            statusEl.textContent = LABEL[st] || '';
            fab.dataset.state = st;
            if (st === 'ended') {
              session = null; controller = null; fab.classList.remove('on');
              setTimeout(() => { if (generation === run && !session && !controller) panel.classList.add('hidden'); }, 4000);
            }
          },
          onError: (msg) => { if (active()) statusEl.textContent = msg; },
        });
        if (!active()) created.stop(); else session = created;
      } catch (e) {
        if (!active()) return;
        session = null; controller = null;
        fab.classList.remove('on');
        statusEl.textContent = (e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : (e && e.message) || 'Voice failed.') + ' You can still use the page controls.';
      }
    };
  }

  // assistant.js may load after this file; try now and once the page has loaded.
  if (document.readyState === 'complete') mountFab();
  else window.addEventListener('load', mountFab, { once: true });
})();
