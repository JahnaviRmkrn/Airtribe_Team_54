// Source-agnostic helpers for importing contacts from an export file or API
// (LinkedIn, Facebook, vCard, Google, Android picker, WhatsApp...): size caps,
// CSV parsing, text and phone cleanup, dedupe. Source-specific parsers live in
// lib/import-*.ts. Rows hold third-party PII: never log them.

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_VCF_BYTES = 15 * 1024 * 1024; // iCloud exports with photos get big
export const MAX_ROWS = 5000;
export const BATCH_SIZE = 500; // rows per import_contacts() call (the SQL function allows 1000)

export const IMPORT_SOURCES = ['linkedin', 'facebook', 'whatsapp', 'vcard', 'google', 'android'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
// .vcf (and the Google export, which may be a .vcf) get the larger cap.
export const maxBytesFor = (source: ImportSource) => (source === 'vcard' || source === 'google' ? MAX_VCF_BYTES : MAX_FILE_BYTES);

// One person parsed from an export, before it becomes a contact row.
export type ImportRow = {
  name: string;
  email: string | null;
  phone: string | null; // E.164
  source_ref: string | null; // LinkedIn profile URL / Facebook id / vCard UID: the re-import key
  company: string | null;
  position: string | null;
  notes: string | null;
};

export type ParseResult = { rows: ImportRow[]; truncated: boolean };

export const blankRow = (name: string): ImportRow => ({ name, email: null, phone: null, source_ref: null, company: null, position: null, notes: null });

// Collapses whitespace and drops control/zero-width characters (single-line fields).
export function clean(s: unknown, max: number): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function cleanEmail(s: unknown): string | null {
  const t = clean(s, 254)?.toLowerCase() ?? null;
  return t && EMAIL_RE.test(t) ? t : null;
}

// Best-effort E.164. Numbers with a "+" or "00" prefix are trusted; national
// numbers are read as `region` (India: 10 digits starting 6-9, optional 0 or 91
// prefix). Anything ambiguous returns null rather than a wrong number.
export function normPhone(raw: unknown, region: 'IN' | null = 'IN'): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.split(/(?:x|ext\.?|;ext=)/i)[0].trim();
  const digits = s.replace(/\D/g, '');
  let e164: string | null = null;
  if (s.startsWith('+')) e164 = `+${digits}`;
  else if (digits.startsWith('00')) e164 = `+${digits.slice(2)}`;
  else if (region === 'IN') {
    if (/^[6-9]\d{9}$/.test(digits)) e164 = `+91${digits}`;
    else if (/^0[6-9]\d{9}$/.test(digits)) e164 = `+91${digits.slice(1)}`;
    else if (/^91[6-9]\d{9}$/.test(digits)) e164 = `+${digits}`;
  }
  return e164 && /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

// Case/accents/punctuation-insensitive name key for dedupe.
export function normName(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// RFC 4180 CSV: quoted fields, "" escapes, embedded commas/newlines, CRLF or LF,
// leading BOM. Never throws; an unterminated quote swallows the rest of the file.
// maxRows bounds the work done on hostile input (preamble and header count).
export function parseCsv(text: string, maxRows = MAX_ROWS + 50): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (rows.length < maxRows && (field !== '' || row.length)) endRow();
  return rows;
}

export type Existing = { name: string; email: string | null; phone?: string | null; source: string | null; source_ref: string | null };
export type Verdict = 'new' | 'update' | 'duplicate';

// Classifies incoming rows against the user's existing contacts and against
// earlier rows of the same file:
//   update    same source + source_ref already imported (re-import refreshes it)
//   duplicate same email or phone; or, when the person has neither (or the
//             existing contact has neither), the same normalised name
//   new       everything else
// Two people sharing a name but with different emails/phones stay separate.
export function classify(existing: Existing[], incoming: ImportRow[], source: ImportSource): Verdict[] {
  const refs = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const namesBare = new Set<string>(); // existing contacts with no email and no phone
  const namesAny = new Set<string>();
  const add = (e: Existing) => {
    if (e.source === source && e.source_ref) refs.add(e.source_ref);
    const n = normName(e.name);
    if (e.email) emails.add(e.email.toLowerCase());
    if (e.phone) phones.add(e.phone);
    if (n) {
      namesAny.add(n);
      if (!e.email && !e.phone) namesBare.add(n);
    }
  };
  existing.forEach(add);

  const seenRefs = new Set<string>();
  return incoming.map((r) => {
    const n = normName(r.name);
    if (r.source_ref) {
      if (seenRefs.has(r.source_ref)) return 'duplicate';
      seenRefs.add(r.source_ref);
      if (refs.has(r.source_ref)) return 'update';
    }
    const email = r.email?.toLowerCase() ?? null;
    const dup =
      (!!email && emails.has(email)) ||
      (!!r.phone && phones.has(r.phone)) ||
      (!!n && (email || r.phone ? namesBare.has(n) : namesAny.has(n)));
    if (!dup) add({ name: r.name, email, phone: r.phone, source: null, source_ref: null }); // later rows of the same file dedupe against it
    return dup ? 'duplicate' : 'new';
  });
}

// Reads a request body as text but refuses anything over `max` bytes, even when
// Content-Length is missing or lies (chunked uploads). null = too large.
export async function readCappedText(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}
