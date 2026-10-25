import type { ExportPreview, ImportRow, SheetSource } from './sheets-data';

export type ImportPreview = { id: string; rows: (ImportRow & { duplicate: boolean })[]; includeNotes: boolean };
export type ImportRun = { previewId: string; state: 'running' | 'complete' | 'uncertain'; added?: number; skipped?: number };
export type ExportRun = { previewId: string; state: 'creating' | 'writing' | 'complete' | 'uncertain'; spreadsheetId?: string };
export type SheetsPayload = {
  phase: 'oauth' | 'ready'; state?: string; verifier?: string;
  token?: string; tokenExpiresAt?: number; destinationEmail?: string;
  source?: SheetSource; importPreview?: ImportPreview; importRun?: ImportRun;
  exportPreview?: ExportPreview; exportRun?: ExportRun;
};
export type SheetsSessionView = {
  connected: boolean; destinationEmail?: string; source?: SheetSource; importPreview?: ImportPreview; importRun?: ImportRun;
  exportPreview?: ExportPreview; exportRun?: ExportRun;
};
export type SheetsStatus = {
  configured: { import: boolean; export: boolean };
  sessions: { import: SheetsSessionView; export: SheetsSessionView };
  contacts: { id: string; name: string; email: string | null; category: string }[];
  contactsTruncated: boolean;
};
