import { isOverdue } from '@/lib/due';
import { boundedInteger } from '@/lib/query';
import { dbError, handle, HttpError, ok, requireUser } from '@/lib/http';

// GET /api/me/followups?days=14 -> { overdue: [...], upcoming: [...] }
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const days = boundedInteger(new URL(req.url).searchParams.get('days'), 14, 365, 0);
  if (days === null) throw new HttpError(400, 'days must be a non-negative integer');
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('contacts')
    .select('id, name, category, next_followup_at, last_interaction_at')
    .not('next_followup_at', 'is', null)
    .lte('next_followup_at', horizon)
    .order('next_followup_at');
  dbError(error);
  return ok({
    overdue: (data ?? []).filter((c) => isOverdue(c.next_followup_at, now)),
    upcoming: (data ?? []).filter((c) => !isOverdue(c.next_followup_at, now)),
  });
});
