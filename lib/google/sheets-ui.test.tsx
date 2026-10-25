import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { SheetsStatus } from './sheets-types';

// A small deterministic event harness, not browser QA. It exercises the actual
// component callbacks and state guards with mocked hooks and network responses.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0 }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    hooks.refs[index] ??= { current: index === 1 ? true : initial };
    return hooks.refs[index];
  },
  useEffect: () => {},
  useCallback: (callback: unknown) => callback,
}));
import SheetsClient from '@/app/integrations/google-sheets/SheetsClient';

const id = '11111111-1111-4111-8111-111111111111';
const previewId = '22222222-2222-4222-8222-222222222222';
function status(): SheetsStatus {
  return {
    configured: { import: true, export: true }, contactsTruncated: false,
    contacts: [{ id, name: 'Ada', category: 'personal', email: null }],
    sessions: { import: { connected: true }, export: { connected: true, destinationEmail: 'verified@example.test', exportPreview: { id: previewId, title: 'Reviewed file', destinationEmail: 'verified@example.test', fields: ['name'], contactIds: [id], values: [['Name'], ['Ada']], range: "'Contacts'!A1:A2", includeNotes: false } } },
  };
}
type Element = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && 'props' in node) return text((node as Element).props.children);
  return '';
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node && typeof node === 'object' && 'props' in node) { const element = node as Element; return [element, ...elements(element.props.children)]; }
  return [];
}
function render() { hooks.stateIndex = 0; hooks.refIndex = 0; return SheetsClient(); }
function button(label: string) {
  const found = elements(render()).find(e => e.type === 'button' && text(e.props.children).includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
const click = (element: Element) => (element.props.onClick as () => void | Promise<void>)();
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  hooks.values = []; hooks.refs = []; hooks.values[0] = status(); hooks.values[1] = 'export';
  vi.stubGlobal('location', { assign: vi.fn(), search: '' });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const s = hooks.values[0] as SheetsStatus;
    return String(input).includes('sheets-import/status') ? response({ configured: true, session: s.sessions.import }) : response({ configured: true, session: s.sessions.export, contacts: s.contacts, contactsTruncated: false });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Sheets component event guards', () => {
  it('shows least-privilege scope consequences and never starts an export on render', () => {
    const tree = render();
    expect(text(tree)).toContain('drive.file'); expect(text(tree)).toContain('verified@example.test');
    expect(fetch).not.toHaveBeenCalled();
    hooks.values[1] = 'import';
    expect(text(render())).toContain('read all spreadsheets you can access, not just the file you choose here');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('Back dismisses the exact review with zero network action', () => {
    hooks.values[16] = 'export';
    expect(text(render())).toContain('Reviewed file');
    click(button('Back without exporting'));
    expect(text(render())).not.toContain('Create spreadsheet and export these values');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps private notes unchecked until explicit selection and includes them in the new preview request', async () => {
    render(); hooks.values[12] = [id];
    let label = elements(render()).find(e => e.type === 'label' && text(e.props.children).includes('Include private notes'))!;
    let checkbox = elements(label).find(e => e.type === 'input')!;
    expect(checkbox.props.checked).toBe(false);
    (checkbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    label = elements(render()).find(e => e.type === 'label' && text(e.props.children).includes('Include private notes'))!;
    checkbox = elements(label).find(e => e.type === 'input')!;
    expect(checkbox.props.checked).toBe(true);
    await click(button('Preview selected contacts'));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/preview'))!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body.includeNotes).toBe(true); expect(body.fields).toContain('notes');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/confirm'))).toBe(false);
  });
  it('blocks same-tick repeated confirmations before a disabled render', async () => {
    hooks.values[16] = 'export';
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/confirm') ? pending : defaultFetch(url, init));
    const confirm = button('Create spreadsheet and export these values');
    const first = click(confirm); const second = click(confirm);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/confirm'))).toHaveLength(1);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ previewId });
    resolve(response({ result: { state: 'complete' } })); await first; await second;
  });
  it('never navigates to Google if the page was left while connect was pending', async () => {
    (hooks.values[0] as SheetsStatus).sessions.export.connected = false;
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
    const pending = click(button('Choose Google account'));
    hooks.refs[1].current = false;
    resolve(response({ url: 'https://accounts.google.com/o/oauth2/v2/auth' })); await pending;
    expect(location.assign).not.toHaveBeenCalled();
  });
  it('shows ambiguous export as blocked and offers only a read-only check for a known file', async () => {
    const s = hooks.values[0] as SheetsStatus;
    s.sessions.export.exportRun = { previewId, state: 'uncertain', spreadsheetId: 'a'.repeat(30) };
    expect(text(render())).not.toContain('Preview selected contacts');
    await click(button('Check existing export'));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/confirm'))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ checkOnly: true });
  });
});
