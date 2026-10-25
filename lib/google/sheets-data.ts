import { z } from 'zod';

export const SHEETS_MAX_ROWS = 100;
export const SHEETS_MAX_COLUMNS = 26;
export const SHEETS_IMPORT_BATCH = 5;
export const SHEETS_MAX_EXPORT = 100;
export const spreadsheetId = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/, 'Use a valid Google spreadsheet ID');
export const sheetsMode = z.enum(['import', 'export']);
export const sheetFields = ['name', 'email', 'category', 'interests', 'notes'] as const;
export type SheetField = typeof sheetFields[number];
export const fieldLabels: Record<SheetField, string> = { name: 'Name', email: 'Email', category: 'Category', interests: 'Interests', notes: 'Private notes' };
export const columnMapping = z.object({
  name: z.number().int().min(0).max(25),
  email: z.number().int().min(0).max(25).optional(),
  category: z.number().int().min(0).max(25).optional(),
  interests: z.number().int().min(0).max(25).optional(),
  notes: z.number().int().min(0).max(25).optional(),
}).strict().refine(m => new Set(Object.values(m)).size === Object.values(m).length, 'Map each column only once');
export type ColumnMapping = z.infer<typeof columnMapping>;
export const importPreviewBody = z.object({
  rows: z.array(z.number().int().min(2).max(SHEETS_MAX_ROWS + 1)).min(1).max(SHEETS_IMPORT_BATCH),
  mapping: columnMapping,
  defaultCategory: z.enum(['personal', 'professional', 'community']),
  includeNotes: z.boolean().default(false),
}).strict().refine(b => new Set(b.rows).size === b.rows.length, 'Select each row only once')
  .refine(b => b.includeNotes || b.mapping.notes === undefined, 'Explicitly allow private notes before mapping them');
export const exportPreviewBody = z.object({
  contactIds: z.array(z.uuid()).min(1).max(SHEETS_MAX_EXPORT),
  fields: z.array(z.enum(sheetFields)).min(1).max(sheetFields.length),
  title: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/, 'Use a title without control characters'),
  includeNotes: z.boolean().default(false),
}).strict().refine(b => new Set(b.contactIds).size === b.contactIds.length, 'Select each contact only once')
  .refine(b => new Set(b.fields).size === b.fields.length, 'Select each field only once')
  .refine(b => !b.fields.includes('notes') || b.includeNotes, 'Explicitly allow private notes before exporting them');

export const importContact = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254).nullable(),
  category: z.enum(['personal', 'professional', 'community']),
  interests: z.array(z.string().trim().min(1).max(40)).max(20),
  notes: z.string().max(5000).nullable(),
});
export type SheetContact = z.infer<typeof importContact>;
export type ImportRow = { row: number; contact: SheetContact | null; error: string | null };
export type SheetSource = { spreadsheetId: string; title: string; sheetId: number; sheetTitle: string; range: string; values: string[][] };
export type ExportPreview = { id: string; title: string; destinationEmail: string; fields: SheetField[]; contactIds: string[]; values: string[][]; range: string; includeNotes: boolean };

// No caller-controlled A1 expression: tab names are quoted and quotes escaped.
export function sheetRange(title: string) {
  if (!title || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('Invalid worksheet title');
  return `'${title.replace(/'/g, "''")}'!A1:Z101`;
}

export function normalizeValues(raw: unknown): string[][] {
  const values = z.array(z.array(z.union([z.string().max(5000), z.number().finite(), z.boolean()])).max(SHEETS_MAX_COLUMNS)).max(SHEETS_MAX_ROWS + 1).parse(raw ?? []);
  const strings = values.map(row => row.map(value => String(value)));
  if (new TextEncoder().encode(JSON.stringify(strings)).byteLength > 200_000) throw new Error('This range is too large. Use a smaller worksheet.');
  return strings;
}

export function mapImportRows(source: SheetSource, input: z.infer<typeof importPreviewBody>): ImportRow[] {
  const parsed = importPreviewBody.parse(input);
  return parsed.rows.map(row => {
    const cells = source.values[row - 1];
    if (!cells) return { row, contact: null, error: 'This row is outside the loaded preview.' };
    const value = (field: SheetField) => {
      const index = parsed.mapping[field];
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };
    const result = importContact.safeParse({
      name: value('name'), email: value('email') || null,
      category: value('category').toLowerCase() || parsed.defaultCategory,
      interests: value('interests').split(',').map(s => s.trim()).filter(Boolean),
      notes: parsed.includeNotes ? value('notes') || null : null,
    });
    return result.success ? { row, contact: result.data, error: null } : { row, contact: null, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  });
}

export function exportValues(contacts: SheetContact[], fields: SheetField[]): string[][] {
  const selected = z.array(z.enum(sheetFields)).min(1).max(5).parse(fields);
  if (contacts.length < 1 || contacts.length > SHEETS_MAX_EXPORT) throw new Error('Select between 1 and 100 contacts.');
  const values = [selected.map(field => fieldLabels[field]), ...contacts.map(c => {
    const contact = importContact.parse(c);
    return selected.map(field => field === 'interests' ? contact.interests.join(', ') : String(contact[field] ?? ''));
  })];
  if (new TextEncoder().encode(JSON.stringify(values)).byteLength > 200_000) throw new Error('The export exceeds 200 KB. Select fewer contacts or omit notes.');
  // Keep all values as strings. The provider must write with RAW, never USER_ENTERED.
  return values;
}

export function exportRange(rows: number, columns: number) {
  if (!Number.isInteger(rows) || rows < 2 || rows > 101 || !Number.isInteger(columns) || columns < 1 || columns > 5) throw new Error('Invalid export size');
  return `'Contacts'!A1:${String.fromCharCode(64 + columns)}${rows}`;
}

export function sameValues(a: string[][], b: string[][]) {
  // Sheets omits trailing empty cells and rows, so compare the entire expected rectangle.
  if (a.length > b.length || a.some(row => row.length > b[0].length)) return false;
  return b.every((row, r) => row.every((value, c) => value === (a[r]?.[c] ?? '')));
}
