import { z } from 'zod';
import { adminClient } from './supabase/admin';
import { HttpError } from './http';
import { requireEnv } from './env';

// Client for the loopback WhatsApp bridge (services/whatsapp). Only this
// server holds WA_BRIDGE_SECRET; the browser never talks to the bridge.

export type WaState = 'unlinked' | 'connecting' | 'waiting_qr' | 'connected' | 'logged_out' | 'error';
export type BridgeStatus = {
  state: WaState;
  qr?: string | null;
  pairing_code?: string | null;
  phone?: string | null;
  error?: string | null;
  synced?: boolean;
  counts?: { contacts: number; groups: number };
};

// What the organiser is told for each bridge error code. Never relays raw text.
const BRIDGE_ERRORS: Record<string, [number, string]> = {
  not_connected: [409, 'WhatsApp is not connected. Link it again from the Profile page.'],
  unknown_recipient: [403, 'You can only message your own contacts and groups'],
  not_on_whatsapp: [404, 'That number is not on WhatsApp'],
  rate_limited: [429, 'Too many messages, slow down'],
  busy: [503, 'WhatsApp linking is busy, try again in a minute'],
  bad_text: [400, 'Message must be 1 to 4096 characters'],
  bad_jid: [400, 'Not a valid WhatsApp recipient'],
};

export async function bridge<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const base = process.env.WA_BRIDGE_URL || 'http://127.0.0.1:3010';
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: init.method ?? 'GET',
      headers: { 'x-wa-bridge-secret': requireEnv('WA_BRIDGE_SECRET', process.env.WA_BRIDGE_SECRET), 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
  } catch {
    throw new HttpError(503, 'The WhatsApp service is unavailable right now');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const mapped = BRIDGE_ERRORS[data.error ?? ''];
    if (mapped) throw new HttpError(mapped[0], mapped[1]);
    throw new HttpError(502, 'The WhatsApp service returned an error');
  }
  return data as T;
}

export const personJid = z.string().regex(/^[0-9]{5,20}(:[0-9]+)?@(s\.whatsapp\.net|lid)$/);
export const groupJid = z.string().regex(/^[0-9-]{5,40}@g\.us$/);

/** Digits only, 8 to 15 long, or undefined. Accepts "+91 98765-43210". */
export const pairingPhone = z
  .string()
  .transform((s) => s.replace(/[\s()+-]/g, ''))
  .pipe(z.string().regex(/^[1-9][0-9]{7,14}$/, 'Enter the number with country code, digits only'));

export const linkBody = z.object({
  // The opt-in screen's checkbox. Without it nothing is started.
  accept: z.literal(true, { error: 'Accept the warning to link WhatsApp' }),
  phone: pairingPhone.optional(),
});

export const importBody = z.object({
  jids: z.array(personJid).min(1).max(200),
  category: z.enum(['personal', 'professional', 'community']).default('personal'),
});

export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** E.164 phone for a WhatsApp person JID, or null (LID jids carry no number). */
export function phoneFromJid(jid: string): string | null {
  const m = jid.match(/^([0-9]{5,20})(?::[0-9]+)?@s\.whatsapp\.net$/);
  return m && E164.test('+' + m[1]) ? '+' + m[1] : null;
}

/** The JID to message for a muop contact: its WhatsApp id, else its phone number. */
export function contactJid(c: { source?: string | null; source_ref?: string | null; phone?: string | null }): string | null {
  if (c.source === 'whatsapp' && c.source_ref && personJid.safeParse(c.source_ref).success) return c.source_ref;
  if (c.phone && E164.test(c.phone)) return c.phone.slice(1) + '@s.whatsapp.net';
  return null;
}

/**
 * Asks the bridge for the user's status and keeps the whatsapp row of
 * channel_links in step with it (so a logout that happened while nobody was
 * watching is still recorded). If the bridge is down we fall back to the row.
 */
/** The fields the browser may see. No bridge internals. */
export function publicStatus(s: BridgeStatus) {
  return { state: s.state, qr: s.qr ?? null, pairing_code: s.pairing_code ?? null, phone: s.phone ?? null, error: s.error ?? null, synced: s.synced ?? false, counts: s.counts ?? { contacts: 0, groups: 0 } };
}

export async function syncedStatus(userId: string): Promise<BridgeStatus & { bridge_up: boolean }> {
  const db = adminClient();
  const { data: row } = await db.from('channel_links').select('status').eq('user_id', userId).eq('kind', 'whatsapp').maybeSingle();
  let live: BridgeStatus;
  try {
    live = await bridge<BridgeStatus>(`/sessions/${userId}/status`);
  } catch {
    const was = row?.status as WaState | undefined;
    if (was === 'connected' || was === 'connecting' || was === 'waiting_qr') return { state: 'error', error: 'bridge_unavailable', bridge_up: false };
    return { state: was ?? 'unlinked', error: null, bridge_up: false };
  }
  let state = live.state;
  // The bridge forgot a session we thought was live: the phone removed the device.
  if (state === 'unlinked' && (row?.status === 'connected' || row?.status === 'logged_out')) state = 'logged_out';
  if (row && row.status !== state) {
    await db.from('channel_links').update({ status: state, last_error: live.error ?? null, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('kind', 'whatsapp');
  }
  return { ...live, state, error: state === 'logged_out' ? 'logged_out' : live.error ?? null, bridge_up: true };
}
