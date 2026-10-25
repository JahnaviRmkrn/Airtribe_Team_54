import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('server-only', () => ({}));
vi.mock('./supabase/admin', () => ({ adminClient: () => ({ rpc }) }));

const { clientIp, rateLimit, rateLimitKey, limitRoom, limitLlm, LIMITS } = await import('./ratelimit');
const { HttpError } = await import('./http');

const req = (headers: Record<string, string> = {}) => new Request('https://app.example/api/rooms/t', { headers });

describe('clientIp', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prefers the Cloudflare header over a client-forged x-forwarded-for', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('never trusts the first (client-controlled) x-forwarded-for entry', () => {
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': ' 203.0.113.7 ' }))).toBe('203.0.113.7');
  });

  it('on Vercel ignores cf-connecting-ip (client-sendable there) and uses the platform header', () => {
    vi.stubEnv('VERCEL', '1');
    expect(clientIp(req({ 'cf-connecting-ip': '6.6.6.6', 'x-vercel-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(clientIp(req({ 'cf-connecting-ip': '6.6.6.6', 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
  });

  it('falls back to x-real-ip, then unknown', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(req({ 'x-forwarded-for': ' ' }))).toBe('unknown');
    expect(clientIp(req())).toBe('unknown');
  });

  it('buckets IPv6 clients by /64 so a prefix cannot be rotated through', () => {
    const a = clientIp(req({ 'cf-connecting-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }));
    const b = clientIp(req({ 'cf-connecting-ip': '2001:db8:1:2::1' }));
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:1:2::/64');
    expect(clientIp(req({ 'cf-connecting-ip': '2001:db8::1' }))).toBe('2001:db8:0:0::/64');
    expect(clientIp(req({ 'cf-connecting-ip': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
  });
});

describe('rateLimitKey', () => {
  const r = req({ 'cf-connecting-ip': '203.0.113.7' });

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

describe('aggregate buckets', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: true, error: null }));

  it('limitRoom also counts the client IP across all rooms (random-token probing)', async () => {
    await limitRoom(req({ 'cf-connecting-ip': '203.0.113.7' }), 'view', 'tok');
    const keys = rpc.mock.calls.map((c) => c[1].p_key);
    expect(keys).toContain('view:203.0.113.7:tok');
    expect(keys).toContain('roomIp:203.0.113.7');
  });

  it('limitRoom rejects when only the IP-wide bucket is exhausted', async () => {
    rpc.mockImplementation(async (...args: unknown[]) => ({ data: !JSON.stringify(args).includes('roomIp'), error: null }));
    await expect(limitRoom(req(), 'view', 'tok')).rejects.toMatchObject({ status: 429 });
  });

  it('limitLlm counts both the user and the client IP', async () => {
    await limitLlm(req({ 'cf-connecting-ip': '203.0.113.7' }), 'extract', 'user-1');
    const keys = rpc.mock.calls.map((c) => c[1].p_key);
    expect(keys).toContain('extract:user:user-1');
    expect(keys).toContain('llmIp:203.0.113.7');
  });
});
