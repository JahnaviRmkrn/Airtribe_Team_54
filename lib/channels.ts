import { z } from 'zod';
import { adminClient } from './supabase/admin';
import { HttpError } from './http';
import { requireEnv } from './env';
import { openString, parseKey, sealString } from './secretbox.mjs';
import { bridge, contactJid, E164, groupJid, personJid } from './whatsapp';
import { sendSms, SMS_MAX_TEXT, type GatewayCreds, type Transport } from './sms-gateway';

// One interface over every way muop can get a message to a person:
//   whatsapp  sent from the organiser's linked WhatsApp (bridge)
//   sms       sent from the organiser's Android phone (SMS Gateway app)
//   handoff   nothing linked: the browser opens wa.me / sms: / mailto: itself
// Hand-off links are built client-side (public/organizer/app.js); the server
// only ever sends through a linked channel, to the organiser's own contacts.

export type ChannelKind = 'whatsapp' | 'sms' | 'handoff';
export type Linked = { whatsapp: boolean; sms: boolean };
export type ContactTarget = { source?: string | null; source_ref?: string | null; phone?: string | null };

export const sendBody = z
  .object({
    contact_id: z.uuid().optional(),
    jid: z.union([personJid, groupJid]).optional(),
    text: z.string().trim().min(1).max(SMS_MAX_TEXT),
    channel: z.enum(['whatsapp', 'sms']).optional(),
  })
  .refine((b) => (b.contact_id ? 1 : 0) + (b.jid ? 1 : 0) === 1, { message: 'Give either contact_id or jid' });

const sessionKey = () => parseKey(requireEnv('WA_SESSION_KEY', process.env.WA_SESSION_KEY));
const smsContext = (userId: string) => `sms-creds:${userId}`;

export async function saveSmsCreds(userId: string, creds: GatewayCreds) {
  const { error } = await adminClient().from('channel_links').upsert({
    user_id: userId,
    kind: 'sms',
    status: 'connected',
    mode: creds.mode,
    secret_enc: sealString(JSON.stringify(creds), sessionKey(), smsContext(userId)),
    last_error: null,
    consented_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new HttpError(500, 'Could not save the SMS link');
}

export async function loadSmsCreds(userId: string): Promise<GatewayCreds | null> {
  const { data } = await adminClient().from('channel_links').select('secret_enc').eq('user_id', userId).eq('kind', 'sms').maybeSingle();
  if (!data?.secret_enc) return null;
  try {
    return JSON.parse(openString(data.secret_enc, sessionKey(), smsContext(userId))) as GatewayCreds;
  } catch {
    throw new HttpError(409, 'Your saved SMS link can no longer be read. Link SMS again.');
  }
}

export async function linkedChannels(userId: string): Promise<Linked> {
  const { data } = await adminClient().from('channel_links').select('kind,status').eq('user_id', userId);
  const rows = data ?? [];
  return {
    whatsapp: rows.some((r) => r.kind === 'whatsapp' && r.status === 'connected'),
    sms: rows.some((r) => r.kind === 'sms' && r.status === 'connected'),
  };
}

/** Channels that could reach this contact right now, best first. 'handoff' is always possible. */
export function availableChannels(c: ContactTarget, linked: Linked): ChannelKind[] {
  const out: ChannelKind[] = [];
  if (linked.whatsapp && contactJid(c)) out.push('whatsapp');
  if (linked.sms && c.phone && E164.test(c.phone)) out.push('sms');
  out.push('handoff');
  return out;
}

/** The best channel, or the one asked for if it is available. */
export function pickChannel(c: ContactTarget, linked: Linked, want?: ChannelKind): ChannelKind {
  const avail = availableChannels(c, linked);
  if (want) {
    if (!avail.includes(want)) throw new HttpError(400, want === 'sms' ? 'SMS is not linked, or this contact has no phone number' : 'WhatsApp is not linked, or this contact has no WhatsApp or phone number');
    return want;
  }
  return avail[0];
}

type Ctx = { userId: string; supabase: { from: (t: string) => any }; smsTransport?: Transport }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Sends `text` as the organiser. Recipients: one of their own contacts, or a
 * WhatsApp group / synced contact JID (the bridge re-checks membership).
 * Returns the channel used; throws HttpError(409) when nothing is linked.
 */
export async function sendMessage(ctx: Ctx, body: z.infer<typeof sendBody>): Promise<{ channel: Exclude<ChannelKind, 'handoff'> }> {
  if (body.jid) {
    if (body.channel === 'sms') throw new HttpError(400, 'SMS needs a contact with a phone number');
    await bridge(`/sessions/${ctx.userId}/send`, { method: 'POST', body: { jid: body.jid, text: body.text } });
    return { channel: 'whatsapp' };
  }
  const { data: contact, error } = await ctx.supabase.from('contacts').select('id,source,source_ref,phone').eq('id', body.contact_id).maybeSingle();
  if (error || !contact) throw new HttpError(404, 'Not found'); // RLS: only the organiser's own contacts are visible
  const linked = await linkedChannels(ctx.userId);
  const channel = pickChannel(contact, linked, body.channel);
  if (channel === 'handoff') throw new HttpError(409, 'Link WhatsApp or SMS first, or use the hand-off links');
  if (channel === 'whatsapp') {
    try {
      await bridge(`/sessions/${ctx.userId}/send`, { method: 'POST', body: { jid: contactJid(contact), text: body.text, via_contact: true } });
      return { channel };
    } catch (e) {
      // Their number isn't on WhatsApp: fall back to SMS unless WhatsApp was explicitly asked for.
      const smsToo = !body.channel && availableChannels(contact, linked).includes('sms');
      if (!(e instanceof HttpError && e.status === 404 && smsToo)) throw e;
    }
  }
  const creds = await loadSmsCreds(ctx.userId);
  if (!creds) throw new HttpError(409, 'SMS is not linked');
  await sendSms(creds, contact.phone, body.text, ctx.smsTransport);
  return { channel: 'sms' };
}
