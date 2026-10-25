import { describe, expect, it } from 'vitest';
import { columnMapping, exportPreviewBody, exportRange, exportValues, importPreviewBody, mapImportRows, normalizeValues, sameValues, sheetRange, spreadsheetId, type SheetSource } from './sheets-data';

const source: SheetSource = { spreadsheetId: 'a'.repeat(30), sheetId: 0, title: 'People', sheetTitle: 'Family', range: "'Family'!A1:Z101", values: [['Name', 'Email', 'Category', 'Interests', 'Notes'], ['Ada', 'ada@example.test', 'professional', 'hiking, tea', 'private'], ['', 'bad', 'other'], ['Ada', 'ada@example.test']] };

describe('bounded Sheets input and exact mapping', () => {
  it('accepts only an ID, never URLs, paths or injected ranges', () => {
    expect(spreadsheetId.parse('a'.repeat(30))).toBe('a'.repeat(30));
    for (const input of ['https://docs.google.com/spreadsheets/d/abc', '../contacts', 'abc?token=secret', 'x'.repeat(201), '']) expect(spreadsheetId.safeParse(input).success).toBe(false);
    expect(sheetRange("Ada's people")).toBe("'Ada''s people'!A1:Z101");
    expect(() => sheetRange('Bad\nSheet')).toThrow();
  });
  it('bounds worksheet size and rejects nested/oversized cells', () => {
    expect(normalizeValues([[1, false, '=literal']])).toEqual([['1', 'false', '=literal']]);
    expect(() => normalizeValues(Array(102).fill([]))).toThrow();
    expect(() => normalizeValues([Array(27).fill('')])).toThrow();
    expect(() => normalizeValues([['x'.repeat(5001)]])).toThrow();
    expect(() => normalizeValues([[{}]])).toThrow();
    expect(() => normalizeValues(Array(100).fill(Array(26).fill('x'.repeat(100))))).toThrow();
  });
  it('rejects duplicated columns, repeated rows, header imports and overlarge batches', () => {
    expect(columnMapping.safeParse({ name: 0, email: 0 }).success).toBe(false);
    for (const rows of [[1], [2, 2], [2, 3, 4, 5, 6, 7], [102]]) expect(importPreviewBody.safeParse({ rows, mapping: { name: 0 }, defaultCategory: 'personal' }).success).toBe(false);
  });
  it('maps selected rows only, shows invalid rows and does not silently repair them', () => {
    const mapped = mapImportRows(source, { rows: [2, 3, 50], mapping: { name: 0, email: 1, category: 2, interests: 3 }, defaultCategory: 'personal', includeNotes: false });
    expect(mapped[0].contact).toEqual({ name: 'Ada', email: 'ada@example.test', category: 'professional', interests: ['hiking', 'tea'], notes: null });
    expect(mapped[1].contact).toBeNull();
    expect(mapped[1].error).toMatch(/name/);
    expect(mapped[2].error).toMatch(/outside/);
  });
  it('cannot map private notes without explicit permission', () => {
    const input = { rows: [2], mapping: { name: 0, notes: 4 }, defaultCategory: 'personal' as const, includeNotes: false };
    expect(importPreviewBody.safeParse(input).success).toBe(false);
    expect(mapImportRows(source, { ...input, includeNotes: true })[0].contact?.notes).toBe('private');
  });
});

describe('selected contact export', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('requires distinct owned-contact IDs, bounded fields and explicit private-note selection', () => {
    const input = { contactIds: [id], fields: ['name'], title: 'My people' };
    expect(exportPreviewBody.safeParse(input).success).toBe(true);
    expect(exportPreviewBody.safeParse({ ...input, contactIds: [id, id] }).success).toBe(false);
    expect(exportPreviewBody.safeParse({ ...input, fields: ['name', 'name'] }).success).toBe(false);
    expect(exportPreviewBody.safeParse({ ...input, fields: ['notes'] }).success).toBe(false);
    expect(exportPreviewBody.safeParse({ ...input, fields: ['notes'], includeNotes: true }).success).toBe(true);
    expect(exportPreviewBody.safeParse({ ...input, title: 'Bad\nTitle' }).success).toBe(false);
  });
  it('preserves formula-looking values as strings for RAW writes and excludes notes by default', () => {
    const values = exportValues([{ name: '=HYPERLINK("bad")', email: null, category: 'personal', interests: ['+literal'], notes: 'do not export' }], ['name', 'interests']);
    expect(values).toEqual([['Name', 'Interests'], ['=HYPERLINK("bad")', '+literal']]);
    expect(JSON.stringify(values)).not.toContain('do not export');
    expect(exportRange(2, 2)).toBe("'Contacts'!A1:B2");
    expect(() => exportRange(102, 2)).toThrow();
  });
  it('compares the full expected rectangle while allowing omitted trailing blank cells', () => {
    expect(sameValues([['Name', 'Email'], ['Ada']], [['Name', 'Email'], ['Ada', '']])).toBe(true);
    expect(sameValues([['Name'], ['Eve']], [['Name'], ['Ada']])).toBe(false);
    expect(sameValues([['Name'], ['Ada'], ['Extra']], [['Name'], ['Ada']])).toBe(false);
  });
});
