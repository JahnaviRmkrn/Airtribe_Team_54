import { beforeEach, describe, expect, it, vi } from 'vitest';

const UID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
process.env.WA_SESSION_KEY = 'ab'.repeat(32);
process.env.WA_BRIDGE_SECRET = 's'.repeat(40);

const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  userResults: [] as unknown[], // queued results for the signed-in user's supabase client
  inserted: [] as unknown[],
  admin: { rows: new Map<string, Record<string, unknown>>(), deleted: [] as string[], upserts: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] },
  smsCalls: [] as { url: string; username: string; body: string }[],
}));

vi.mock('@/lib/ratelimit', () => ({ limitUser: mocks.limit }));
vi.mock('@/lib/http', async (orig) => {
  const real = await orig<typeof import('@/lib/http')>();
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) chain[m] = () => chain;
  chain.insert = (rows: unknown) => { mocks.inserted.push(rows); return chain; };
  chain.maybeSingle = async () => mocks.userResults.shift();
  chain.then = (res: (v: unknown) => void) => res(mocks.userResults.shift() ?? { data: [], error: null });
  return { ...real, requireUser: async () => ({ supabase: { from: () => chain }, user: { id: UID } }) };
});
vi.mock('@/lib/supabase/admin', () => ({
  adminClient: () => ({
    from: () => {
      let kind: string | undefined;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, v: string) => { if (col === 'kind') kind = v; return q; };
      q.upsert = async (row: Record<string, unknown>) => { mocks.admin.upserts.push(row); mocks.admin.rows.set(String(row.kind), row); return { error: null }; };
      q.update = (row: Record<string, unknown>) => { mocks.admin.updates.push(row); return q; };
      q.delete = () => { q.deleting = true; return q; };
      q.maybeSingle = async () => ({ data: mocks.admin.rows.get(String(kind)) ?? null });
      q.then = (res: (v: unknown) => void) => {
        if (q.deleting) mocks.admin.deleted.push(String(kind));
        res({ data: [...mocks.admin.rows.values()], error: null });
      };
      return q;
    },
  }),
}));

type Call = { path: string; method: string; body?: Record<string, unknown> };
const bridgeCalls: Call[] = [];
let bridgeReply: (c: Call) => { status?: number; json: unknown } = () => ({ json: {} });
vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
  const call = { path: url.replace('http://127.0.0.1:3010', ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
  expect((init.headers as Record<string, string>)['x-wa-bridge-secret']).toBe('s'.repeat(40));
  bridgeCalls.push(call);
  const r = bridgeReply(call);
  if (r.status === -1) throw new Error('ECONNREFUSED');
  return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
}));

const post = (path: string, body: unknown) => new Request('http://app' + path, { method: 'POST', body: JSON.stringify(body) });
const get = (path: string) => new Request('http://app' + path);

const { POST: link } = await import('../app/api/me/whatsapp/link/route');
const { GET: status } = await import('../app/api/me/whatsapp/status/route');
const { POST: unlink } = await import('../app/api/me/whatsapp/unlink/route');
const { GET: preview } = await import('../app/api/me/whatsapp/contacts/route');
const { POST: importPeople } = await import('../app/api/me/whatsapp/import/route');
const { POST: send } = await import('../app/api/me/send/route');
const { POST: waSend } = await import('../app/api/me/whatsapp/send/route');
const { POST: smsLink } = await import('../app/api/me/sms/link/route');
const { POST: smsTest } = await import('../app/api/me/sms/test/route');
const { GET: channels } = await import('../app/api/me/channels/route');
const { pickChannel, availableChannels, loadSmsCreds } = await import('./channels');
const sms = await import('./sms-gateway');
const { contactJid, phoneFromJid } = await import('./whatsapp');

beforeEach(() => {
  mocks.limit.mockReset();
  mocks.userResults.length = 0;
  mocks.inserted.length = 0;
  mocks.admin.rows.clear();
  mocks.admin.deleted.length = 0;
  mocks.admin.upserts.length = 0;
  mocks.admin.updates.length = 0;
  bridgeCalls.length = 0;
  bridgeReply = () => ({ json: {} });
});

