import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ userClient: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ userClient: deps.userClient }));
import { POST } from '../app/api/me/meetups/route';
const originalTZ = process.env.TZ;
afterEach(() => { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; });
beforeEach(() => {
  deps.userClient.mockImplementation(async () => {
    let inserted;
    const query = { insert: (value) => { inserted = value; return query; }, select: () => query,
      single: async () => ({ data: { ...inserted, room_token: 'synthetic-invite-token-001' }, error: null }) };
    return { auth: { getUser: async () => ({ data: { user: { id: 'synthetic-owner' } }, error: null }) }, from: () => query };
  });
});
async function create(starts_at) {
  const response = await POST(new Request('https://example.test/api/me/meetups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Synthetic late-night tea', ...(starts_at === undefined ? {} : { starts_at }) }),
  }));
  expect(response.status).toBe(201); return response.json();
}
describe('shared meetup invitation timezone', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland'])('uses explicit Bengaluru time independently of server TZ=%s', async (timezone) => {
    process.env.TZ = timezone;
    const result = await create('2026-10-25T20:00:00Z');
    expect(result.invite_text).toContain('26 Oct 2026');
    expect(result.invite_text).toContain('01:30');
    expect(result.invite_text).toContain('IST (Asia/Kolkata)');
    expect(result.meetup.starts_at).toBe('2026-10-25T20:00:00Z');
  });
  it.each([undefined, null])('does not invent a date for unscheduled meetup %s', async (startsAt) => {
    const result = await create(startsAt);
    expect(result.invite_text).toBe('Join "Synthetic late-night tea"! Add your preferences and vote on a place: https://example.test/m/synthetic-invite-token-001');
  });
  it('preserves explicit offset input while displaying the same instant in IST', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const result = await create('2026-10-26T01:30:00+05:30');
    expect(result.invite_text).toContain('26 Oct 2026'); expect(result.invite_text).toContain('01:30');
    expect(result.invite_text).toContain('IST (Asia/Kolkata)');
    expect(result.meetup.starts_at).toBe('2026-10-26T01:30:00+05:30');
  });
  it('shows the start of an IST day without changing the stored instant', async () => {
    process.env.TZ = 'UTC';
    const result = await create('2026-12-31T18:30:00Z');
    expect(result.invite_text).toContain('1 Jan 2027');
    expect(result.invite_text).toContain('00:00');
    expect(result.meetup.starts_at).toBe('2026-12-31T18:30:00Z');
  });
});
