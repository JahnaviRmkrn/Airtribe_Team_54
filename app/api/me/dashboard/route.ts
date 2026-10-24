import { dbError, handle, ok, requireUser } from '@/lib/http';

const CATS = ['personal', 'professional', 'community'] as const;

// GET /api/me/dashboard -> everything the life-balance dashboard needs in one call.
// contact_counts and recorded_activity are deliberately separate measures:
// contact distribution is not relationship attention (PRD 6.2).
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const horizon = new Date(now.getTime() + 14 * 86_400_000).toISOString();

  const [contacts, goals, interactions, meetups] = await Promise.all([
    supabase.from('contacts').select('id, name, category, next_followup_at, last_interaction_at').order('name'),
    supabase.from('balance_goals').select('category, target_percentage'),
    supabase
      .from('interactions')
      .select('id, occurred_at, type, notes, contact:contacts(id, name, category)')
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false }),
    // Upcoming = open, room not expired, and not already in the past
    // (unscheduled meetups with no starts_at stay visible).
    supabase
      .from('meetups')
      .select('id, title, activity, area, starts_at, status, room_token, final_venue_id')
      .eq('status', 'open')
      .gt('expires_at', now.toISOString())
      .or(`starts_at.is.null,starts_at.gte.${now.toISOString()}`)
      .order('starts_at', { ascending: true, nullsFirst: false }),
  ]);
  [contacts, goals, interactions, meetups].forEach((r) => dbError(r.error));

  const list = contacts.data ?? [];
  const count = (c: string) => list.filter((x) => x.category === c).length;
  const acts = (interactions.data ?? []) as unknown as { contact: { category: string } | null }[];
  const actCount = (c: string) => acts.filter((i) => i.contact?.category === c).length;
  const iso = now.toISOString();

  return ok({
    goals: goals.data?.length ? Object.fromEntries(goals.data.map((g) => [g.category, g.target_percentage])) : null,
    contact_counts: Object.fromEntries(CATS.map((c) => [c, count(c)])),
    recorded_activity: {
      label: 'Interactions recorded in the last 30 days',
      total: acts.length,
      by_category: Object.fromEntries(CATS.map((c) => [c, actCount(c)])),
      sufficient_data: acts.length >= 3,
    },
    contacts_by_category: Object.fromEntries(CATS.map((c) => [c, list.filter((x) => x.category === c)])),
    followups: {
      overdue: list.filter((c) => c.next_followup_at && c.next_followup_at < iso),
      upcoming: list.filter((c) => c.next_followup_at && c.next_followup_at >= iso && c.next_followup_at <= horizon),
    },
    upcoming_meetups: meetups.data ?? [],
    recent_activity: (interactions.data ?? []).slice(0, 10),
    is_empty: list.length === 0,
  });
});
