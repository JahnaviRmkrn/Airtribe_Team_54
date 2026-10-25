import { isOverdue } from '@/lib/due';
import { handle, ok, requireUser } from '@/lib/http';
import { compareReadTimestamps, withCompleteReads } from '@/lib/complete-read';

const CATS = ['personal', 'professional', 'community'] as const;

// GET /api/me/dashboard -> everything the life-balance dashboard needs in one call.
// contact_counts and recorded_activity are deliberately separate measures:
// contact distribution is not relationship attention (PRD 6.2).
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const horizon = new Date(now.getTime() + 14 * 86_400_000).toISOString();

  return ok(await withCompleteReads(req, async (read) => {
    const [contacts, goals, interactions, meetups] = await Promise.all([
      read((after, signal, pageRows, verifyEmpty) => {
        let q = supabase.from('contacts').select('id, name, category, next_followup_at, last_interaction_at', verifyEmpty ? { count: 'exact', head: true } : undefined)
          .order('id').limit(pageRows).abortSignal(signal);
        if (after) q = q.gt('id', after);
        return q;
      }, (row) => row.id),
      read((after, signal, pageRows, verifyEmpty) => {
        let q = supabase.from('balance_goals').select('category, target_percentage', verifyEmpty ? { count: 'exact', head: true } : undefined)
          .order('category').limit(pageRows).abortSignal(signal);
        if (after) q = q.gt('category', after);
        return q;
      }, (row) => row.category, (a, b) => CATS.indexOf(a as typeof CATS[number]) - CATS.indexOf(b as typeof CATS[number])),
      read((after, signal, pageRows, verifyEmpty) => {
        let q = supabase.from('interactions').select('id, occurred_at, type, notes, contact:contacts(id, name, category)', verifyEmpty ? { count: 'exact', head: true } : undefined)
          .gte('occurred_at', since).lte('occurred_at', now.toISOString())
          .order('id').limit(pageRows).abortSignal(signal);
        if (after) q = q.gt('id', after);
        return q;
      }, (row) => row.id),
      // Upcoming = open, room not expired, and not already in the past
      // (unscheduled meetups with no starts_at stay visible).
      read((after, signal, pageRows, verifyEmpty) => {
        let q = supabase.from('meetups').select('id, title, activity, area, starts_at, status, room_token, final_venue_id', verifyEmpty ? { count: 'exact', head: true } : undefined)
          .eq('status', 'open').gt('expires_at', now.toISOString())
          .or(`starts_at.is.null,starts_at.gte.${now.toISOString()}`)
          .order('id').limit(pageRows).abortSignal(signal);
        if (after) q = q.gt('id', after);
        return q;
      }, (row) => row.id),
    ]);
    contacts.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    interactions.sort((a, b) => compareReadTimestamps(b.occurred_at, a.occurred_at) || a.id.localeCompare(b.id));
    meetups.sort((a, b) => {
      if (a.starts_at === null && b.starts_at !== null) return 1;
      if (a.starts_at !== null && b.starts_at === null) return -1;
      return (a.starts_at === null ? 0 : compareReadTimestamps(a.starts_at, b.starts_at)) || a.id.localeCompare(b.id);
    });

    const list = contacts;
    const count = (c: string) => list.filter((x) => x.category === c).length;
    const acts = interactions as unknown as { contact: { category: string } | null }[];
    const actCount = (c: string) => acts.filter((i) => i.contact?.category === c).length;

    return {
      goals: goals.length ? Object.fromEntries(goals.map((g) => [g.category, g.target_percentage])) : null,
      contact_counts: Object.fromEntries(CATS.map((c) => [c, count(c)])),
      recorded_activity: {
        label: 'Interactions recorded in the last 30 days',
        total: acts.length,
        by_category: Object.fromEntries(CATS.map((c) => [c, actCount(c)])),
        sufficient_data: acts.length >= 3,
      },
      contacts_by_category: Object.fromEntries(CATS.map((c) => [c, list.filter((x) => x.category === c)])),
      followups: {
        overdue: list.filter((c) => isOverdue(c.next_followup_at, now)),
        upcoming: list.filter((c) => c.next_followup_at && !isOverdue(c.next_followup_at, now) && compareReadTimestamps(c.next_followup_at, horizon) <= 0),
      },
      upcoming_meetups: meetups,
      recent_activity: interactions.slice(0, 10),
      is_empty: list.length === 0,
    };
  }));
});
