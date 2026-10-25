// Mic capture for Gemini Live: resamples to 16 kHz and posts 100 ms PCM16
// chunks. A real file (not a blob: URL) so the CSP needn't allow blob: scripts.
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
registerProcessor('pcm16', Pcm16);
