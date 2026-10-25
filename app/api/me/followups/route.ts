import { isOverdue } from '@/lib/due';
import { boundedInteger } from '@/lib/query';
import { handle, HttpError, ok, requireUser } from '@/lib/http';
import { compareReadTimestamps, withCompleteReads } from '@/lib/complete-read';

// GET /api/me/followups?days=14 -> { overdue: [...], upcoming: [...] }
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const days = boundedInteger(new URL(req.url).searchParams.get('days'), 14, 365, 0);
  if (days === null) throw new HttpError(400, 'days must be a non-negative integer');
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86_400_000).toISOString();
  return ok(await withCompleteReads(req, async (read) => {
    const data = await read((after, signal, pageRows, verifyEmpty) => {
      let q = supabase.from('contacts').select('id, name, category, next_followup_at, last_interaction_at', verifyEmpty ? { count: 'exact', head: true } : undefined)
        .not('next_followup_at', 'is', null).lte('next_followup_at', horizon)
        .order('id').limit(pageRows).abortSignal(signal);
      if (after) q = q.gt('id', after);
      return q;
    }, (row) => row.id);
    data.sort((a, b) => compareReadTimestamps(a.next_followup_at, b.next_followup_at) || a.id.localeCompare(b.id));
    return {
      overdue: data.filter((c) => isOverdue(c.next_followup_at, now)),
      upcoming: data.filter((c) => !isOverdue(c.next_followup_at, now)),
    };
  }));
});
