import { blankRow, clean, cleanEmail, MAX_ROWS, normPhone, parseCsv, type ImportRow, type ParseResult } from './import';

// Google Contacts "Google CSV" export. Two layouts exist:
//   new: First Name,Middle Name,Last Name,...,Organization Name,Organization Title,...,E-mail 1 - Value,Phone 1 - Value
//   old: Name,Given Name,Additional Name,Family Name,...,E-mail 1 - Value,Phone 1 - Value,Organization 1 - Name,Organization 1 - Title
// Multi-value cells are joined with " ::: "; the first value wins.
const firstValue = (s: string | undefined) => s?.split(':::')[0];

export function parseGoogleCsv(text: string): ParseResult {
  const all = parseCsv(text);
  const h = all.findIndex((r) => r.some((c) => /^(first name|given name)$/i.test(c.trim())) || (r.some((c) => c.trim().toLowerCase() === 'name') && r.some((c) => /^e-?mail 1 - value$/i.test(c.trim()))));
  if (h < 0 || h > 5) throw new Error('This does not look like a Google Contacts CSV export (choose "Google CSV" when exporting).');
  const cols = all[h].map((c) => c.trim().toLowerCase());
  const idx = (...names: string[]) => names.map((n) => cols.indexOf(n)).find((i) => i >= 0) ?? -1;
  const get = (r: string[], i: number) => (i >= 0 ? firstValue(r[i]) : undefined);
  const iName = idx('name'), iFirst = idx('first name', 'given name'), iMid = idx('middle name', 'additional name'), iLast = idx('last name', 'family name');
  const iEmail = idx('e-mail 1 - value', 'email 1 - value'), iPhone = idx('phone 1 - value');
  const iOrg = idx('organization name', 'organization 1 - name'), iTitle = idx('organization title', 'organization 1 - title');

  const rows: ImportRow[] = [];
  let truncated = false;
  for (const r of all.slice(h + 1)) {
    const company = clean(get(r, iOrg), 200);
    const name = clean(`${get(r, iFirst) ?? ''} ${get(r, iMid) ?? ''} ${get(r, iLast) ?? ''}`, 120) ?? clean(get(r, iName), 120) ?? company;
    if (!name) continue;
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    rows.push({
      ...blankRow(name),
      email: cleanEmail(get(r, iEmail)),
      phone: normPhone(get(r, iPhone)),
      company,
      position: clean(get(r, iTitle), 200),
    });
  }
  return { rows, truncated };
}

type Person = {
  resourceName?: unknown;
  names?: { displayName?: unknown }[];
  emailAddresses?: { value?: unknown }[];
  phoneNumbers?: { value?: unknown; canonicalForm?: unknown }[];
  organizations?: { name?: unknown; title?: unknown }[];
};

export function mapGooglePerson(p: Person): ImportRow | null {
  const org = p.organizations?.[0];
  const company = clean(org?.name, 200);
  const name = clean(p.names?.[0]?.displayName, 120) ?? company;
  if (!name) return null;
  const ref = typeof p.resourceName === 'string' && /^people\/c?-?\d{1,30}$/.test(p.resourceName) ? p.resourceName : null;
  const tel = p.phoneNumbers?.[0];
  return {
    ...blankRow(name),
    email: cleanEmail(p.emailAddresses?.find((e) => cleanEmail(e.value))?.value),
    phone: normPhone(tel?.canonicalForm) ?? normPhone(tel?.value),
    source_ref: ref,
    company,
    position: clean(org?.title, 200),
  };
}

// Google People API: the signed-in user's own contacts (not "other contacts").
// Follows nextPageToken up to MAX_ROWS; Bearer header keeps the token out of
// URLs. Returns what it has on any failure so sign-in never breaks.
export async function fetchGoogleContacts(token: string, doFetch: typeof fetch = fetch): Promise<ParseResult> {
  const rows: ImportRow[] = [];
  if (!/^[\w.~+/-]{10,2000}$/.test(token)) return { rows, truncated: false };
  let pageToken: string | null = null;
  let truncated = false;
  try {
    for (let page = 0; page < 10; page++) {
      const url = new URL('https://people.googleapis.com/v1/people/me/connections');
      url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!res.ok) break;
      const body = (await res.json()) as { connections?: Person[]; nextPageToken?: string };
      for (const p of body.connections ?? []) {
        const row = mapGooglePerson(p);
        if (!row) continue;
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push(row);
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : null;
      if (!pageToken || truncated) break;
    }
  } catch {
    // network/timeout/bad JSON: keep what we have
  }
  return { rows, truncated };
}

// Android Contact Picker API result: [{ name: string[], email: string[], tel: string[] }].
export function parsePickedContacts(picks: { name?: string[]; email?: string[]; tel?: string[] }[]): ParseResult {
  const rows: ImportRow[] = [];
  let truncated = false;
  for (const p of picks) {
    const name = clean(p.name?.[0], 120) ?? clean(p.email?.[0]?.split('@')[0], 120);
    if (!name) continue;
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    rows.push({
      ...blankRow(name),
      email: p.email?.map(cleanEmail).find(Boolean) ?? null,
      phone: p.tel?.map((t) => normPhone(t)).find(Boolean) ?? null,
    });
  }
  return { rows, truncated };
}
