import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { readTractionData, unstable_cache } = vi.hoisted(() => ({
  readTractionData: vi.fn(),
  unstable_cache: vi.fn((load: () => unknown) => load),
}));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => ({}) }));
vi.mock('@/lib/traction-read', () => ({ readTractionData }));
vi.mock('next/cache', () => ({ unstable_cache }));

describe('TractionPage accuracy disclosures', () => {
  it('visibly separates unverified visits and explains that sharing has no recorded time', async () => {
    const { default: TractionPage } = await import('../app/traction/page');
    readTractionData.mockResolvedValue({
      meetups: [{ id: 'unknown', organizer_email: null }],
      attendees: [
        { id: 'a', meetup_id: 'unknown', guest_name: 'A', joined_at: '2026-10-24T06:00:00.000Z' },
        { id: 'b', meetup_id: 'missing', guest_name: 'B', joined_at: '2026-10-24T06:01:00.000Z' },
      ],
      votes: [],
    });
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('2 visits are excluded because the room or organizer could not be verified; totals may be incomplete.');
    expect(html.indexOf('totals may be incomplete')).toBeLessThan(html.indexOf('<h1>'));
    expect(html).toContain('Not counted: 0 test visits');
    expect(html).toContain('Sharing is counted from current saved preferences or availability.');
    expect(html).toContain('The original sharing time is not recorded');
    expect(unstable_cache).toHaveBeenCalledWith(expect.any(Function), ['traction-ledger'], { revalidate: 15 });
  });

  it('shows the load-error state instead of misleading incomplete totals', async () => {
    const { default: TractionPage } = await import('../app/traction/page');
    readTractionData.mockRejectedValue(new Error('too many rows to count'));
    const html = renderToStaticMarkup(await TractionPage());
    expect(html).toContain('Couldn&#x27;t load the numbers right now.');
    expect(html).not.toContain('planned a meetup');
  });
});
