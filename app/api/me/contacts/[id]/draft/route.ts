import { draftMessage } from '@/lib/draft-llm';
import { dbError, handle, ok, requireUser } from '@/lib/http';
import { limitLlm } from '@/lib/ratelimit';

type Ctx = { params: Promise<{ id: string }> };

// POST /api/me/contacts/:id/draft  -> { message, source }
// Suggests a short check-in text for this contact (DeepSeek first, template as
// fallback). Stateless and never sends anything: the organizer shows it with
// Copy / Open in WhatsApp and the user decides. RLS scopes the contact lookup
// to the signed-in user, so nobody can draft from someone else's notes.
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { user, supabase } = await requireUser(req);
  await limitLlm(req, 'draft', user.id);
  const { data: contact, error } = await supabase
    .from('contacts')
    .select('name, category, interests, notes, last_interaction_at')
    .eq('id', id)
    .single();
  dbError(error);
  const { data: recent } = await supabase
    .from('interactions')
    .select('occurred_at, type, notes')
    .eq('contact_id', id)
    .order('occurred_at', { ascending: false })
    .limit(3);
  return ok(await draftMessage(contact!, recent ?? []));
});
