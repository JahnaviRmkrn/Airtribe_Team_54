import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('./supabase/server', () => ({ userClient: vi.fn() }));
const { parseBody, readBodyLimited } = await import('./http');

const stream = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x)));
      c.close();
    },
  });
// A chunked upload: no Content-Length header, so only the streaming cap can stop it.
const chunked = (chunks: string[]) =>
  new Request('https://app.example/x', { method: 'POST', body: stream(chunks), duplex: 'half' } as RequestInit);

describe('readBodyLimited', () => {
  it('rejects a declared length over the cap without reading', async () => {
    const r = new Request('https://app.example/x', { method: 'POST', body: 'x'.repeat(50), headers: { 'content-length': '50' } });
    await expect(readBodyLimited(r, 10)).rejects.toMatchObject({ status: 413 });
  });

  it('stops a chunked body that grows past the cap', async () => {
    await expect(readBodyLimited(chunked(['aaaa', 'bbbb', 'cccc']), 10)).rejects.toMatchObject({ status: 413 });
  });

  it('returns the whole body when under the cap', async () => {
    const out = await readBodyLimited(chunked(['ab', 'cd']), 10);
    expect(new TextDecoder().decode(out)).toBe('abcd');
  });
});

describe('parseBody', () => {
  const schema = z.object({ a: z.string() });

  it('parses valid JSON', async () => {
    await expect(parseBody(chunked(['{"a":', '"b"}']), schema)).resolves.toEqual({ a: 'b' });
  });

  it('caps oversized JSON (default 64 KB) instead of buffering it', async () => {
    const big = chunked(['{"a":"', 'x'.repeat(70_000), '"}']);
    await expect(parseBody(big, schema)).rejects.toMatchObject({ status: 413 });
  });

  it('honours a larger per-route cap', async () => {
    const big = chunked(['{"a":"', 'x'.repeat(70_000), '"}']);
    await expect(parseBody(big, schema, 200_000)).resolves.toMatchObject({ a: expect.any(String) });
  });

  it('400s on bad JSON and on schema violations', async () => {
    await expect(parseBody(chunked(['{nope']), schema)).rejects.toMatchObject({ status: 400 });
    await expect(parseBody(chunked(['{"a":1}']), schema)).rejects.toMatchObject({ status: 400 });
  });
});
