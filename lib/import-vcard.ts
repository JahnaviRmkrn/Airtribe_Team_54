import { blankRow, clean, cleanEmail, MAX_ROWS, normPhone, type ImportRow, type ParseResult } from './import';

// Properties whose payload is a (huge, base64) blob. Skipped line by line, so the
// photo never lands in a string we keep.
const MAX_PROP = 65_536; // longest logical property line we keep (the rest is dropped)
const BLOBS = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY']);

const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// Quoted-printable (older vCard 2.1/3.0 exports): "=C3=A9" -> bytes -> charset.
function decodeQp(value: string, charset: string): string {
  const raw = value.replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytesOf(raw));
  } catch {
    return raw;
  }
}

// vCard escapes: \n \N newline, \, \; \\ literal.
const unescape = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c));
// Splits a structured value (N, ORG) on unescaped ';'.
const parts = (s: string) => s.split(/(?<!\\);/).map(unescape);

type Prop = { name: string; params: Record<string, string[]>; value: string };

// Property line -> name, params, value. Handles `item1.EMAIL;type=INTERNET;type=pref:a@b.c`
// and vCard 2.1 bare params (`TEL;CELL:...`).
function parseProp(line: string): Prop | null {
  const colon = line.indexOf(':');
  if (colon < 1) return null;
  const [head, ...rest] = line.slice(0, colon).split(';');
  const name = head.slice(head.lastIndexOf('.') + 1).toUpperCase();
  const params: Record<string, string[]> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    const k = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
    (params[k] ??= []).push(...(eq < 0 ? p : p.slice(eq + 1)).replace(/"/g, '').split(',').map((v) => v.toUpperCase()));
  }
  let value = line.slice(colon + 1);
  if (params.ENCODING?.includes('QUOTED-PRINTABLE')) value = decodeQp(value, (params.CHARSET?.[0] ?? 'utf-8').toLowerCase());
  return { name, params, value };
}

function toRow(props: Prop[]): ImportRow | null {
  const first = (n: string) => props.find((p) => p.name === n);
  const n = first('N') ? parts(first('N')!.value) : [];
  const name = clean(first('FN') ? unescape(first('FN')!.value) : `${n[3] ?? ''} ${n[1] ?? ''} ${n[0] ?? ''}`, 120)
    ?? clean(first('ORG') ? parts(first('ORG')!.value)[0] : null, 120);
  if (!name) return null;
  const email = props.filter((p) => p.name === 'EMAIL').map((p) => cleanEmail(unescape(p.value))).find(Boolean) ?? null;
  const phone = props.filter((p) => p.name === 'TEL').map((p) => normPhone(unescape(p.value).replace(/^tel:/i, ''))).find(Boolean) ?? null;
  return {
    ...blankRow(name),
    email,
    phone,
    source_ref: clean(first('UID') ? unescape(first('UID')!.value).replace(/^urn:uuid:/i, '') : null, 300),
    company: clean(first('ORG') ? parts(first('ORG')!.value)[0] : null, 200),
    position: clean(first('TITLE') ? unescape(first('TITLE')!.value) : null, 200),
  };
}

// Parses a .vcf with any number of BEGIN:VCARD blocks (vCard 2.1, 3.0, 4.0):
// unfolds lines (CRLF + space/tab), skips photo blobs, joins quoted-printable
// soft line breaks, and ignores malformed blocks.
export function parseVcard(text: string): ParseResult {
  if (!/BEGIN:VCARD/i.test(text)) throw new Error('This does not look like a .vcf file (no BEGIN:VCARD).');
  const lines = text.split(/\r\n|\n|\r/);
  const rows: ImportRow[] = [];
  let truncated = false;
  let props: Prop[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const sep = line.search(/[;:]/);
    const head = sep < 0 ? line : line.slice(0, sep);
    const name = head.slice(head.lastIndexOf('.') + 1).toUpperCase();
    const blob = BLOBS.has(name);
    const pieces = [line];
    let size = line.length;
    if (!blob && line.endsWith('=') && /ENCODING=QUOTED-PRINTABLE/i.test(line)) {
      // Quoted-printable soft break: a trailing "=" continues verbatim on the next physical line.
      // Joined once, with a size cap, so hostile input stays linear.
      pieces[0] = line.slice(0, -1);
      while (size < MAX_PROP && i + 1 < lines.length) {
        const next = lines[++i];
        const soft = next.endsWith('=');
        pieces.push(soft ? next.slice(0, -1) : next);
        size += next.length;
        if (!soft) break;
      }
    } else {
      // Unfold: continuation lines start with a space or tab. Blob lines are dropped unread.
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
        i++;
        if (!blob && size < MAX_PROP) { pieces.push(lines[i].slice(1)); size += lines[i].length; }
      }
    }
    if (blob) continue;
    line = pieces.join('');

    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') props = [];
    else if (upper === 'END:VCARD') {
      const row = props && toRow(props);
      props = null;
      if (row) {
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push(row);
      }
    } else if (props && line) {
      const p = parseProp(line);
      if (p && props.length < 200) props.push(p);
    }
  }
  return { rows, truncated };
}
