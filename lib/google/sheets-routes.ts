import 'server-only';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError, requireUser } from '@/lib/http';
import { adminClient } from '@/lib/supabase/admin';
import {
  acquireGoogleSession, authorization, checkpointGoogleSession, consumeGoogleAuthorization,
  createGoogleSession, deleteGoogleSession, discardGoogleSession, exchangeCode, googleConfig,
  googleResponse, googleRoute, releaseGoogleSession, requireGoogleConfig, sameOrigin,
  saveGoogleSession, validState, type GoogleConfig, type Session,
} from './connector';
import {
  exportPreviewBody, exportRange, exportValues, importContact, importPreviewBody, mapImportRows,
  sameValues, spreadsheetId, type SheetContact,
} from './sheets-data';
import { createExportSpreadsheet, exportAccount, readExport, readSpreadsheet, readWorksheet, writeExport } from './sheets-provider';
import type { SheetsPayload, SheetsSessionView } from './sheets-types';

export type SheetsMode = 'import' | 'export';
const purpose = (mode: SheetsMode) => mode === 'import' ? 'sheets-import' as const : 'sheets-export' as const;
const emptyBody = z.object({}).strict();
const confirmBody = z.object({ previewId: z.uuid() }).strict();
// Inputs contain only IDs, mappings and small selections, never raw cells.
// Bound the stream before parsing so malformed clients cannot post huge exports.
async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, 'Send a JSON request body.');
  const decoder = new TextDecoder();
  let size = 0; let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new HttpError(413, 'This selection is too large. Choose a smaller batch.'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new HttpError(400, 'Send a valid JSON request body.'); }
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, result.error.issues.map(issue => `${issue.path.join('.') || 'selection'}: ${issue.message}`).join('; '));
  return result.data;
}
const providerToken = (payload: SheetsPayload) => {
  if (payload.phase !== 'ready' || !payload.token || !payload.tokenExpiresAt || payload.tokenExpiresAt <= Date.now()) throw new HttpError(410, 'This Google connection expired. End the connection and authorize again.');
  return payload.token;
};
const view = (payload: SheetsPayload): SheetsSessionView => ({
  connected: payload.phase === 'ready' && !!payload.token && !!payload.tokenExpiresAt && payload.tokenExpiresAt > Date.now(),
  ...(payload.phase === 'ready' ? { destinationEmail: payload.destinationEmail, source: payload.source, importPreview: payload.importPreview, importRun: payload.importRun, exportPreview: payload.exportPreview, exportRun: payload.exportRun } : {}),
});

async function withSession(req: Request, mode: SheetsMode, work: (config: GoogleConfig, session: Session<SheetsPayload>, auth: Awaited<ReturnType<typeof requireUser>>) => Promise<Response>) {
  const auth = await requireUser(req);
  const config = requireGoogleConfig(purpose(mode));
  sameOrigin(req, config);
  const session = await acquireGoogleSession<SheetsPayload>(config, auth.user.id);
  try {
    if (session.payload.phase !== 'ready') throw new HttpError(409, 'Finish Google authorization first.');
    return await work(config, session, auth);
  } finally { await releaseGoogleSession(config, session); }
}

export const sheetsStatus = (mode: SheetsMode) => googleRoute(async req => {
  const { user, supabase } = await requireUser(req);
  const config = googleConfig(purpose(mode));
  let sessionView: SheetsSessionView = { connected: false };
  if (config) {
    let session: Session<SheetsPayload> | undefined;
    try { session = await acquireGoogleSession<SheetsPayload>(config, user.id); sessionView = view(session.payload); }
    catch (error) { if (!(error instanceof HttpError && error.status === 410)) throw error; }
    finally { if (session) await releaseGoogleSession(config, session); }
  }
  let contacts: { id: string; name: string; email: string | null; category: string }[] = [];
  let contactsTruncated = false;
  if (mode === 'export') {
    const result = await supabase.from('contacts').select('id,name,email,category').eq('user_id', user.id).order('name').limit(1001);
    if (result.error) throw new HttpError(503, 'Your contacts could not be loaded. Please try again.');
    contactsTruncated = (result.data?.length ?? 0) > 1000;
    contacts = (result.data || []).slice(0, 1000);
  }
  return googleResponse({ configured: !!config, session: sessionView, contacts, contactsTruncated });
});

