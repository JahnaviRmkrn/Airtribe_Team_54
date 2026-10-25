import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fetchGraphFriends, fixMojibake, parseFacebookFriends, parseFacebookHtml, parseFacebookJson } from './import-facebook';
import { fetchGoogleContacts, mapGooglePerson, parseGoogleCsv, parsePickedContacts } from './import-google';
import { linkedinDate, linkedinRef, parseLinkedInCsv } from './import-linkedin';
import { parseVcard } from './import-vcard';

const fx = (name: string) => readFileSync(new URL(`../fixtures/import/${name}`, import.meta.url), 'utf8');

describe('LinkedIn Connections.csv', () => {
  it('skips the Notes preamble, finds the header and parses quoted fields', () => {
    const { rows, truncated } = parseLinkedInCsv(fx('Connections.csv'));
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.name)).toEqual(['Priya Raman', 'Arjun Mehta', 'Zoë O"Brien', 'Meera Iyer']); // blank-name row dropped
    expect(rows[0]).toMatchObject({ email: 'priya@example.com', company: 'Acme, Inc.', position: 'Staff Engineer', source_ref: 'https://www.linkedin.com/in/priya-raman-123', notes: 'Connected on LinkedIn 2021-01-12' });
    expect(rows[1]).toMatchObject({ email: null, company: 'Globex Corporation', position: 'Director, Product & Strategy', source_ref: 'https://www.linkedin.com/in/arjunmehta' });
    expect(rows[2]).toMatchObject({ company: null, position: null });
    expect(rows[3].email).toBeNull(); // "not-an-email"
    expect(rows[3].notes).toBe('Connected on LinkedIn 2023-12-07');
  });
  it('handles CRLF and a BOM identically', () => {
    expect(parseLinkedInCsv(fx('Connections.crlf-bom.csv')).rows).toEqual(parseLinkedInCsv(fx('Connections.csv')).rows);
  });
  it('works without a preamble and with reordered columns', () => {
    const { rows } = parseLinkedInCsv('Last Name,First Name,Company\nRaman,Priya,Acme\n');
    expect(rows).toEqual([expect.objectContaining({ name: 'Priya Raman', company: 'Acme', email: null })]);
  });
  it('rejects other files and caps rows', () => {
    expect(() => parseLinkedInCsv('a,b\n1,2')).toThrow(/Connections\.csv/);
    const big = 'First Name,Last Name\n' + Array.from({ length: 5100 }, (_, i) => `A${i},B`).join('\n');
    const r = parseLinkedInCsv(big);
    expect(r.rows).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });
  it('normalises profile URLs and dates', () => {
    expect(linkedinRef('http://LinkedIn.com/in/Foo/?x=1#y')).toBe('https://linkedin.com/in/foo');
    expect(linkedinRef('https://evil.com/in/foo')).toBeNull();
    expect(linkedinRef('not a url at all')).toBeNull();
    expect(linkedinDate('3 Sept 2020')).toBe('2020-09-03');
    expect(linkedinDate('garbage')).toBeNull();
  });
});

