import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { HttpError } from '../http';

export type ActionPurpose = 'gmail' | 'calendar';
const unicodeText = (max: number) => z.string().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s), 'Use valid Unicode text without control characters');
const line = (max: number) => unicodeText(max).refine((s) => !/[\r\n]/.test(s), 'Must be a single line');
const addresses = z.array(z.string().max(254)).max(25);
export const emailDraftSchema = z.object({ to: addresses.min(1), subject: line(200).min(1), body: unicodeText(20000).min(1) }).strict();
export const calendarDraftSchema = z.object({
  title: line(200).min(1), description: unicodeText(10000), location: line(500),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), timeZone: z.string().min(1).max(100),
  durationMinutes: z.number().int().min(1).max(10080), attendees: addresses,
  disambiguation: z.enum(['reject', 'earlier', 'later']).default('reject'),
  sendUpdates: z.enum(['all', 'none']),
}).strict();
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type CalendarDraft = z.infer<typeof calendarDraftSchema>;
export type EmailPreview = EmailDraft & { kind: 'gmail'; sender: string };
export type CalendarPreview = CalendarDraft & { kind: 'calendar'; calendar: 'primary'; start: string; end: string; endLocal: string; notificationNote: string };
export type ActionPreview = EmailPreview | CalendarPreview;

// Deliberately accept plain addresses, not display names, comments or headers.
// Unicode domain names normalize to IDNA; internationalized local parts require
// SMTPUTF8 and are rejected rather than silently corrupting the recipient.
export function normalizeAddresses(values: string[]) {
  const result: string[] = [];
  for (const value of values) {
    if (/[\r\n\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'Email addresses cannot contain control characters.');
    const trimmed = value.trim();
    const at = trimmed.lastIndexOf('@');
    const local = trimmed.slice(0, at); const domain = domainToASCII(trimmed.slice(at + 1)).toLowerCase();
    if (at < 1 || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')
      || !domain || domain.length > 253 || !domain.includes('.') || domain.split('.').some((p) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)) || `${local}@${domain}`.length > 254) {
      throw new HttpError(400, 'Enter plain email addresses such as person@example.com. Internationalized local parts are not supported.');
    }
    const address = `${local}@${domain}`;
    if (!result.some((e) => e.toLowerCase() === address.toLowerCase())) result.push(address);
  }
  return result;
}
function localParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}
export function resolveLocalTime(local: string, timeZone: string, disambiguation: 'reject' | 'earlier' | 'later') {
  let canonical: string;
  try { canonical = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; }
  catch { throw new HttpError(400, 'Choose a valid IANA time zone, for example Asia/Kolkata.'); }
  const naive = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== local || Number(local.slice(0, 4)) < 2000 || Number(local.slice(0, 4)) > 2100) {
    throw new HttpError(400, 'Choose a valid date between 2000 and 2100.');
  }
  // Collect the zone's offsets on both sides of any nearby DST transition.
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = naive + hours * 3600000;
    offsets.add(Date.parse(localParts(instant, canonical) + 'Z') - instant);
  }
  const matches = [...offsets].map((offset) => naive - offset).filter((i) => localParts(i, canonical) === `${local}:00`).sort((a, b) => a - b);
  if (!matches.length) throw new HttpError(400, 'That local time does not exist because the clocks change. Choose another time.');
  if (matches.length > 1 && disambiguation === 'reject') throw new HttpError(400, 'That local time occurs twice because the clocks change. Explicitly choose the earlier or later occurrence.');
  return { instant: matches[disambiguation === 'later' ? matches.length - 1 : 0], timeZone: canonical };
}
export function preparePreview(purpose: ActionPurpose, raw: unknown): ActionPreview {
  if (purpose === 'gmail') {
    const parsed = emailDraftSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'Check recipients, subject and plain-text message. Only these fields are supported.');
    return { kind: 'gmail', ...parsed.data, to: normalizeAddresses(parsed.data.to), sender: 'The Google account selected for this Gmail connection' };
  }
  const parsed = calendarDraftSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'Check the event details, duration, attendees and notification choice.');
  const draft = parsed.data; const resolved = resolveLocalTime(draft.localStart, draft.timeZone, draft.disambiguation);
  const end = resolved.instant + draft.durationMinutes * 60000;
  return { ...draft, kind: 'calendar', calendar: 'primary', attendees: normalizeAddresses(draft.attendees), timeZone: resolved.timeZone,
    start: new Date(resolved.instant).toISOString(), end: new Date(end).toISOString(), endLocal: localParts(end, resolved.timeZone).slice(0, 16),
    notificationNote: draft.sendUpdates === 'all' ? 'Google will notify all attendees. They can see the event details and attendee list.' : 'No guest notifications requested. Google may still send some emails; external calendar syncing may be affected.',
  };
}
export const previewHash = (preview: ActionPreview) => createHash('sha256').update(JSON.stringify(preview)).digest('hex');
export const calendarEventId = (actionId: string) => 'moup' + actionId.replace(/-/g, '').toLowerCase();
function encodedSubject(value: string) {
  const words: string[] = []; let chunk = '';
  for (const char of value) { if (Buffer.byteLength(chunk + char) > 30) { words.push(chunk); chunk = ''; } chunk += char; }
  if (chunk) words.push(chunk);
  return words.map((part) => `=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`).join('\r\n ');
}
export function gmailRaw(preview: EmailPreview) {
  // Gmail supplies the authenticated account's sender. No aliases, custom From,
  // CC/BCC, HTML, attachments, private notes, or address-book auto-population.
  const body = Buffer.from(preview.body.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return Buffer.from([`To: ${preview.to.join(',\r\n ')}`, `Subject: ${encodedSubject(preview.subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n'), 'utf8').toString('base64url');
}
export function calendarBody(preview: CalendarPreview, id: string, hash: string) {
  const description = preview.description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r\n|\r|\n/g, '<br>');
  return { id: calendarEventId(id), summary: preview.title, description, location: preview.location,
    start: { dateTime: preview.start, timeZone: preview.timeZone }, end: { dateTime: preview.end, timeZone: preview.timeZone },
    attendees: preview.attendees.map((email) => ({ email })), reminders: { useDefault: false },
    guestsCanInviteOthers: false, guestsCanModify: false, guestsCanSeeOtherGuests: true,
    extendedProperties: { private: { moupAction: id, moupPreview: hash } },
  };
}
