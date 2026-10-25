import { blankRow, clean, cleanEmail, MAX_ROWS, parseCsv, type ImportRow, type ParseResult } from './import';

// LinkedIn profile URL as a stable re-import key: https, lowercase host+path,
// no query/fragment/trailing slash. Anything that is not a linkedin.com URL is dropped.
export function linkedinRef(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/(^|\.)linkedin\.com$/.test(u.hostname.toLowerCase())) return null;
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return path ? `https://${u.hostname.toLowerCase()}${path}`.slice(0, 300) : null;
  } catch {
    return null;
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "12 Jan 2021" -> "2021-01-12"; null when it is not in LinkedIn's format.
export function linkedinDate(s: string | null): string | null {
  const m = s?.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  const mi = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  return m && mi >= 0 ? `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// Parses LinkedIn's Connections.csv. The real export starts with a few "Notes:"
// lines before the header `First Name,Last Name,URL,Email Address,Company,Position,Connected On`,
// so the header is located by name (columns may also be reordered) and anything above it is skipped.
export function parseLinkedInCsv(text: string): ParseResult {
  const all = parseCsv(text);
  const h = all.findIndex((r) => r.some((c) => c.trim().toLowerCase() === 'first name') && r.some((c) => c.trim().toLowerCase() === 'last name'));
  if (h < 0 || h > 30) throw new Error('This does not look like LinkedIn\'s Connections.csv (no "First Name, Last Name" header row).');
  const cols = all[h].map((c) => c.trim().toLowerCase());
  const at = (name: string) => cols.indexOf(name);
  const iFirst = at('first name'), iLast = at('last name'), iUrl = at('url'), iEmail = at('email address');
  const iCompany = at('company'), iPos = at('position'), iOn = at('connected on');
  const get = (r: string[], i: number) => (i >= 0 ? r[i] : undefined);

  const rows: ImportRow[] = [];
  let truncated = false;
  for (const r of all.slice(h + 1)) {
    const name = clean(`${get(r, iFirst) ?? ''} ${get(r, iLast) ?? ''}`, 120);
    if (!name) continue; // members who hide their name export as blank
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const on = linkedinDate(clean(get(r, iOn), 20));
    rows.push({
      ...blankRow(name),
      email: cleanEmail(get(r, iEmail)),
      source_ref: linkedinRef(clean(get(r, iUrl), 300)),
      company: clean(get(r, iCompany), 200),
      position: clean(get(r, iPos), 200),
      notes: on ? `Connected on LinkedIn ${on}` : null,
    });
  }
  return { rows, truncated };
}
