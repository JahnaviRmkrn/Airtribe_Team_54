import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('server-only', () => ({}));
vi.mock('./supabase/admin', () => ({ adminClient: () => ({ rpc }) }));

const { clientIp, rateLimit, rateLimitKey, LIMITS } = await import('./ratelimit');
const { HttpError } = await import('./http');

const req = (headers: Record<string, string> = {}) => new Request('https://app.example/api/rooms/t', { headers });

describe('clientIp', () => {
  it('takes the first x-forwarded-for entry', () => {
    expect(clientIp(req({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1', 'x-real-ip': '198.51.100.2' }))).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then unknown', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(req({ 'x-forwarded-for': ' ' }))).toBe('unknown');
    expect(clientIp(req())).toBe('unknown');
  });
});

describe('rateLimitKey', () => {
  const r = req({ 'x-forwarded-for': '203.0.113.7' });

  it('joins bucket, ip and extra key', () => {
    expect(rateLimitKey(r, 'join', 'tok123')).toBe('join:203.0.113.7:tok123');
    expect(rateLimitKey(r, 'joinHourly')).toBe('joinHourly:203.0.113.7');
  });

  it('caps the extra key length', () => {
    expect(rateLimitKey(r, 'view', 'x'.repeat(500))).toBe(`view:203.0.113.7:${'x'.repeat(100)}`);
  });
});

describe('rateLimit', () => {
  beforeEach(() => rpc.mockReset());

  it('passes when allowed', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(rateLimit(req(), 'view', LIMITS.view, 'tok')).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('hit_rate_limit', { p_key: 'view:unknown:tok', p_window_seconds: 60, p_max: 120 });
  });

  it('throws 429 when over the limit', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    const err = await rateLimit(req(), 'view', LIMITS.view).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
  });

  it('fails open when the RPC errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(rateLimit(req(), 'view', LIMITS.view)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
