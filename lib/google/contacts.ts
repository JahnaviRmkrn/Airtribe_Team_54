import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../http';
import { adminClient } from '../supabase/admin';
import { category } from '../schemas';
import { googleJson, type GoogleConfig, type Session } from './connector';

export const PREVIEW_LIMIT = 1000;
export const PAGE_SIZE = 100;
export const IMPORT_BATCH_LIMIT = 5;
export interface GoogleContact { id: string; name: string; email: string | null }
export type ContactsSession = {
  phase: 'authorizing'; state: string; verifier: string;
} | {
  phase: 'ready'; token: string | null; tokenExpiresAt: number; contacts: GoogleContact[];
  pages: number; nextPageToken: string | null; seenPages: string[]; skipped: number; truncated: boolean;
};
export type ReadyContacts = Extract<ContactsSession, { phase: 'ready' }>;

const personSchema = z.object({
  names: z.array(z.object({ displayName: z.string().optional(), metadata: z.object({ primary: z.boolean().optional() }).optional() })).optional(),
  emailAddresses: z.array(z.object({ value: z.string().optional(), metadata: z.object({ primary: z.boolean().optional() }).optional() })).optional(),
});
const peoplePage = z.object({ connections: z.array(personSchema).max(PAGE_SIZE).optional(), nextPageToken: z.string().max(4096).optional() });
const emailSchema = z.email().max(254);
export const contactKey = (contact: { name: string; email: string | null }) => contact.email ? `email:${contact.email.trim().toLowerCase()}` : `name:${contact.name.trim().toLowerCase()}`;

export function normalizePeople(raw: unknown) {
  const parsed = peoplePage.safeParse(raw);
  if (!parsed.success) throw new HttpError(502, 'Google returned an invalid contacts page. Please reconnect.');
  const contacts: GoogleContact[] = [];
  let skipped = 0;
  for (const person of parsed.data.connections || []) {
    const names = person.names || [];
    const emails = person.emailAddresses || [];
    const preferredName = names.find((name) => name.metadata?.primary)?.displayName || names.find((name) => name.displayName)?.displayName;
    const orderedEmails = [...emails.filter((email) => email.metadata?.primary), ...emails.filter((email) => !email.metadata?.primary)];
    const email = orderedEmails.map((value) => value.value?.trim()).find((value) => emailSchema.safeParse(value).success) || null;
    const name = (preferredName?.trim() || email || '').slice(0, 120);
    if (!name) { skipped++; continue; }
    contacts.push({ id: randomUUID(), name, email });
  }
  return { contacts, skipped, nextPageToken: parsed.data.nextPageToken || null };
}

export async function loadContactsPage(payload: ReadyContacts) {
  if (payload.pages && !payload.nextPageToken) return;
  if (!payload.token || payload.tokenExpiresAt <= Date.now()) throw new HttpError(410, 'Google access expired. Cancel this import and reconnect.');
  const url = new URL('https://people.googleapis.com/v1/people/me/connections');
  url.search = new URLSearchParams({ personFields: 'names,emailAddresses', sources: 'READ_SOURCE_TYPE_CONTACT', pageSize: String(PAGE_SIZE), sortOrder: 'FIRST_NAME_ASCENDING' }).toString();
  if (payload.nextPageToken) url.searchParams.set('pageToken', payload.nextPageToken);
  const page = normalizePeople(await googleJson(url.toString(), { headers: { Authorization: `Bearer ${payload.token}` } }));
  if (page.nextPageToken && (page.nextPageToken === payload.nextPageToken || payload.seenPages.includes(page.nextPageToken))) {
    throw new HttpError(502, 'Google repeated a contacts page. Cancel this import and reconnect.');
  }
  const known = new Set(payload.contacts.map(contactKey));
  for (const contact of page.contacts) {
    const key = contactKey(contact);
    if (known.has(key)) payload.skipped++;
    else { known.add(key); payload.contacts.push(contact); }
  }
  payload.skipped += page.skipped;
  payload.pages++;
  if (payload.nextPageToken) payload.seenPages.push(payload.nextPageToken);
  payload.nextPageToken = page.nextPageToken;
  if (payload.contacts.length >= PREVIEW_LIMIT || payload.pages >= 10) {
    payload.truncated = !!page.nextPageToken;
    payload.nextPageToken = null;
  }
  // Once all pages (or the bounded preview limit) are read, no credential is
  // needed. Keep only the encrypted selectable preview until its original TTL.
  if (!payload.nextPageToken) payload.token = null;
}

export async function contactPreview(payload: ReadyContacts, owner: string) {
  const { data, error } = await adminClient().rpc('preview_google_contact_duplicates', {
    p_owner: owner, p_contacts: payload.contacts.map(({ id, name, email }) => ({ id, name, email })),
  });
  if (error) throw new HttpError(503, 'Could not check existing contacts. Please retry.');
  const duplicates = new Set((data || []).map((row: { id: string }) => row.id));
  return {
    ready: true, loaded: payload.pages > 0, contacts: payload.contacts.map((contact) => ({ ...contact, duplicate: duplicates.has(contact.id) })),
    has_more: payload.pages === 0 || !!payload.nextPageToken, skipped: payload.skipped, truncated: payload.truncated,
    batch_limit: IMPORT_BATCH_LIMIT,
  };
}

export const selectionsSchema = z.object({ selections: z.array(z.object({ id: z.uuid(), category }).strict()).min(1).max(IMPORT_BATCH_LIMIT) }).strict();
export async function importSelection(config: GoogleConfig, session: Session<ContactsSession>, raw: unknown) {
  const parsed = selectionsSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Choose between 1 and ${IMPORT_BATCH_LIMIT} contacts and a category for each.`);
  if (new Set(parsed.data.selections.map((item) => item.id)).size !== parsed.data.selections.length) throw new HttpError(400, 'Choose each contact only once.');
  if (session.payload.phase !== 'ready') throw new HttpError(409, 'Finish Google authorization before importing.');
  const candidates = session.payload.contacts;
  const rows = parsed.data.selections.map((selection) => {
    const contact = candidates.find((candidate) => candidate.id === selection.id);
    if (!contact) throw new HttpError(400, 'A selected contact is not in this preview. Refresh the preview and try again.');
    return { name: contact.name, email: contact.email, category: selection.category };
  });
  const { data, error } = await adminClient().rpc('import_google_contacts', {
    p_session: session.id, p_owner: session.owner, p_purpose: config.purpose, p_lease: session.lease, p_contacts: rows,
  });
  if (error) {
    if (error.message?.includes('connector_expired')) throw new HttpError(410, 'This import expired or was cancelled. Connect Google again.');
    throw new HttpError(503, 'Could not confirm the import. Retry the same selection safely; duplicates will be skipped.');
  }
  return data as { added: number; skipped: number };
}
