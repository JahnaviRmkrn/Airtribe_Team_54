import { interactionCreate } from '@/lib/schemas';
import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';

// GET /api/me/interactions?limit=20 -> recent activity (with contact name/category)
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit')) || 20, 100);
  const { data, error } = await supabase
    .from('interactions')
    .select('*, contact:contacts(id, name, category)')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  dbError(error);
  return ok({ interactions: data });
});

// POST /api/me/interactions  -> records an interaction / completes a follow-up.
// Updates the contact's last_interaction_at, and next_followup_at if given
// (otherwise advances it by preferred_frequency_days when set).
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const { next_followup_at, ...body } = await parseBody(req, interactionCreate);
  const occurred_at = body.occurred_at ?? new Date().toISOString();

  const { data: found, error: cErr } = await supabase
    .from('contacts')
    .select('id, preferred_frequency_days, last_interaction_at')
    .eq('id', body.contact_id)
    .single();
  dbError(cErr);
  const contact = found!;

  const { data: interaction, error } = await supabase
    .from('interactions')
    .insert({ ...body, occurred_at, user_id: user.id })
    .select('*')
    .single();
  dbError(error);

  const patch: Record<string, string | null> = {};
  if (!contact.last_interaction_at || contact.last_interaction_at < occurred_at) patch.last_interaction_at = occurred_at;
  if (next_followup_at !== undefined) patch.next_followup_at = next_followup_at;
  else if (contact.preferred_frequency_days) {
    patch.next_followup_at = new Date(Date.parse(occurred_at) + contact.preferred_frequency_days * 86_400_000).toISOString();
  }
  const { data: updated, error: uErr } = await supabase
    .from('contacts')
    .update(patch)
    .eq('id', contact.id)
    .select('*')
    .single();
  dbError(uErr);

  return ok({ interaction, contact: updated }, 201);
});
