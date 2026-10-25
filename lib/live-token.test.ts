import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { mintLiveToken } = await import('./live-token');

describe('mintLiveToken', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  const call = async (ttl?: number) => {
    vi.stubEnv('GEMINI_API_KEY', 'k');
    const fetchMock = vi.fn(async (...a: [string, RequestInit]) => (a.length, new Response(JSON.stringify({ name: 'auth_tokens/abc' }))));
    vi.stubGlobal('fetch', fetchMock);
    const before = Date.now();
    await mintLiveToken(ttl);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    return { body, before };
  };

  it('is single-use, must be opened within a minute, and is locked to the Live model + audio', async () => {
    const { body, before } = await call();
    expect(body.uses).toBe(1);
    expect(Date.parse(body.newSessionExpireTime) - before).toBeLessThanOrEqual(61_000);
    expect(body.bidiGenerateContentSetup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(body.bidiGenerateContentSetup.model).toMatch(/^models\//);
  });

  it('defaults to 30 minutes for organisers and honours a shorter TTL for room guests', async () => {
    const org = await call();
    const guest = await call(10);
    const mins = (x: { body: { expireTime: string }; before: number }) => Math.round((Date.parse(x.body.expireTime) - x.before) / 60_000);
    expect(mins(org)).toBe(30);
    expect(mins(guest)).toBe(10);
  });
});