describe('Facebook friends', () => {
  it('decodes mojibake names from the JSON export', () => {
    const { rows } = parseFacebookJson(fx('your_friends.json'));
    expect(rows.map((r) => r.name)).toEqual(['José Álvarez', 'Zoë Müller', 'Renée Ångström', 'Priya Raman', 'Plain Ascii', '李 小龍']);
    expect(rows[0]).toMatchObject({ email: null, source_ref: null });
  });
  it('leaves correct text alone', () => {
    expect(fixMojibake('José')).toBe('José');
    expect(fixMojibake('Ã©')).toBe('é');
    expect(fixMojibake('Ã')).toBe('Ã'); // not valid UTF-8 on its own
  });
  it('accepts friends / bare array and rejects junk', () => {
    expect(parseFacebookJson('{"friends":[{"name":"A"}]}').rows).toHaveLength(1);
    expect(parseFacebookJson('[{"name":"A"},{"nope":1}]').rows).toHaveLength(1);
    expect(() => parseFacebookJson('{"other":1}')).toThrow(/No friends/);
    expect(() => parseFacebookJson('not json')).toThrow(/valid JSON/);
  });
  it('parses the HTML variant and picks the format by content', () => {
    const html = '<html><body><div><h2 class="_a6-h _a6-i">Ana &amp; Co</h2><div>Jan 1</div></div><div><h2>Bob</h2></div></body></html>';
    expect(parseFacebookHtml(html).rows.map((r) => r.name)).toEqual(['Ana & Co', 'Bob']);
    expect(parseFacebookFriends(html).rows).toHaveLength(2);
    expect(parseFacebookFriends(fx('your_friends.json')).rows).toHaveLength(6);
  });
  it('follows Graph API paging with a Bearer header and tolerates failure', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const pages = [
      { data: [{ id: '1', name: 'Ana' }], paging: { cursors: { after: 'C1' }, next: 'https://graph.facebook.com/next' } },
      { data: [{ id: '2', name: 'JosÃ©' }, { id: 'bad id', name: 'Zed' }], paging: { cursors: { after: 'C2' } } },
    ];
    const f = vi.fn(async (u: URL | string, init?: RequestInit) => {
      calls.push({ url: String(u), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify(pages[calls.length - 1]));
    });
    const { rows } = await fetchGraphFriends('EAAtoken1234567890', f as unknown as typeof fetch);
    expect(rows.map((r) => [r.name, r.source_ref])).toEqual([['Ana', '1'], ['José', '2'], ['Zed', null]]);
    expect(calls[0].url).toContain('/v21.0/me/friends?fields=id%2Cname&limit=500');
    expect(calls[1].url).toContain('after=C1');
    expect(calls.every((c) => c.auth === 'Bearer EAAtoken1234567890' && !c.url.includes('EAAtoken'))).toBe(true);
    // empty (no friends use the app), HTTP error, network error, bad token
    expect((await fetchGraphFriends('EAAtoken1234567890', (async () => new Response('{"data":[]}')) as typeof fetch)).rows).toEqual([]);
    expect((await fetchGraphFriends('EAAtoken1234567890', (async () => new Response('{}', { status: 400 })) as typeof fetch)).rows).toEqual([]);
    expect((await fetchGraphFriends('EAAtoken1234567890', (async () => { throw new Error('down'); }) as typeof fetch)).rows).toEqual([]);
    const never = vi.fn();
    expect((await fetchGraphFriends('bad token!', never as unknown as typeof fetch)).rows).toEqual([]);
    expect(never).not.toHaveBeenCalled();
  });
});

describe('vCard', () => {
  it('parses iCloud 3.0 cards: folding, escapes, ORG, phones, UID, skips PHOTO', () => {
    const { rows } = parseVcard(fx('iphone.vcf'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'José Álvarez',
      email: 'jose@example.com',
      phone: '+919876543210',
      company: 'Initech, Ltd.',
      position: 'Staff Engineer',
      source_ref: '5E1C7A04-0000-4000-8000-ABCDEF012345',
    });
    expect(JSON.stringify(rows)).not.toContain('/9j/');
    expect(rows[1]).toMatchObject({ name: 'Kavya Nair', phone: null, source_ref: null }); // landline has no region
  });
  it('parses 2.1 quoted-printable with charset, 4.0 uri phones and urn:uuid UIDs, skips nameless cards', () => {
    const { rows } = parseVcard(fx('android.vcf'));
    expect(rows.map((r) => r.name)).toEqual(['Élise Émilie', 'Sam Lee']);
    expect(rows[0]).toMatchObject({ company: 'Café Corp', phone: '+919811122233' });
    expect(rows[1]).toMatchObject({ email: 'sam@example.org', phone: '+14155550199', source_ref: '11111111-2222-3333-4444-555555555555' });
  });
  it('unfolds CRLF + tab, falls back to N, and copes with bad input', () => {
    const { rows } = parseVcard('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Raman;Priya;;Dr.;\r\nEMAIL:priya@exa\r\n\tmple.com\r\nEND:VCARD\r\nBEGIN:VCARD\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Unclosed');
    expect(rows).toEqual([expect.objectContaining({ name: 'Dr. Priya Raman', email: 'priya@example.com' })]);
    expect(() => parseVcard('hello')).toThrow(/vcf/);
  });
  it('skips a multi-megabyte photo without keeping it', () => {
    const photo = 'PHOTO;ENCODING=b;TYPE=JPEG:' + 'A'.repeat(100) + '\r\n' + (' ' + 'A'.repeat(75) + '\r\n').repeat(40_000);
    const { rows } = parseVcard(`BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Big Photo\r\n${photo}END:VCARD\r\n`);
    expect(JSON.stringify(rows).length).toBeLessThan(400);
    expect(rows[0].name).toBe('Big Photo');
  });
});

