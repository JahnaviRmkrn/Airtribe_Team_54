import { beforeEach, describe, expect, it, vi } from 'vitest';

const transcribe = vi.fn();
const limitLlm = vi.fn();
vi.mock('server-only', () => ({}));
vi.mock('@/lib/ratelimit', () => ({ limitLlm }));
vi.mock('@/lib/supabase/server', () => ({
  userClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }),
}));
vi.mock('@/lib/transcribe', async (orig) => ({ ...(await orig<typeof import('@/lib/transcribe')>()), transcribe }));

const { POST } = await import('../app/api/voice/transcribe/route');
const { MAX_AUDIO_BYTES } = await import('./transcribe');

beforeEach(() => { transcribe.mockReset().mockResolvedValue('hello'); limitLlm.mockReset(); });

const upload = (size: number, chunk = 1_000_000) =>
  new Request('https://app.example/api/voice/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'audio/webm' },
    // No Content-Length: a chunked upload that would otherwise bypass a header check.
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (let left = size; left > 0; left -= chunk) c.enqueue(new Uint8Array(Math.min(chunk, left)));
        c.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);

describe('POST /api/voice/transcribe', () => {
  it('rate limits per user and IP before touching the body', async () => {
    await POST(upload(2000));
    expect(limitLlm).toHaveBeenCalledWith(expect.any(Request), 'transcribe', 'u1');
  });

  it('accepts a normal clip', async () => {
    const res = await POST(upload(5000));
    expect(res.status).toBe(200);
    expect(transcribe).toHaveBeenCalled();
  });

  it('413s a chunked upload past the cap without sending it to Gemini', async () => {
    const res = await POST(upload(MAX_AUDIO_BYTES + 1_000_000));
    expect(res.status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('415s non-audio uploads', async () => {
    const req = new Request('https://app.example/x', { method: 'POST', headers: { 'content-type': 'text/html' }, body: 'x' });
    expect((await POST(req)).status).toBe(415);
  });
});
