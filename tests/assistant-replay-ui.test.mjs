import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../public/organizer/live.js', import.meta.url), 'utf8');
function fixture() {
  const sockets = [];
  class Socket { static OPEN = 1; constructor() { sockets.push(this); this.readyState = 1; this.send = vi.fn(); this.close = vi.fn(); } }
  class AudioContext { audioWorklet = { addModule: async () => {} }; close = async () => {}; createMediaStreamSource() { return { connect() {} }; } }
  const window = {};
  vm.runInNewContext(source, { window, document: { readyState: 'complete' }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, location: { origin: 'https://example.test' }, URL, AbortController, AudioContext, AudioWorkletNode: class { port = {}; }, WebSocket: Socket,
    fetch: async () => ({ ok: true, json: async () => ({ token: 'synthetic', model: 'synthetic', voice: 'synthetic' }) }),
  });
  return { start: window.LiveVoice.start, packet: (call) => sockets[0].onmessage({ data: JSON.stringify({ toolCall: { functionCalls: [call] } }) }), responses: () => sockets[0].send.mock.calls.map(([raw]) => JSON.parse(raw)).filter((r) => r.toolResponse).flatMap((r) => r.toolResponse.functionResponses) };
}
const original = { id: 'same-id', name: 'create_meetup', args: { title: 'Synthetic brunch', area: 'Central' } };
describe('Gemini Live replay identity', () => {
  it.each([{ ...original, name: 'delete_contact' }, { ...original, args: { title: 'Different plan' } }])('rejects a conflicting replay without claiming the new payload executed', async (changed) => {
    const h = fixture(), onToolCall = vi.fn(async () => ({ ok: true, created: 'Original plan only' })); const session = await h.start({ onToolCall });
    await h.packet(original); await h.packet(changed);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(h.responses().at(-1).response).toMatchObject({ error: expect.stringMatching(/conflict|different/i) });
    expect(h.responses().at(-1).response.ok).toBeUndefined(); session.stop();
  });
  it('recognizes semantically identical arguments despite JSON key ordering', async () => {
    const h = fixture(), onToolCall = vi.fn(async () => ({ ok: true })); const session = await h.start({ onToolCall });
    await h.packet(original); await h.packet({ ...original, args: { area: 'Central', title: 'Synthetic brunch' } });
    expect(onToolCall).toHaveBeenCalledTimes(1); expect(h.responses().at(-1).response).toEqual({ ok: true }); session.stop();
  });
});
