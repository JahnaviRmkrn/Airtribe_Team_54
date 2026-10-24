import { contactUpdate } from '@/lib/schemas';
import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

// GET /api/me/contacts/:id  -> contact + interaction history
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const { data: contact, error } = await supabase.from('contacts').select('*').eq('id', id).single();
  dbError(error);
  const { data: interactions } = await supabase
    .from('interactions')
    .select('*')
    .eq('contact_id', id)
    .order('occurred_at', { ascending: false });
  return ok({ contact, interactions: interactions ?? [] });
});

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const body = await parseBody(req, contactUpdate);
  const { data, error } = await supabase.from('contacts').update(body).eq('id', id).select('*').single();
  dbError(error);
  return ok({ contact: data });
});

export const DELETE = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const { data, error } = await supabase.from('contacts').delete().eq('id', id).select('id').single();
  dbError(error);
  return ok({ deleted: data!.id });
});
