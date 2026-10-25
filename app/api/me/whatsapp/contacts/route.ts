import { handle, ok, requireUser } from '@/lib/http';
import { limitUser } from '@/lib/ratelimit';
import { bridge } from '@/lib/whatsapp';

type BridgeContact = { jid: string; name: string; phone: string | null };

// GET /api/me/whatsapp/contacts?q=&offset=&limit=
// The import preview: the person's synced WhatsApp contacts (names and
// numbers come from the bridge, never from the client) plus their groups,
// with `imported` set for people already in muop.
export const GET = handle(async (req: Request) => {
  const { supabase, user } = await requireUser(req);
  await limitUser('waImport', user.id);
  const sp = new URL(req.url).searchParams;
  const qs = new URLSearchParams({
    q: (sp.get('q') ?? '').slice(0, 80),
    limit: String(Math.min(200, Number(sp.get('limit')) || 50)),
    offset: String(Math.max(0, Number(sp.get('offset')) || 0)),
  });
  const [list, groups] = await Promise.all([
    bridge<{ total: number; contacts: BridgeContact[] }>(`/sessions/${user.id}/contacts?${qs}`),
    bridge<{ groups: { jid: string; subject: string; size: number }[] }>(`/sessions/${user.id}/groups`),
  ]);
  const jids = list.contacts.map((c) => c.jid);
  const have = new Set<string>();
  if (jids.length) {
    const { data } = await supabase.from('contacts').select('source_ref').eq('source', 'whatsapp').in('source_ref', jids);
    for (const r of data ?? []) have.add(r.source_ref);
  }
  return ok({
    total: list.total,
    contacts: list.contacts.map((c) => ({ ...c, imported: have.has(c.jid) })),
    groups: groups.groups,
  });
});