export const sheetsConnect = (mode: SheetsMode) => googleRoute(async req => {
  const { user } = await requireUser(req);
  const config = requireGoogleConfig(purpose(mode));
  sameOrigin(req, config); await parseBody(req, emptyBody);
  // A repeated connect click must not erase an unresolved write receipt.
  let existing: Session<SheetsPayload> | undefined;
  try {
    existing = await acquireGoogleSession<SheetsPayload>(config, user.id);
    if (existing.payload.exportRun && existing.payload.exportRun.state !== 'complete') throw new HttpError(409, 'Check the pending export before explicitly ending this connection.');
    if (existing.payload.importRun && existing.payload.importRun.state !== 'complete') throw new HttpError(409, 'Check your contacts before explicitly ending this connection.');
  } catch (error) { if (!(error instanceof HttpError && error.status === 410)) throw error; }
  finally { if (existing) await releaseGoogleSession(config, existing); }
  const consent = authorization(config);
  await createGoogleSession(config, user.id, { phase: 'oauth', state: consent.state, verifier: consent.verifier } satisfies SheetsPayload);
  return googleResponse({ url: consent.url });
});

export const sheetsCallback = (mode: SheetsMode) => async (req: Request) => {
  const config = googleConfig(purpose(mode));
  // Use only configured origin, never an untrusted Host header for a redirect.
  if (!config) return googleResponse({ error: 'Google Sheets needs administrator setup.' }, 503);
  const destination = new URL('/integrations/google-sheets', config.origin);
  let session: Session<SheetsPayload> | undefined;
  try {
    const { user } = await requireUser(req);
    session = await acquireGoogleSession<SheetsPayload>(config, user.id);
    const url = new URL(req.url);
    if (session.payload.phase !== 'oauth' || !session.payload.state || !session.payload.verifier || !validState(url.searchParams.get('state'), session.payload.state)) throw new HttpError(400, 'Invalid Google authorization state.');
    if (url.searchParams.has('error')) {
      await discardGoogleSession(config, session); destination.searchParams.set('google', 'cancelled');
    } else {
      const code = url.searchParams.get('code');
      if (!code || code.length > 8192) throw new HttpError(400, 'Missing Google authorization code.');
      const verifier = session.payload.verifier;
      await consumeGoogleAuthorization(config, session);
      const token = await exchangeCode(config, code, verifier);
      session.payload = { phase: 'ready', ...token };
      if (mode === 'export') session.payload.destinationEmail = await exportAccount(token.token);
      await saveGoogleSession(config, session);
      destination.searchParams.set('google', purpose(mode));
    }
  } catch {
    // Invalid/replayed callbacks do not erase a newer connection or retain tokens in a redirect.
    destination.searchParams.set('google', 'error');
  } finally { if (session) await releaseGoogleSession(config, session); }
  return NextResponse.redirect(destination, { status: 303, headers: { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' } });
};

export const sheetsDisconnect = (mode: SheetsMode) => googleRoute(async req => {
  const { user } = await requireUser(req);
  const config = requireGoogleConfig(purpose(mode));
  sameOrigin(req, config); await parseBody(req, emptyBody);
  await deleteGoogleSession(config, user.id);
  return googleResponse({ disconnected: true });
});

const sourceBody = z.object({ spreadsheetId, sheetId: z.number().int().min(0).max(2147483647).optional() }).strict();
export const sheetsSource = googleRoute(async req => {
  const input = await parseBody(req, sourceBody);
  return withSession(req, 'import', async (config, session) => {
    if (session.payload.importRun && session.payload.importRun.state !== 'complete') throw new HttpError(409, 'Check the prior import before loading another preview.');
    const token = providerToken(session.payload);
    if (input.sheetId === undefined) return googleResponse(await readSpreadsheet(token, input.spreadsheetId));
    session.payload.source = await readWorksheet(token, input.spreadsheetId, input.sheetId);
    delete session.payload.importPreview;
    await saveGoogleSession(config, session);
    return googleResponse({ source: session.payload.source });
  });
});

export const sheetsImportPreview = googleRoute(async req => {
  const input = await parseBody(req, importPreviewBody);
  return withSession(req, 'import', async (config, session) => {
    if (session.payload.importRun && session.payload.importRun.state !== 'complete') throw new HttpError(409, 'Check the prior import before preparing another batch.');
    if (!session.payload.source) throw new HttpError(409, 'Load a worksheet before previewing rows.');
    const rows = mapImportRows(session.payload.source, input);
    const { data, error } = await adminClient().rpc('preview_google_contact_duplicates', { p_owner: session.owner, p_contacts: rows.filter(r => r.contact).map(r => ({ id: String(r.row), name: r.contact!.name, email: r.contact!.email })) });
    if (error) throw new HttpError(503, 'Could not check for existing contacts. No contacts were changed.');
    const duplicateIds = new Set((data || []).map((row: { id: string }) => row.id));
    const known: SheetContact[] = [];
    const previewRows = rows.map(row => {
      const duplicate = duplicateIds.has(String(row.row)) || !!row.contact && known.some(previous => previous.email && row.contact!.email ? previous.email.toLowerCase() === row.contact!.email!.toLowerCase() : previous.name.toLowerCase() === row.contact!.name.toLowerCase());
      if (row.contact) known.push(row.contact);
      return { ...row, duplicate };
    });
    session.payload.importPreview = { id: randomUUID(), rows: previewRows, includeNotes: input.includeNotes };
    await saveGoogleSession(config, session);
    return googleResponse({ preview: session.payload.importPreview });
  });
});

export const sheetsImportConfirm = googleRoute(async req => {
  const input = await parseBody(req, confirmBody);
  return withSession(req, 'import', async (config, session) => {
    const previous = session.payload.importRun;
    if (previous?.previewId === input.previewId) return googleResponse({ result: previous });
    if (previous && previous.state !== 'complete') throw new HttpError(409, 'The prior import is uncertain. Check your contacts before continuing.');
    const preview = session.payload.importPreview;
    if (!preview || preview.id !== input.previewId) throw new HttpError(409, 'This preview is no longer current. Review the rows again.');
    if (preview.rows.some(row => row.error || !row.contact)) throw new HttpError(400, 'Fix invalid rows before importing.');
    const contacts = preview.rows.filter(row => !row.duplicate).map(row => importContact.parse(row.contact));
    if (!contacts.length) throw new HttpError(400, 'All selected rows are duplicates. No changes are needed.');
    session.payload.importRun = { previewId: preview.id, state: 'running' };
    await checkpointGoogleSession(config, session);
    try {
      const { data, error } = await adminClient().rpc('import_google_contacts', { p_session: session.id, p_owner: session.owner, p_purpose: config.purpose, p_lease: session.lease, p_contacts: contacts });
      if (error) throw new Error('Uncertain contact import');
      const counts = z.object({ added: z.number().int().min(0).max(5), skipped: z.number().int().min(0).max(5) }).parse(data);
      session.payload.importRun = { previewId: preview.id, state: 'complete', added: counts.added, skipped: counts.skipped + preview.rows.filter(row => row.duplicate).length };
      await saveGoogleSession(config, session);
    } catch {
      session.payload.importRun = { previewId: preview.id, state: 'uncertain' };
      try { await saveGoogleSession(config, session); } catch { /* Persisted running intent still blocks retries. */ }
    }
    return googleResponse({ result: session.payload.importRun });
  });
});

export const sheetsExportPreview = googleRoute(async req => {
  const input = await parseBody(req, exportPreviewBody);
  return withSession(req, 'export', async (config, session, { supabase, user }) => {
    if (session.payload.exportRun && session.payload.exportRun.state !== 'complete') throw new HttpError(409, 'Check the pending export before preparing another one.');
    providerToken(session.payload);
    if (!session.payload.destinationEmail) throw new HttpError(409, 'Reconnect to verify the destination Google account before exporting.');
    // Never fetch private notes for an export that did not explicitly select them.
    const columns = `id,name,email,category,interests${input.includeNotes && input.fields.includes('notes') ? ',notes' : ''}`;
    const { data, error } = await supabase.from('contacts').select(columns).eq('user_id', user.id).in('id', input.contactIds);
    if (error) throw new HttpError(503, 'Could not load the selected contacts. No data was sent to Google.');
    const result = z.array(importContact.extend({ id: z.uuid(), notes: z.string().max(5000).nullable().optional() })).safeParse(data);
    if (!result.success || result.data.length !== input.contactIds.length) throw new HttpError(409, 'Some selected contacts no longer exist or are not yours. Select contacts again.');
    const contacts = input.contactIds.map(id => result.data.find(row => row.id === id)!);
    const values = exportValues(contacts.map(row => ({ ...row, notes: row.notes ?? null })), input.fields);
    session.payload.exportPreview = { id: randomUUID(), title: input.title, destinationEmail: session.payload.destinationEmail, fields: input.fields, contactIds: input.contactIds, includeNotes: input.includeNotes && input.fields.includes('notes'), values, range: exportRange(values.length, input.fields.length) };
    await saveGoogleSession(config, session);
    return googleResponse({ preview: session.payload.exportPreview });
  });
});

export const sheetsExportConfirm = googleRoute(async req => {
  const input = await parseBody(req, z.union([confirmBody, z.object({ checkOnly: z.literal(true) }).strict()]));
  return withSession(req, 'export', async (config, session, { supabase, user }) => {
    const preview = session.payload.exportPreview;
    if (!preview) throw new HttpError(409, 'Prepare and review an export first.');
    const previous = session.payload.exportRun;
    if ('checkOnly' in input) {
      if (!previous?.spreadsheetId) throw new HttpError(409, 'No verified spreadsheet ID is available. Check Google Drive manually before starting another export.');
      if (previous.state !== 'complete') {
        const values = await readExport(providerToken(session.payload), previous.spreadsheetId, preview);
        previous.state = sameValues(values, preview.values) ? 'complete' : 'uncertain';
        await saveGoogleSession(config, session);
      }
      return googleResponse({ result: previous });
    }
    if (previous?.previewId === input.previewId) return googleResponse({ result: previous });
    if (previous && previous.state !== 'complete') throw new HttpError(409, 'Check the existing export before starting another one.');
    if (preview.id !== input.previewId) throw new HttpError(409, 'This preview is no longer current. Review the export again.');
    const token = providerToken(session.payload);
    // Recheck ownership at action time. Export only the already reviewed snapshot,
    // never silently substitute changed contact data after preview.
    const { data, error } = await supabase.from('contacts').select('id').eq('user_id', user.id).in('id', preview.contactIds);
    if (error || data?.length !== preview.contactIds.length) throw new HttpError(409, 'Some contacts were removed or are no longer available. Review a new export.');
    session.payload.exportRun = { previewId: preview.id, state: 'creating' };
    await checkpointGoogleSession(config, session);
    try {
      const id = await createExportSpreadsheet(token, preview.title);
      session.payload.exportRun = { previewId: preview.id, state: 'writing', spreadsheetId: id };
      // This must succeed before sending any contact data to the new spreadsheet.
      await checkpointGoogleSession(config, session);
      await writeExport(token, id, preview);
      session.payload.exportRun.state = 'complete';
      await saveGoogleSession(config, session);
    } catch {
      session.payload.exportRun.state = 'uncertain';
      try { await saveGoogleSession(config, session); } catch { /* Persisted creating/writing intent still prevents duplicate writes. */ }
    }
    return googleResponse({ result: session.payload.exportRun });
  });
});
