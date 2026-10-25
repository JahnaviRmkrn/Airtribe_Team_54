import { BATCH_SIZE, classify, readCappedText } from '@/lib/import';
import { loadExisting } from '@/lib/import-db';
import { dbError, handle, HttpError, ok, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { importConfirm } from '@/lib/schemas';

// POST /api/me/contacts/import  body: { source, category, contacts: [<=5000 rows from the preview], clear_staged? }
// -> { inserted, updated, skipped }
// Re-checks every row against the current contacts (so a replayed or stale
// confirm cannot duplicate anyone), then inserts in batches through the
// import_contacts() SQL function: rows with a source_ref already imported are
// refreshed, the rest are inserted. RLS scopes everything to the signed-in user.
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  await limitUser('import', user.id);
  const text = await readCappedText(req, 6_000_000);
  if (text === null) throw new HttpError(413, 'Too many contacts in one request');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  const r = importConfirm.safeParse(json);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const { source, category, contacts, clear_staged } = r.data;

  const verdicts = classify(await loadExisting(supabase), contacts, source);
  const todo = contacts.filter((_, i) => verdicts[i] !== 'duplicate');
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const { data, error } = await supabase.rpc('import_contacts', { p_source: source, p_category: category, p_rows: todo.slice(i, i + BATCH_SIZE) });
    dbError(error);
    inserted += data?.inserted ?? 0;
    updated += data?.updated ?? 0;
  }
  if (clear_staged) await supabase.from('contact_import_stage').delete().eq('source', clear_staged);
  return ok({ inserted, updated, skipped: contacts.length - todo.length }, 201);
});