describe('Google Contacts', () => {
  it('parses the new Google CSV format', () => {
    const { rows } = parseGoogleCsv(fx('google-new.csv'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ name: 'Kavya Nair', email: 'kavya@example.com', phone: '+919876543210', company: 'Hooli', position: 'Designer' });
    expect(rows[1]).toMatchObject({ name: 'Rahul K Sharma', email: 'rahul@example.com', phone: '+14155550132' }); // first of the ":::" list
    expect(rows[2]).toMatchObject({ name: 'Pied Piper', phone: null, company: 'Pied Piper' }); // org-only contact
  });
  it('parses the old Google CSV format', () => {
    const { rows } = parseGoogleCsv(fx('google-old.csv'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'Kavya Nair', email: 'kavya@example.com', phone: '+919876543210', company: 'Hooli', position: 'Designer' });
    expect(rows[1]).toMatchObject({ name: 'Dev Patel', phone: '+442079460958' });
  });
  it('rejects other CSVs', () => {
    expect(() => parseGoogleCsv('a,b\n1,2')).toThrow(/Google/);
  });
  it('maps People API connections', () => {
    expect(
      mapGooglePerson({
        resourceName: 'people/c12345',
        names: [{ displayName: 'Kavya Nair' }],
        emailAddresses: [{ value: 'nope' }, { value: 'Kavya@Example.com' }],
        phoneNumbers: [{ value: '098765 43210', canonicalForm: '+919876543210' }],
        organizations: [{ name: 'Hooli', title: 'Designer' }],
      }),
    ).toEqual({ name: 'Kavya Nair', email: 'kavya@example.com', phone: '+919876543210', source_ref: 'people/c12345', company: 'Hooli', position: 'Designer', notes: null });
    expect(mapGooglePerson({ resourceName: 'people/c1' })).toBeNull();
    expect(mapGooglePerson({ resourceName: '../../etc', names: [{ displayName: 'X' }] })?.source_ref).toBeNull();
  });
  it('pages through the People API with a Bearer header', async () => {
    const urls: string[] = [];
    const bodies = [
      { connections: [{ resourceName: 'people/c1', names: [{ displayName: 'Ana' }] }, { resourceName: 'people/c2' }], nextPageToken: 'T2' },
      { connections: [{ resourceName: 'people/c3', names: [{ displayName: 'Bob' }] }] },
    ];
    const f = (async (u: URL, init: RequestInit) => {
      urls.push(String(u));
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer ya29.token-value_123');
      return new Response(JSON.stringify(bodies[urls.length - 1]));
    }) as unknown as typeof fetch;
    const { rows } = await fetchGoogleContacts('ya29.token-value_123', f);
    expect(rows.map((r) => r.name)).toEqual(['Ana', 'Bob']);
    expect(urls[0]).toContain('personFields=names%2CemailAddresses%2CphoneNumbers%2Corganizations');
    expect(urls[0]).toContain('pageSize=1000');
    expect(urls[1]).toContain('pageToken=T2');
    expect((await fetchGoogleContacts('ya29.token-value_123', (async () => new Response('{}', { status: 403 })) as typeof fetch)).rows).toEqual([]);
  });
  it('maps Android Contact Picker results', () => {
    const { rows } = parsePickedContacts([
      { name: ['Kavya Nair'], email: ['kavya@example.com'], tel: ['098765 43210'] },
      { name: [], email: ['only@example.com'], tel: [] },
      { name: [], email: [], tel: ['+1 415 555 0132'] },
    ]);
    expect(rows.map((r) => [r.name, r.email, r.phone])).toEqual([['Kavya Nair', 'kavya@example.com', '+919876543210'], ['only', 'only@example.com', null]]);
  });
});

describe('hostile input stays fast', () => {
  const fast = (fn: () => unknown) => {
    const t = Date.now();
    try { fn(); } catch { /* a rejection is fine */ }
    expect(Date.now() - t).toBeLessThan(1500);
  };
  it('facebook html with unclosed <h2 tags', () => fast(() => parseFacebookHtml('<h2'.repeat(1_500_000))));
  it('vcard with an endless quoted-printable soft break', () =>
    fast(() => parseVcard('BEGIN:VCARD\r\nNOTE;ENCODING=QUOTED-PRINTABLE:=\r\n' + 'a=\r\n'.repeat(2_000_000) + 'END:VCARD\r\n')));
  it('vcard with an endless folded line', () =>
    fast(() => parseVcard('BEGIN:VCARD\r\nFN:x\r\nNOTE:a\r\n' + ' bbbbbbbb\r\n'.repeat(1_000_000) + 'END:VCARD\r\n')));
  it('still joins ordinary soft breaks', () => {
    const { rows } = parseVcard('BEGIN:VCARD\r\nFN;ENCODING=QUOTED-PRINTABLE:Ana=\r\n Maria\r\nEND:VCARD');
    expect(rows[0].name).toBe('Ana Maria');
  });
});
