import { contactBulk, contactCreate, category } from '@/lib/schemas';
import { dbError, handle, HttpError, ok, parseBody, requireUser } from '@/lib/http';
import { contactCreateRetryConfigured } from '@/lib/contact-create-retry';
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

// POST /api/me/contacts: one contact or { contacts: [...] } (max 5).
// New clients retain a UUID Idempotency-Key for one explicit create intent.
// Unkeyed legacy callers retain insert semantics; never deduplicate by name.
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const key = req.headers.get('Idempotency-Key');
  if (key !== null && !z.uuid().safeParse(key).success) throw new HttpError(400, 'Idempotency-Key must be a UUID');
  const expectedOwner = req.headers.get('X-Contact-Owner');
  if (expectedOwner !== null && expectedOwner !== user.id) throw new HttpError(409, 'Your signed-in account changed. Reload before saving.');
  // Strict keyed bodies prevent ignored ownership/field mutations from being
  // mistaken for an identical retry. Legacy bodies keep their original parsing.
  const schema = key === null ? z.union([contactBulk, contactCreate])
    : z.union([z.object({ contacts: z.array(contactCreate.strict()).min(1).max(5) }).strict(), contactCreate.strict()]);
  let body: z.infer<typeof schema>;
  try {
    body = await parseBody(req, schema);
  } catch (error) {
    // Explicitly distinguish our pre-RPC validation from transport/database
    // errors. Only a first-attempt rejection lets the client discard its key.
    if (error instanceof HttpError && error.status === 400) {
      return ok({ error: error.message, code: 'contact_input_rejected' }, 400);
    }
    throw error;
  }
  if (key !== null) {
    // A stale tab may still carry an unresolved key after rollback. Refuse it,
    // never silently downgrade to an unkeyed insert or discard its receipt.
    if (!contactCreateRetryConfigured()) {
      throw new HttpError(503, 'Safe contact saving is temporarily unavailable. Check Contacts or retry this same save after it is enabled.');
    }
    const { data, error } = await supabase.rpc('create_contacts_once', {
      p_intent: key, p_contacts: 'contacts' in body ? body.contacts : [body],
    });
    if (error?.message.includes('contact_intent_conflict')) throw new HttpError(409, 'This save key was already used for different contact details.');
    // A missing migration must never fall back to an unsafe insert.
    if (error?.code === 'PGRST202' || error?.code === '42883' || error?.code === '42P01') {
      throw new HttpError(503, 'Safe contact saving is not available yet. Please try again after the database update.');
    }
    dbError(error);
    return ok(data, 201);
  }
  const rows = ('contacts' in body ? body.contacts : [body]).map((c) => ({ ...c, user_id: user.id }));
  const { data, error } = await supabase.from('contacts').insert(rows).select('*');
  dbError(error);
  return ok({ contacts: data }, 201);
});