describe('whatsapp link / status / unlink', () => {
  it('will not start without the accepted warning', async () => {
    const res = await link(post('/x', {}));
    expect(res.status).toBe(400);
    expect(bridgeCalls).toHaveLength(0);
    expect(mocks.admin.upserts).toHaveLength(0);
  });

  it('records consent, starts the bridge session and returns only public fields', async () => {
    bridgeReply = () => ({ json: { state: 'waiting_qr', qr: 'QR-STRING', internal: 'x', counts: { contacts: 0, groups: 0 } } });
    const res = await link(post('/x', { accept: true, phone: '+91 98765-43210' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ state: 'waiting_qr', qr: 'QR-STRING' });
    expect(json.internal).toBeUndefined();
    expect(mocks.limit).toHaveBeenCalledWith('waLink', UID);
    expect(mocks.admin.upserts[0]).toMatchObject({ user_id: UID, kind: 'whatsapp', status: 'connecting' });
    expect(bridgeCalls[0]).toEqual({ path: `/sessions/${UID}/start`, method: 'POST', body: { phone: '919876543210' } });
  });

  it('rejects a malformed pairing phone', async () => {
    expect((await link(post('/x', { accept: true, phone: 'abc' }))).status).toBe(400);
  });

  it('reports logged_out when the bridge forgot a session that was connected', async () => {
    mocks.admin.rows.set('whatsapp', { status: 'connected' });
    bridgeReply = () => ({ json: { state: 'unlinked' } });
    const json = await (await status(get('/x'))).json();
    expect(json).toMatchObject({ state: 'logged_out', error: 'logged_out' });
    expect(mocks.admin.updates[0]).toMatchObject({ status: 'logged_out' });
  });

  it('falls back to error (not a stale "connected") when the bridge is down', async () => {
    mocks.admin.rows.set('whatsapp', { status: 'connected' });
    bridgeReply = () => ({ status: -1, json: {} });
    expect(await (await status(get('/x'))).json()).toMatchObject({ state: 'error', bridge_up: false });
  });

  it('unlink asks the bridge to wipe and deletes the row; says so if it could not wipe', async () => {
    let json = await (await unlink(post('/x', {}))).json();
    expect(json).toEqual({ unlinked: true, wiped: true });
    expect(bridgeCalls[0]).toMatchObject({ path: `/sessions/${UID}`, method: 'DELETE' });
    expect(mocks.admin.deleted).toContain('whatsapp');
    bridgeReply = () => ({ status: -1, json: {} });
    json = await (await unlink(post('/x', {}))).json();
    expect(json).toEqual({ unlinked: true, wiped: false });
  });
});

describe('whatsapp import', () => {
  it('previews contacts with imported flags and groups', async () => {
    bridgeReply = (c) => c.path.includes('/groups')
      ? { json: { groups: [{ jid: '120363000000000001@g.us', subject: 'Climbing', size: 4 }] } }
      : { json: { total: 2, contacts: [{ jid: '919000000001@s.whatsapp.net', name: 'Asha', phone: '919000000001' }, { jid: '919000000002@s.whatsapp.net', name: 'Ravi', phone: '919000000002' }] } };
    mocks.userResults.push({ data: [{ source_ref: '919000000002@s.whatsapp.net' }], error: null });
    const json = await (await preview(get('/x?q=a&limit=999'))).json();
    expect(json.contacts.map((c: { imported: boolean }) => c.imported)).toEqual([false, true]);
    expect(json.groups[0].subject).toBe('Climbing');
    expect(bridgeCalls.find((c) => c.path.includes('/contacts'))?.path).toContain('limit=200');
  });

  it('imports from bridge data only, skipping people already in muop', async () => {
    bridgeReply = () => ({ json: { contacts: [
      { jid: '919000000001@s.whatsapp.net', name: 'Asha Rao', phone: '919000000001' },
      { jid: '919000000002@s.whatsapp.net', name: 'Ravi', phone: '919000000002' },
      { jid: '555@lid', name: '', phone: null },
    ] } });
    mocks.userResults.push({ data: [{ source_ref: '919000000002@s.whatsapp.net' }], error: null }, { error: null });
    const res = await importPeople(post('/x', { jids: ['919000000001@s.whatsapp.net', '919000000002@s.whatsapp.net', '5551234@lid'], name: 'Evil' }));
    expect(await res.json()).toEqual({ imported: 2, skipped: 1 });
    const rows = mocks.inserted[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ user_id: UID, name: 'Asha Rao', source: 'whatsapp', source_ref: '919000000001@s.whatsapp.net', phone: '+919000000001', category: 'personal' });
    expect(rows[1]).toMatchObject({ source_ref: '555@lid', phone: null, name: 'WhatsApp contact' });
    expect(bridgeCalls[0].body).toEqual({ jids: ['919000000001@s.whatsapp.net', '919000000002@s.whatsapp.net', '5551234@lid'] });
  });

  it('rejects non-person jids and oversized picks', async () => {
    expect((await importPeople(post('/x', { jids: ['120363000000000001@g.us'] }))).status).toBe(400);
    expect((await importPeople(post('/x', { jids: [] }))).status).toBe(400);
  });
});

