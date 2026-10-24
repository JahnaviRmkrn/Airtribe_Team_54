import { boundedInteger } from '@/lib/query';
import { interactionCreate } from '@/lib/schemas';
import { dbError, handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';

// GET /api/me/interactions?limit=20 -> recent activity (with contact name/category)
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const limit = boundedInteger(new URL(req.url).searchParams.get('limit'), 20, 100);
  if (limit === null) throw new HttpError(400, 'limit must be a positive integer');
  const { data, error } = await supabase
    .from('interactions')
    .select('*, contact:contacts(id, name, category)')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  dbError(error);
  return ok({ interactions: data });
});

// POST /api/me/interactions  -> records an interaction / completes a follow-up.
// One transaction (record_interaction, contact row locked): last_interaction_at
// only moves forward; next_followup_at is set if given, otherwise advanced by
// preferred_frequency_days only when this interaction is the newest.
export const POST = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const body = await parseBody(req, interactionCreate);
  const { data, error } = await supabase.rpc('record_interaction', {
    p_contact_id: body.contact_id,
    p_occurred_at: body.occurred_at ?? new Date().toISOString(),
    p_type: body.type,
    p_notes: body.notes ?? null,
    p_next_followup_at: body.next_followup_at ?? null,
    p_set_next: body.next_followup_at !== undefined,
  });
  if (error?.message.includes('contact not found')) throw new HttpError(404, 'Not found');
  dbError(error);
  return ok(data, 201);
});
