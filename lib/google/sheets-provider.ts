import 'server-only';
import { z } from 'zod';
import { HttpError } from '@/lib/http';
import { googleJson } from './connector';
import { normalizeValues, sheetRange, spreadsheetId, type SheetSource, type ExportPreview } from './sheets-data';

const endpoint = 'https://sheets.googleapis.com/v4/spreadsheets';
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const metadataSchema = z.object({
  spreadsheetId,
  properties: z.object({ title: z.string().max(256) }),
  sheets: z.array(z.object({ properties: z.object({ sheetId: z.number().int().min(0), title: z.string().min(1).max(100) }) })).max(200),
});

export async function exportAccount(token: string) {
  // drive.file already authorizes this minimal account lookup. No extra scope,
  // file listing, quota, or unrelated account fields are requested.
  const raw = await googleJson('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: headers(token) });
  const result = z.object({ user: z.object({ emailAddress: z.email().max(254) }) }).safeParse(raw);
  if (!result.success) throw new HttpError(502, 'Could not verify the destination Google account. Reconnect before exporting.');
  return result.data.user.emailAddress;
}

export async function readSpreadsheet(token: string, id: string) {
  const validId = spreadsheetId.parse(id);
  const raw = await googleJson(`${endpoint}/${validId}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title))`, { headers: headers(token) });
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success || parsed.data.spreadsheetId !== validId) throw new HttpError(502, 'Google returned an unsupported spreadsheet. Choose a file with at most 200 tabs.');
  return { spreadsheetId: validId, title: parsed.data.properties.title, sheets: parsed.data.sheets.map(sheet => sheet.properties) };
}

export async function readWorksheet(token: string, id: string, sheetId: number): Promise<SheetSource> {
  const book = await readSpreadsheet(token, id);
  const sheet = book.sheets.find(sheet => sheet.sheetId === sheetId);
  if (!sheet) throw new HttpError(400, 'Choose a worksheet from this spreadsheet.');
  const range = sheetRange(sheet.title);
  const raw = await googleJson(`${endpoint}/${book.spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, { headers: headers(token) });
  const body = z.object({ values: z.unknown().optional() }).safeParse(raw);
  if (!body.success) throw new HttpError(502, 'Google returned an invalid worksheet.');
  try {
    return { spreadsheetId: book.spreadsheetId, title: book.title, sheetId, sheetTitle: sheet.title, range, values: normalizeValues(body.data.values) };
  } catch {
    throw new HttpError(400, 'The preview is too large or contains unsupported values. Use at most 26 columns, 100 data rows and 200 KB.');
  }
}

// Called only after persisting an explicit export operation as "creating".
// This POST is not idempotent. A timeout MUST NOT be automatically retried.
export async function createExportSpreadsheet(token: string, title: string) {
  const raw = await googleJson(endpoint, {
    method: 'POST', headers: headers(token),
    body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: 'Contacts', gridProperties: { rowCount: 101, columnCount: 5 } } }] }),
  });
  const result = z.object({ spreadsheetId }).safeParse(raw);
  if (!result.success) throw new HttpError(502, 'The spreadsheet creation result could not be verified. Check Google Drive before starting another export.');
  return result.data.spreadsheetId;
}

export async function writeExport(token: string, id: string, preview: ExportPreview) {
  const validId = spreadsheetId.parse(id);
  const raw = await googleJson(`${endpoint}/${validId}/values/${encodeURIComponent(preview.range)}?valueInputOption=RAW`, {
    method: 'PUT', headers: headers(token),
    body: JSON.stringify({ range: preview.range, majorDimension: 'ROWS', values: preview.values }),
  });
  const result = z.object({ spreadsheetId, updatedRange: z.string().max(100), updatedRows: z.number().int(), updatedColumns: z.number().int(), updatedCells: z.number().int() }).safeParse(raw);
  if (!result.success || result.data.spreadsheetId !== validId || result.data.updatedRange.replace(/^'Contacts'!/, 'Contacts!') !== preview.range.replace(/^'Contacts'!/, 'Contacts!')
    || result.data.updatedRows !== preview.values.length || result.data.updatedColumns !== preview.fields.length || result.data.updatedCells !== preview.values.length * preview.fields.length) {
    throw new HttpError(502, 'The write receipt could not be verified. Check the existing export before continuing.');
  }
}

export async function readExport(token: string, id: string, preview: ExportPreview) {
  const validId = spreadsheetId.parse(id);
  const raw = await googleJson(`${endpoint}/${validId}/values/${encodeURIComponent(preview.range)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`, { headers: headers(token) });
  const body = z.object({ values: z.unknown().optional() }).safeParse(raw);
  if (!body.success) throw new HttpError(502, 'The export result could not be verified.');
  return normalizeValues(body.data.values);
}
