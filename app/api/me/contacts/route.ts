import { contactBulk, contactCreate, category } from '@/lib/schemas';
import { dbError, handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { z } from 'zod';

// GET /api/me/contacts?category=personal
export const GET = handle(async (req: Request) => {
  const { supabase } = await requireUser(req);
  const cat = new URL(req.url).searchParams.get('category');
  let q = supabase.from('contacts').select('*').order('name');
  if (cat) {
    const parsed = category.safeParse(cat);
    if (!parsed.success) throw new HttpError(400, 'category must be personal, professional or community');
    q = q.eq('category', parsed.data);
  }
  const { data, error } = await q;
  dbError(error);
  return ok({ contacts: data });
});

// POST /api/me/contacts  body: one contact, or { contacts: [...] } (max 5, onboarding confirm)
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const body = await parseBody(req, z.union([contactBulk, contactCreate]));
  const rows = ('contacts' in body ? body.contacts : [body]).map((c) => ({ ...c, user_id: user.id }));
  const { data, error } = await supabase.from('contacts').insert(rows).select('*');
  dbError(error);
  return ok({ contacts: data }, 201);
});
