import { goalsPut } from '@/lib/schemas';
import { dbError, handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';

type Goals = { personal: number; professional: number; community: number };

// GET /api/me/goals -> { goals: {personal, professional, community} | null }
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const { data, error } = await supabase.from('balance_goals').select('category, target_percentage');
  dbError(error);
  const goals = data?.length
    ? (Object.fromEntries(data.map((g) => [g.category, g.target_percentage])) as Goals)
    : null;
  return ok({ goals });
});

// PUT /api/me/goals  body: { personal, professional, community } (must total 100)
export const PUT = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  // Onboarding saves goals before contacts. Bind this first mutation to the
  // same displayed account, not whichever session another tab switched to.
  const expectedOwner = req.headers.get('X-Contact-Owner');
  if (expectedOwner !== null && expectedOwner !== user.id) throw new HttpError(409, 'Your signed-in account changed. Reload before saving.');
  const g = await parseBody(req, goalsPut);
  const rows = (Object.keys(g) as (keyof Goals)[]).map((category) => ({
    user_id: user.id,
    category,
    target_percentage: g[category],
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('balance_goals').upsert(rows);
  dbError(error);
  return ok({ goals: g });
});
