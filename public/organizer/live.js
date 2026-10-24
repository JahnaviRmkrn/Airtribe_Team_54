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
  const WORKLET = `
    class Pcm16 extends AudioWorkletProcessor {
      constructor() { super(); this.buf = []; this.ratio = sampleRate / 16000; this.pos = 0; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        for (; this.pos < ch.length; this.pos += this.ratio) {
          const s = Math.max(-1, Math.min(1, ch[Math.floor(this.pos)]));
          this.buf.push(s < 0 ? s * 0x8000 : s * 0x7fff);
        }
        this.pos -= ch.length;
        if (this.buf.length >= 1600) { // 100 ms
          this.port.postMessage(Int16Array.from(this.buf).buffer, []);
          this.buf = [];
        }
        return true;
      }
    }
    registerProcessor('pcm16', Pcm16);`;

  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

  async function getToken(url) {
    const res = await fetch(url || '/api/voice/live-token', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Voice is unavailable'), { status: res.status });
    return data;
  }

  async function start(opts) {
    const { instructions = '', tools = [], onToolCall, onUser, onModel, onState = () => {} } = opts;
    onState('connecting');
    const { token, model, voice } = await getToken(opts.tokenUrl);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const micCtx = new AudioContext();
    const outCtx = new AudioContext({ sampleRate: 24000 });
    const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await micCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    const src = micCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(micCtx, 'pcm16');
    src.connect(node);

    const ws = new WebSocket(WS_URL + '?access_token=' + encodeURIComponent(token));
    let ready = false;
    let closed = false;
    let playAt = 0;
    const playing = new Set();
    let userLine = '';
    let modelLine = '';

    const flushUser = () => { if (userLine.trim()) onUser && onUser(userLine.trim()); userLine = ''; };
    const flushModel = () => { if (modelLine.trim()) onModel && onModel(modelLine.trim()); modelLine = ''; };

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
      const raw = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let m;
      try { m = JSON.parse(raw); } catch { return; }
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
        const functionResponses = [];
        for (const f of m.toolCall.functionCalls) {
          let response;
          try { response = onToolCall ? await onToolCall(f.name, f.args || {}) : { error: 'No tools here' }; } catch (e) { response = { error: e.message || String(e) }; }
          functionResponses.push({ id: f.id, name: f.name, response: response && typeof response === 'object' ? response : { result: response } });
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
      }
      if (m.goAway) onState('ending');
    };

    function stop() {
      if (closed) return;
      closed = true;
      ready = false;
      flushUser(); flushModel();
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch { /* closing */ }
      try { ws.close(); } catch { /* closed */ }
      hush();
      stream.getTracks().forEach((t) => t.stop()); // mic light off
      micCtx.close().catch(() => {});
      outCtx.close().catch(() => {});
      onState('ended');
    }
    ws.onclose = (e) => { if (!closed) { stop(); if (e.code !== 1000 && opts.onError) opts.onError(e.reason || 'Voice connection closed'); } };
    ws.onerror = () => { if (opts.onError) opts.onError('Voice connection failed'); };

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

    fab.onclick = async () => {
      if (session) { session.stop(); session = null; return; }
      panel.classList.remove('hidden');
      logEl.textContent = '';
      fab.classList.add('on');
      try {
        const ctx = typeof window.Assistant.context === 'function' ? window.Assistant.context() : '';
        session = await start({
          instructions: ASSISTANT_RULES + (window.Assistant.instructions ? '\n' + window.Assistant.instructions : '') + (ctx ? '\n\nCurrent page:\n' + ctx : ''),
          tools: window.Assistant.tools,
          onToolCall: async (name, args) => {
            const r = await window.Assistant.call(name, args);
            if (name === 'navigate' || name === 'open_contact') setTimeout(() => session && session.say('[page changed] ' + (window.Assistant.context ? window.Assistant.context() : '')), 600);
            return r;
          },
          onUser: (t) => line('user', t),
          onModel: (t) => line('agent', t),
          onState: (st) => {
            statusEl.textContent = LABEL[st] || '';
            fab.dataset.state = st;
            if (st === 'ended') { session = null; fab.classList.remove('on'); setTimeout(() => { if (!session) panel.classList.add('hidden'); }, 4000); }
          },
          onError: (msg) => { statusEl.textContent = msg; },
        });
      } catch (e) {
        session = null;
        fab.classList.remove('on');
        statusEl.textContent = e && e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : (e && e.message) || 'Voice failed.';
      }
    };
  }

  // assistant.js may load after this file; try now and once the page has loaded.
  if (document.readyState === 'complete') mountFab();
  else window.addEventListener('load', mountFab, { once: true });
})();
