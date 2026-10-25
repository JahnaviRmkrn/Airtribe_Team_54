import { classify, maxBytesFor, MAX_VCF_BYTES, readCappedText } from '@/lib/import';
import { loadExisting, loadStaged, parseUpload } from '@/lib/import-db';
import { parsePickedContacts } from '@/lib/import-google';
import { handle, HttpError, ok, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { importPreview } from '@/lib/schemas';

// POST /api/me/contacts/import/preview
//   body: { source, content }   file text (LinkedIn/Facebook/Google CSV, .vcf, ...)
//      or { source: 'android', picks: [{ name, email, tel }] }   Contact Picker result
//      or { source: 'facebook' | 'google', staged: true }   friends/contacts fetched at sign-in
// -> { rows: [{ name, email, phone, source_ref, company, position, notes, verdict: 'new'|'update'|'duplicate' }], truncated }
// Parses and dedupes only: nothing is written. Rows are third-party PII, so they are never logged.
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  await limitUser('import', user.id);
  const text = await readCappedText(req, MAX_VCF_BYTES + 1_000_000);
  if (text === null) throw new HttpError(413, 'File is too large');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  const r = importPreview.safeParse(json);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  const body = r.data;

  let parsed;
  if ('content' in body) {
    const max = maxBytesFor(body.source);
    if (Buffer.byteLength(body.content) > max) throw new HttpError(413, `File is too large (max ${max / 1024 / 1024} MB)`);
    parsed = parseUpload(body.source, body.content);
  } else if ('staged' in body) {
    parsed = await loadStaged(supabase, body.source);
    if (!parsed) throw new HttpError(404, 'Nothing is waiting to import');
  } else {
    parsed = parsePickedContacts(body.picks);
  }

  const verdicts = classify(await loadExisting(supabase), parsed.rows, body.source);
  return ok({ rows: parsed.rows.map((row, i) => ({ ...row, verdict: verdicts[i] })), truncated: parsed.truncated });
});