describe('send', () => {
  const contact = (over: object = {}) => ({ data: { id: CID, source: 'whatsapp', source_ref: '919000000001@s.whatsapp.net', phone: '+919000000001', ...over }, error: null });
  const linked = (wa: boolean, smsOn: boolean) => {
    if (wa) mocks.admin.rows.set('whatsapp', { kind: 'whatsapp', status: 'connected' });
    if (smsOn) mocks.admin.rows.set('sms', { kind: 'sms', status: 'connected', secret_enc: null });
  };

  it('is rate limited per user before anything is sent', async () => {
    const { HttpError } = await import('@/lib/http');
    mocks.limit.mockRejectedValueOnce(new HttpError(429, 'Too many requests, slow down'));
    const res = await send(post('/x', { contact_id: CID, text: 'hi' }));
    expect(mocks.limit).toHaveBeenCalledWith('send', UID);
    expect(bridgeCalls).toHaveLength(0);
    expect(res.status).toBe(429);
  });

  it('needs exactly one recipient and non-empty text', async () => {
    expect((await send(post('/x', { text: 'hi' }))).status).toBe(400);
    expect((await send(post('/x', { contact_id: CID, jid: '919000000001@s.whatsapp.net', text: 'hi' }))).status).toBe(400);
    expect((await send(post('/x', { contact_id: CID, text: '  ' }))).status).toBe(400);
  });

  it('404s for a contact the user cannot see (RLS returns nothing)', async () => {
    mocks.userResults.push({ data: null, error: null });
    expect((await send(post('/x', { contact_id: CID, text: 'hi' }))).status).toBe(404);
    expect(bridgeCalls).toHaveLength(0);
  });

  it('sends through WhatsApp when linked, marking the recipient as a muop contact', async () => {
    linked(true, true);
    mocks.userResults.push(contact());
    const res = await send(post('/x', { contact_id: CID, text: 'hi there' }));
    expect(await res.json()).toEqual({ channel: 'whatsapp' });
    expect(bridgeCalls[0]).toEqual({ path: `/sessions/${UID}/send`, method: 'POST', body: { jid: '919000000001@s.whatsapp.net', text: 'hi there', via_contact: true } });
  });

  it('409s with nothing linked (the client falls back to hand-off links)', async () => {
    mocks.userResults.push(contact());
    expect((await send(post('/x', { contact_id: CID, text: 'hi' }))).status).toBe(409);
  });

  it('falls back to SMS when the number is not on WhatsApp, through a mocked gateway', async () => {
    linked(true, true);
    mocks.userResults.push(contact({ source: 'manual', source_ref: null }));
    const { sealString, parseKey } = await import('./secretbox.mjs');
    mocks.admin.rows.set('sms', { kind: 'sms', status: 'connected', secret_enc: sealString(JSON.stringify({ mode: 'cloud', username: 'u', password: 'p' }), parseKey(process.env.WA_SESSION_KEY), `sms-creds:${UID}`) });
    bridgeReply = () => ({ status: 404, json: { error: 'not_on_whatsapp' } });
    const spy = vi.spyOn(sms, 'httpTransport').mockImplementation(async (r) => { mocks.smsCalls.push({ url: r.url.href, username: r.username, body: r.body }); return { status: 202 }; });
    // sendMessage takes the transport from its context; the route uses the default one, so go through lib directly.
    const { sendMessage } = await import('./channels');
    const out = await sendMessage({ userId: UID, supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => contact({ source: 'manual', source_ref: null }) }) }) }) }, smsTransport: spy.getMockImplementation() }, { contact_id: CID, text: 'hello' });
    expect(out).toEqual({ channel: 'sms' });
    expect(mocks.smsCalls[0].url).toBe('https://api.sms-gate.app/3rdparty/v1/message');
    expect(JSON.parse(mocks.smsCalls[0].body)).toEqual({ textMessage: { text: 'hello' }, phoneNumbers: ['+919000000001'] });
    spy.mockRestore();
  });

  it('WhatsApp-only route never falls back, and groups go straight to the bridge', async () => {
    linked(true, true);
    const res = await waSend(post('/x', { jid: '120363000000000001@g.us', text: 'hi all' }));
    expect(await res.json()).toEqual({ channel: 'whatsapp' });
    expect(bridgeCalls[0].body).toEqual({ jid: '120363000000000001@g.us', text: 'hi all' });
    bridgeReply = () => ({ status: 403, json: { error: 'unknown_recipient' } });
    const denied = await send(post('/x', { jid: '919111111111@s.whatsapp.net', text: 'spam' }));
    expect(denied.status).toBe(403);
  });
});

