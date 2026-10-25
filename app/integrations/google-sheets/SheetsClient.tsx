'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fieldLabels, sheetFields, type ColumnMapping, type SheetField } from '@/lib/google/sheets-data';
import type { SheetsStatus } from '@/lib/google/sheets-types';

type Book = { spreadsheetId: string; title: string; sheets: { sheetId: number; title: string }[] };
const base = '/api/me/integrations/google/sheets-';
async function api<T>(mode: 'import' | 'export', path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(base + mode + path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed. Check the current status before trying again.');
  return data as T;
}

function ValueTable({ values }: { values: string[][] }) {
  return <div className="sheets-table"><table><tbody>{values.map((row, r) => <tr key={r}>{row.map((cell, c) => r === 0 ? <th key={c} scope="col">{cell}</th> : <td key={c}>{cell || '—'}</td>)}</tr>)}</tbody></table></div>;
}

export default function SheetsClient() {
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [mode, setMode] = useState<'import' | 'export'>('import');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [id, setId] = useState('');
  const [book, setBook] = useState<Book | null>(null);
  const [tab, setTab] = useState('');
  const [rows, setRows] = useState<number[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({ name: 0 });
  const [defaultCategory, setDefaultCategory] = useState('personal');
  const [importNotes, setImportNotes] = useState(false);
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [fields, setFields] = useState<SheetField[]>(['name', 'email', 'category', 'interests']);
  const [exportNotes, setExportNotes] = useState(false);
  const [title, setTitle] = useState('muop contacts');
  const [review, setReview] = useState<'import' | 'export' | null>(null);
  const refresh = useCallback(async () => {
    const [incoming, outgoing] = await Promise.all([api<{ configured: boolean; session: SheetsStatus['sessions']['import'] }>('import', '/status'), api<{ configured: boolean; session: SheetsStatus['sessions']['export']; contacts: SheetsStatus['contacts']; contactsTruncated: boolean }>('export', '/status')]);
    const next: SheetsStatus = { configured: { import: incoming.configured, export: outgoing.configured }, sessions: { import: incoming.session, export: outgoing.session }, contacts: outgoing.contacts, contactsTruncated: outgoing.contactsTruncated };
    if (mounted.current) setStatus(next);
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh().catch(e => { if (mounted.current) setError(e.message); });
    const result = new URLSearchParams(location.search).get('google');
    if (result === 'cancelled') setNotice('Google authorization was cancelled. No contacts or spreadsheets were changed.');
    if (result === 'error') setError('Google authorization did not complete. Nothing was imported or exported. Try connecting again.');
    if (result === 'sheets-export') setMode('export');
    return () => { mounted.current = false; };
  }, [refresh]);

  // The ref closes the same-tick double-click window before React renders disabled controls.
  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : 'The request failed. Check status before trying again.'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const connect = () => run(async () => {
    const result = await api<{ url: string }>(mode, '/connect', {});
    if (!mounted.current) return;
    const url = new URL(result.url);
    if (url.origin !== 'https://accounts.google.com') throw new Error('Invalid Google authorization destination.');
    location.assign(url.href);
  });
  const endSession = () => run(async () => {
    await api(mode, '/disconnect', {});
    setReview(null); setBook(null); setRows([]);
    await refresh(); setNotice('This connection has ended. This does not undo a confirmed import/export or stop a request already sent. Existing Google grants can be removed in your Google account.');
  });
  const loadBook = () => run(async () => {
    const next = await api<Book>('import', '/source', { spreadsheetId: id.trim() });
    setBook(next); setTab(''); setRows([]); setReview(null);
  });
  const loadRows = () => run(async () => {
    await api('import', '/source', { spreadsheetId: book!.spreadsheetId, sheetId: Number(tab) });
    setRows([]); setMapping({ name: 0 }); setImportNotes(false); setReview(null); await refresh();
  });
  const previewImport = () => run(async () => {
    await api('import', '/preview', { rows, mapping, defaultCategory, includeNotes: importNotes });
    await refresh(); setReview('import');
  });
  const confirmImport = () => run(async () => {
    const previewId = status!.sessions.import.importPreview!.id;
    // The server may commit even if this browser loses the response. Hide all
    // repeat-write controls before dispatch; only a status read can resolve it.
    setReview(null);
    setStatus(current => current && { ...current, sessions: { ...current.sessions, import: { ...current.sessions.import, importRun: { previewId, state: 'running' } } } });
    await api('import', '/confirm', { previewId });
    await refresh(); setRows([]);
  });
  const previewExport = () => run(async () => {
    await api('export', '/preview', { contactIds, fields, title, includeNotes: exportNotes });
    await refresh(); setReview('export');
  });
  const confirmExport = () => run(async () => {
    const previewId = status!.sessions.export.exportPreview!.id;
    setReview(null);
    setStatus(current => current && { ...current, sessions: { ...current.sessions, export: { ...current.sessions.export, exportRun: { previewId, state: 'creating' } } } });
    await api('export', '/confirm', { previewId });
    await refresh();
  });
  const checkExport = () => run(async () => { await api('export', '/confirm', { checkOnly: true }); await refresh(); });
  const source = status?.sessions.import.source;
  const importPreview = status?.sessions.import.importPreview;
  const exportPreview = status?.sessions.export.exportPreview;
  const importRun = status?.sessions.import.importRun;
  const exportRun = status?.sessions.export.exportRun;
  const connected = status?.sessions[mode].connected;
  const importedBlocked = importRun && importRun.state !== 'complete';
  const exportBlocked = exportRun && exportRun.state !== 'complete';
  const changeMapping = (field: SheetField, value: string) => {
    setReview(null); setMapping(old => { const next = { ...old }; if (value === '') delete next[field as keyof ColumnMapping]; else next[field] = Number(value); return next; });
  };

  return <main className="sheets-page">
    <Link href="/organizer/#/contacts">← Back to contacts</Link>
    <h1>Google Sheets</h1>
    <p>Bring selected spreadsheet rows into muop, or export selected contacts to a new spreadsheet. Nothing is imported or exported automatically.</p>
    <p className="sheets-note">These short-lived connections are separate from Google sign-in and Google Contacts. Tokens stay on the server and expire after 15 minutes. No background sync.</p>
    <div className="sheets-tabs" role="group" aria-label="Google Sheets action">
      <button disabled={busy} aria-pressed={mode === 'import'} onClick={() => { setMode('import'); setReview(null); }}>Import rows</button>
      <button disabled={busy} aria-pressed={mode === 'export'} onClick={() => { setMode('export'); setReview(null); }}>Export contacts</button>
    </div>
    {error && <p role="alert" className="sheets-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {status && <button disabled={busy} onClick={() => run(async () => { await refresh(); setReview(null); })}>Refresh status (read only)</button>}
    {!status ? <><p role="status">{error ? 'Connection status could not be loaded.' : 'Loading connection status…'}</p>{error && <button disabled={busy} onClick={() => run(async () => { await refresh(); })}>Retry status (read only)</button>}</> : <>
      {!status.configured[mode] ? <section className="sheets-card"><h2>Not configured yet</h2><p>An administrator needs to configure this optional Google connector and its database migration. Your contacts remain available in muop.</p><button disabled={busy} onClick={() => run(async () => { await refresh(); })}>Check again</button></section> : <>
        <section className="sheets-card">
          <h2>{mode === 'import' ? 'Read an existing spreadsheet' : 'Create a new export spreadsheet'}</h2>
          {mode === 'import' ? <p>Google will ask for permission to read all spreadsheets you can access, not just the file you choose here. muop reads only the spreadsheet ID and tab you explicitly load. It cannot edit your source sheet.</p> : <p>Google will ask for access to files this app creates or files explicitly shared with it (drive.file). This export creates only a new spreadsheet in the Google account you select. It never writes to an existing file or shares your file with other people.</p>}
          {!connected ? <><button disabled={busy} onClick={connect}>Choose Google account and authorize {mode}</button><p>If a previous connection has an unresolved action, check Google Drive or your contacts first. Ending it does not undo a confirmed action or stop a request already sent.</p><button disabled={busy} onClick={endSession}>End any previous {mode} connection</button></> : <><p role="status">Connected for {mode} only.{mode === 'export' && status.sessions.export.destinationEmail ? ` Destination Google account: ${status.sessions.export.destinationEmail}.` : ' Source account is the one selected in Google consent.'}</p><button disabled={busy} onClick={endSession}>End this {mode} connection</button></>}
        </section>

        {mode === 'import' && connected && <>
          {importRun && <p role="status">{importRun.state === 'complete' ? `Import complete: ${importRun.added} added, ${importRun.skipped} duplicates skipped.` : 'The last import result is uncertain. Check your contacts before ending this connection or starting another batch. This operation will not be retried automatically.'}</p>}
          {!importedBlocked && <section className="sheets-card">
            <h2>1. Choose spreadsheet and worksheet</h2>
            <label>Spreadsheet ID<input value={id} maxLength={200} placeholder="The ID between /d/ and /edit in its Google URL" disabled={busy} onChange={e => { setId(e.target.value); setBook(null); setReview(null); }} /></label>
            <button disabled={busy || !id.trim()} onClick={loadBook}>Load worksheet list</button>
            {book && <><p>{book.title}</p><label>Worksheet<select value={tab} disabled={busy} onChange={e => { setTab(e.target.value); setReview(null); }}><option value="">Choose a worksheet</option>{book.sheets.map(s => <option key={s.sheetId} value={s.sheetId}>{s.title}</option>)}</select></label><button disabled={busy || tab === ''} onClick={loadRows}>Load first 100 data rows</button></>}
          </section>}
          {source && !importedBlocked && <section className="sheets-card">
            <h2>2. Map columns and select up to 5 rows</h2>
            <p>Loaded source: {source.title} / {source.sheetTitle}. Range: {source.range}. Row 1 is the header. Rows beyond 101 and columns beyond Z are not read. Load another batch from a separate worksheet if needed.</p>
            <p>Unselected columns are ignored. Invalid rows cannot be imported. Existing contacts are never overwritten.</p>
            <label className="sheets-check"><input type="checkbox" checked={importNotes} disabled={busy} onChange={e => { setImportNotes(e.target.checked); if (!e.target.checked) changeMapping('notes', ''); setReview(null); }} />Include a notes column in this import preview</label>
            <div className="sheets-grid">{sheetFields.filter(field => field !== 'notes' || importNotes).map(field => <label key={field}>{fieldLabels[field]}<select disabled={busy} value={mapping[field] ?? ''} onChange={e => changeMapping(field, e.target.value)}>{field !== 'name' && <option value="">Do not import</option>}{Array.from({ length: Math.max(1, ...source.values.map(row => row.length)) }, (_, column) => <option key={column} value={column}>{String.fromCharCode(65 + column)}: {source.values[0]?.[column] || '(no header)'}</option>)}</select></label>)}<label>Default category<select value={defaultCategory} disabled={busy} onChange={e => { setDefaultCategory(e.target.value); setReview(null); }}><option value="personal">Personal</option><option value="professional">Professional</option><option value="community">Community</option></select></label></div>
            <div className="sheets-table"><table><thead><tr><th>Select</th><th>Row</th>{(source.values[0] || []).map((value, col) => <th key={col}>{String.fromCharCode(65 + col)}: {value || '(no header)'}</th>)}</tr></thead><tbody>{source.values.slice(1).map((values, index) => <tr key={index}><td><input aria-label={`Select row ${index + 2}`} type="checkbox" checked={rows.includes(index + 2)} disabled={busy || (!rows.includes(index + 2) && rows.length >= 5)} onChange={e => { setRows(old => e.target.checked ? [...old, index + 2] : old.filter(row => row !== index + 2)); setReview(null); }} /></td><td>{index + 2}</td>{values.map((value, col) => <td key={col}>{value}</td>)}</tr>)}</tbody></table></div>
            {source.values.length < 2 && <p>No data rows found. Use a worksheet with a header row followed by contacts.</p>}
            <button disabled={busy || rows.length < 1} onClick={previewImport}>Preview {rows.length} selected rows</button>
          </section>}
          {review === 'import' && importPreview && !importedBlocked && <section className="sheets-card sheets-review"><h2>3. Review exact contacts before saving</h2><p>Destination: your signed-in muop account. Matching emails are skipped; when either email is missing, matching names are skipped. Contacts with different nonempty emails stay separate. Nothing is merged or overwritten. {importPreview.includeNotes ? 'Selected notes will be saved with these contacts.' : 'No private notes will be imported.'}</p>{importPreview.rows.map(row => <article key={row.row}><h3>Row {row.row}{row.duplicate ? ' · duplicate, will be skipped' : ''}</h3>{row.error ? <p className="sheets-error">{row.error}</p> : <dl>{sheetFields.filter(field => field !== 'notes' || importPreview.includeNotes).map(field => <div key={field}><dt>{fieldLabels[field]}</dt><dd>{field === 'interests' ? row.contact?.interests.join(', ') || 'None' : row.contact?.[field] || 'None'}</dd></div>)}</dl>}</article>)}<div className="sheets-actions"><button disabled={busy || !importPreview.rows.some(row => row.contact && !row.duplicate) || importPreview.rows.some(row => row.error !== null)} onClick={confirmImport}>Confirm import into muop</button><button disabled={busy} onClick={() => setReview(null)}>Back without importing</button></div></section>}
        </>}

        {mode === 'export' && connected && <>
          {exportRun && <section className="sheets-card"><p role="status">{exportRun.state === 'complete' ? 'Export complete. Your selected contacts were written as plain values.' : 'The last export is pending or uncertain. Do not start another export until you have checked Google Drive. No retry will run automatically.'}</p>{exportRun.spreadsheetId && <a href={`https://docs.google.com/spreadsheets/d/${exportRun.spreadsheetId}/edit`} target="_blank" rel="noreferrer">Open the created spreadsheet</a>}{exportRun.state !== 'complete' && exportRun.spreadsheetId && <button disabled={busy} onClick={checkExport}>Check existing export (read only)</button>}</section>}
          {!exportBlocked && <section className="sheets-card">
            <h2>1. Choose contacts and fields</h2><p>Maximum 100 contacts per export. Nothing is sent to Google while preparing the preview.</p>
            {status.contactsTruncated && <p>Only the first 1,000 contacts are listed. Narrow your contact list before exporting additional contacts.</p>}
            <label>New spreadsheet title<input value={title} maxLength={120} disabled={busy} onChange={e => { setTitle(e.target.value); setReview(null); }} /></label>
            <fieldset disabled={busy}><legend>Fields to export</legend>{sheetFields.filter(field => field !== 'notes').map(field => <label key={field} className="sheets-check"><input type="checkbox" checked={fields.includes(field)} onChange={e => { setFields(old => e.target.checked ? [...old, field] : old.filter(f => f !== field)); setReview(null); }} />{fieldLabels[field]}</label>)}<label className="sheets-check"><input type="checkbox" checked={exportNotes} onChange={e => { setExportNotes(e.target.checked); setFields(old => e.target.checked ? [...old.filter(f => f !== 'notes'), 'notes'] : old.filter(f => f !== 'notes')); setReview(null); }} />Include private notes in the preview and send them to the selected Google account</label></fieldset>
            <fieldset disabled={busy}><legend>Selected contacts: {contactIds.length}/100</legend>{status.contacts.length === 0 && <p>No contacts to export yet.</p>}{status.contacts.map(contact => <label key={contact.id} className="sheets-check"><input type="checkbox" checked={contactIds.includes(contact.id)} disabled={!contactIds.includes(contact.id) && contactIds.length >= 100} onChange={e => { setContactIds(old => e.target.checked ? [...old, contact.id] : old.filter(id => id !== contact.id)); setReview(null); }} />{contact.name}{contact.email ? ` (${contact.email})` : ''} · {contact.category}</label>)}</fieldset>
            <button disabled={busy || contactIds.length < 1 || fields.length < 1 || !title.trim()} onClick={previewExport}>Preview selected contacts</button>
          </section>}
          {review === 'export' && exportPreview && !exportBlocked && <section className="sheets-card sheets-review"><h2>2. Review exact export</h2><p>Destination: a newly created spreadsheet named “{exportPreview.title}” in Google account {exportPreview.destinationEmail}. Worksheet: Contacts. Exact range: {exportPreview.range}. A new file link will appear after creation. No existing spreadsheet will be overwritten or shared.</p><p>{exportPreview.includeNotes ? 'Private notes are included below and will be sent to Google.' : 'Private notes are excluded.'} Formula-looking text will be stored as literal text, never executed.</p><ValueTable values={exportPreview.values} /><div className="sheets-actions"><button disabled={busy} onClick={confirmExport}>Create spreadsheet and export these values</button><button disabled={busy} onClick={() => setReview(null)}>Back without exporting</button></div></section>}
        </>}
      </>}
    </>}
    {busy && <p role="status">Working… Please wait. Do not repeat the action.</p>}
  </main>;
}
