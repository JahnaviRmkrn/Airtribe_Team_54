import { describe, expect, it } from 'vitest';
import { blankRow, classify, normName, normPhone, parseCsv, readCappedText, type ImportRow } from './import';

const row = (name: string, extra: Partial<ImportRow> = {}): ImportRow => ({ ...blankRow(name), ...extra });

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded commas and newlines, CRLF and BOM', () => {
    const rows = parseCsv('﻿a,"b, c","say ""hi""","x\ny"\r\n1,2,3,4\r\n');
    expect(rows).toEqual([['a', 'b, c', 'say "hi"', 'x\ny'], ['1', '2', '3', '4']]);
  });
  it('keeps empty trailing fields, skips blank lines, survives an unterminated quote', () => {
    expect(parseCsv('a,b,\n\nc,,\n')).toEqual([['a', 'b', ''], ['c', '', '']]);
    expect(() => parseCsv('a,"never closed\nb,c')).not.toThrow();
  });
  it('stops at maxRows', () => {
    expect(parseCsv('a\nb\nc\nd', 2)).toHaveLength(2);
  });
});

describe('normPhone', () => {
  it('normalises Indian numbers', () => {
    for (const n of ['98765 43210', '098765 43210', '+91 98765-43210', '91 9876543210', '0091 98765 43210']) expect(normPhone(n)).toBe('+919876543210');
  });
  it('trusts explicit country codes and rejects ambiguous or junk input', () => {
    expect(normPhone('+1 (415) 555-0132')).toBe('+14155550132');
    expect(normPhone('022 2345 6789')).toBeNull(); // landline without a region
    expect(normPhone('12345')).toBeNull();
    expect(normPhone('call me')).toBeNull();
    expect(normPhone(null)).toBeNull();
    expect(normPhone('+91 98765 43210 ext 12')).toBe('+919876543210');
  });
});

describe('normName', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normName('  José  ÁLVAREZ-Jr. ')).toBe('jose alvarez jr');
  });
});

describe('classify', () => {
  const existing = [
    { name: 'Priya Raman', email: 'priya@example.com', phone: null, source: null, source_ref: null },
    { name: 'Sam Lee', email: null, phone: null, source: null, source_ref: null },
    { name: 'Meera Iyer', email: 'meera@work.com', phone: '+919876543210', source: 'linkedin', source_ref: 'https://www.linkedin.com/in/meera' },
  ];
  it('matches by email, case-insensitively', () => {
    expect(classify(existing, [row('P R', { email: 'PRIYA@example.com' })], 'linkedin')).toEqual(['duplicate']);
  });
  it('matches by phone', () => {
    expect(classify(existing, [row('Someone Else', { phone: '+919876543210' })], 'vcard')).toEqual(['duplicate']);
  });
  it('falls back to the normalised name when email is absent', () => {
    expect(classify(existing, [row('priya  RAMAN')], 'facebook')).toEqual(['duplicate']);
    expect(classify(existing, [row('Sam Lee', { email: 'sam@new.com' })], 'google')).toEqual(['duplicate']); // existing has no email or phone
  });
  it('keeps same-name people apart when both have different emails', () => {
    expect(classify(existing, [row('Priya Raman', { email: 'other.priya@example.com' })], 'linkedin')).toEqual(['new']);
  });
  it('marks an already-imported source_ref as update (re-import refreshes it)', () => {
    expect(classify(existing, [row('Meera I.', { source_ref: 'https://www.linkedin.com/in/meera' })], 'linkedin')).toEqual(['update']);
    expect(classify(existing, [row('Meera I.', { source_ref: 'https://www.linkedin.com/in/meera' })], 'facebook')).toEqual(['new']);
  });
  it('dedupes within the file itself', () => {
    const v = classify([], [row('A B', { email: 'a@x.com' }), row('a b', { email: 'a@x.com' }), row('C', { source_ref: 'r' }), row('C2', { source_ref: 'r' })], 'linkedin');
    expect(v).toEqual(['new', 'duplicate', 'new', 'duplicate']);
  });
});

describe('readCappedText', () => {
  const post = (body: string, headers: Record<string, string> = {}) => new Request('https://x/', { method: 'POST', body, headers });
  it('reads bodies within the cap', async () => {
    expect(await readCappedText(post('héllo'), 100)).toBe('héllo');
  });
  it('refuses bodies over the cap, declared or streamed', async () => {
    expect(await readCappedText(post('x'.repeat(50)), 10)).toBeNull();
    expect(await readCappedText(post('x', { 'content-length': '999' }), 10)).toBeNull();
  });
});
