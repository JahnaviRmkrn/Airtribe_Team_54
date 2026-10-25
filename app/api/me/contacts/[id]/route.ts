import { contactUpdate } from '@/lib/schemas';
import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';
import { compareReadTimestamps, withCompleteReads } from '@/lib/complete-read';

type Ctx = { params: Promise<{ id: string }> };

// GET /api/me/contacts/:id  -> contact + interaction history
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const { supabase } = await requireUser(req);
  const { data: contact, error } = await supabase.from('contacts').select('*').eq('id', id).single();
  dbError(error);
  return ok(await withCompleteReads(req, async (read) => {
    const interactions = await read((after, signal, pageRows, verifyEmpty) => {
      let q = supabase.from('interactions').select('*', verifyEmpty ? { count: 'exact', head: true } : undefined)
        .eq('contact_id', id).order('id').limit(pageRows).abortSignal(signal);
      if (after) q = q.gt('id', after);
      return q;
    }, (row) => row.id);
    interactions.sort((a, b) => compareReadTimestamps(b.occurred_at, a.occurred_at) || a.id.localeCompare(b.id));
    return { contact, interactions };
  }));
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
