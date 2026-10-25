import { dbError, handle, ok, parseBody, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { bridge, importBody, phoneFromJid } from '@/lib/whatsapp';

// POST /api/me/whatsapp/import  { jids: [...], category? }   (max 200)
// Confirm step of preview -> pick -> confirm. Only JIDs travel from the
// client; names and numbers are re-read from the bridge. Re-importing a
// person is a no-op.
export const POST = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  const body = await parseBody(req, importBody);
  await limitUser('waImport', user.id);
  const found = await bridge<{ contacts: { jid: string; name: string; phone: string | null }[] }>(`/sessions/${user.id}/lookup`, {
    method: 'POST',
    body: { jids: body.jids },
  });
  const { data: existing, error: e1 } = await supabase.from('contacts').select('source_ref').eq('source', 'whatsapp').in('source_ref', body.jids);
  dbError(e1);
  const have = new Set((existing ?? []).map((r) => r.source_ref));
  const rows = found.contacts
    .filter((c) => !have.has(c.jid))
    .map((c) => {
      const phone = phoneFromJid(c.jid);
      return {
        user_id: user.id,
        name: (c.name || phone || 'WhatsApp contact').slice(0, 120),
        category: body.category,
        interests: [],
        source: 'whatsapp',
        source_ref: c.jid,
        phone,
      };
    });
  if (rows.length) {
    const { error } = await supabase.from('contacts').insert(rows);
    dbError(error);
  }
  return ok({ imported: rows.length, skipped: body.jids.length - rows.length }, 201);
});