describe('channel selection', () => {
  it('prefers WhatsApp, then SMS, then hand-off', () => {
    const c = { source: 'whatsapp', source_ref: '919000000001@s.whatsapp.net', phone: '+919000000001' };
    expect(pickChannel(c, { whatsapp: true, sms: true })).toBe('whatsapp');
    expect(pickChannel(c, { whatsapp: false, sms: true })).toBe('sms');
    expect(pickChannel(c, { whatsapp: false, sms: false })).toBe('handoff');
    expect(pickChannel({ phone: null }, { whatsapp: true, sms: true })).toBe('handoff');
    expect(availableChannels({ phone: '+919000000001' }, { whatsapp: true, sms: true })).toEqual(['whatsapp', 'sms', 'handoff']);
  });

  it('refuses an explicitly requested channel that is not available', () => {
    expect(() => pickChannel({ phone: null }, { whatsapp: true, sms: true }, 'sms')).toThrow();
  });

  it('derives jids and numbers safely', () => {
    expect(contactJid({ phone: '+919000000001' })).toBe('919000000001@s.whatsapp.net');
    expect(contactJid({ phone: '9000' })).toBeNull();
    expect(contactJid({ source: 'whatsapp', source_ref: '../../etc@evil' })).toBeNull();
    expect(phoneFromJid('919000000001:12@s.whatsapp.net')).toBe('+919000000001');
    expect(phoneFromJid('5551234@lid')).toBeNull();
  });
});

describe('sms link', () => {
  it('stores credentials sealed and never echoes them', async () => {
    const res = await smsLink(post('/x', { accept: true, mode: 'cloud', username: 'AB12CD', password: 'hunter2-secret' }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('hunter2');
    const row = mocks.admin.upserts[0] as { secret_enc: string; mode: string };
    expect(row.mode).toBe('cloud');
    expect(row.secret_enc).not.toContain('hunter2');
    expect(Buffer.from(row.secret_enc, 'base64').includes('hunter2')).toBe(false);
    mocks.admin.rows.set('sms', row);
    expect(await loadSmsCreds(UID)).toMatchObject({ username: 'AB12CD', password: 'hunter2-secret' });
    const ch = await (await channels(get('/x'))).json();
    expect(JSON.stringify(ch)).not.toContain('hunter2');
  });

  it('requires the accepted notice and a url for local mode', async () => {
    expect((await smsLink(post('/x', { mode: 'cloud', username: 'u', password: 'p' }))).status).toBe(400);
    expect((await smsLink(post('/x', { accept: true, mode: 'local', username: 'u', password: 'p' }))).status).toBe(400);
  });

  it('refuses local urls that point at this machine or metadata services', async () => {
    for (const url of ['http://127.0.0.1:3000', 'http://localhost:8080', 'http://169.254.169.254', 'http://[::1]:8080', 'ftp://192.168.1.2', 'http://u:p@192.168.1.2']) {
      const res = await smsLink(post('/x', { accept: true, mode: 'local', url, username: 'u', password: 'p' }));
      expect(res.status, url).toBe(400);
    }
    expect(mocks.admin.upserts).toHaveLength(0);
    const ok = await smsLink(post('/x', { accept: true, mode: 'local', url: 'http://192.168.1.20:8080', username: 'u', password: 'p' }));
    expect(ok.status).toBe(200);
  });

  it('test SMS is rate limited, needs a link, and takes only an E.164 number', async () => {
    expect((await smsTest(post('/x', { to: '9876543210' }))).status).toBe(400);
    expect((await smsTest(post('/x', { to: '+919876543210' }))).status).toBe(409);
    expect(mocks.limit).toHaveBeenCalledWith('smsTest', UID);
  });
});

describe('sms gateway', () => {
  const creds = { mode: 'local' as const, url: 'http://192.168.1.20:8080/', username: 'u', password: 'p' };

  it('calls the local server path with basic auth and maps failures to safe errors', async () => {
    const seen: string[] = [];
    await sms.sendSms(creds, '+919876543210', 'hi', async (r) => { seen.push(r.url.href, r.username, String(r.guard)); return { status: 202 }; });
    expect(seen).toEqual(['http://192.168.1.20:8080/message', 'u', 'true']);
    await expect(sms.sendSms(creds, '+91', 'x', async () => ({ status: 401 }))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('username or password') });
    await expect(sms.sendSms(creds, '+91', 'x', async () => { throw new Error('ECONNREFUSED 192.168.1.20'); })).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining('192.168') });
  });

  it('classifies forbidden addresses', () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1', '224.0.0.1']) expect(sms.isForbiddenAddress(ip, []), ip).toBe(true);
    for (const ip of ['192.168.1.20', '10.0.0.5', '100.101.102.103', '8.8.8.8']) expect(sms.isForbiddenAddress(ip, []), ip).toBe(false);
    expect(sms.isForbiddenAddress('192.168.1.20', ['192.168.1.20'])).toBe(true); // this machine's own address
  });
});
