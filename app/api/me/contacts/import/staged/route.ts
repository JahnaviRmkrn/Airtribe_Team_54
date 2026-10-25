import { STAGE_TTL_DAYS } from '@/lib/import-db';
import { dbError, handle, HttpError, ok, requireUser } from '@/lib/http';

// GET /api/me/contacts/import/staged -> { facebook: n, google: n }
// How many friends/contacts fetched at sign-in are waiting for review (expire after a week).
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const since = new Date(Date.now() - STAGE_TTL_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('contact_import_stage').select('source,rows').gte('created_at', since);
  dbError(error);
  const counts = { facebook: 0, google: 0 };
  for (const s of data ?? []) if (s.source in counts && Array.isArray(s.rows)) counts[s.source as keyof typeof counts] = s.rows.length;
  return ok(counts);
});

// DELETE /api/me/contacts/import/staged?source=facebook|google  (dismiss without importing)
export const DELETE = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const source = new URL(req.url).searchParams.get('source');
  if (source !== 'facebook' && source !== 'google') throw new HttpError(400, 'source must be facebook or google');
  dbError((await supabase.from('contact_import_stage').delete().eq('source', source)).error);
  return ok({ ok: true });
});
