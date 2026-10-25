import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('../supabase/admin', () => ({ adminClient: () => { throw new Error('No live database'); } }));
import { calendarBody, calendarEventId, gmailRaw, normalizeAddresses, preparePreview, previewHash, resolveLocalTime, type CalendarPreview, type EmailPreview } from './action-content';
import { performGoogleAction, reconcileCalendarAction } from './action-provider';
const createdAt = '2026-10-25T04:00:00.000Z';
const id = '6f7ca671-f74a-4bc9-9c3b-f42590fe08a5';
const draft = { from: 'sender@example.test', to: ['person@example.test'], subject: '你好 café 🐈', body: 'Hello\nUnicode café ✓' };
const email = () => preparePreview('gmail', draft) as EmailPreview;
const eventDraft = { title: 'Tea', description: 'Explicit description', location: 'Cafe', localStart: '2026-10-25T14:30', timeZone: 'Asia/Kolkata', durationMinutes: 60, attendees: ['person@example.test'], sendUpdates: 'all' };
const event = () => preparePreview('calendar', eventDraft) as CalendarPreview;
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled in tests'); })); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit action content validation', () => {
  it('normalizes IDN domains and case-insensitive duplicates without adding recipients', () => {
    expect(normalizeAddresses([' Alice@EXAMPLE.test ', 'alice@example.test', 'a@bücher.example'])).toEqual(['Alice@example.test', 'a@xn--bcher-kva.example']);
  });
  it.each(['a@example.test\r\nBcc:evil@example.test', 'Name <a@example.test>', 'no-at', 'é@example.test', 'a..b@example.test', '.a@example.test', 'a@-bad.test', 'a@foo..test', 'a@localhost', 'a@example.test\0'])('rejects unsafe or unsupported address %s', (address) => {
    expect(() => preparePreview('gmail', { ...draft, to: [address] })).toThrow();
  });
  it('rejects extras, missing recipients, injection, invalid Unicode and oversized messages', () => {
    for (const change of [{ bcc: ['hidden@example.test'] }, { from: 'bad\r\nBcc: evil@example.test' }, { to: [] }, { to: Array(26).fill('p@example.test') }, { subject: 'hi\r\nBcc: hidden@example.test' }, { body: '\uD800' }, { body: 'x'.repeat(20001) }, { body: '\u0000' }]) {
      expect(() => preparePreview('gmail', { ...draft, ...change })).toThrow();
    }
    expect(email().body).toContain('✓');
  });
  it('encodes UTF-8 subject/body safely with MIME line folding and base64url', () => {
    const raw = gmailRaw(email(), new Date(createdAt)); expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(raw, 'base64url').toString();
    expect(mime).toContain('To: person@example.test\r\n');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).not.toContain('Bcc:'); expect(mime).toContain('From: sender@example.test\r\n');
    expect(mime).toMatch(/Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000\r\n/);
    const [header, body] = mime.split('\r\n\r\n');
    const decodedSubject = [...header.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString()).join('');
    expect(decodedSubject).toBe(draft.subject);
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString()).toBe('Hello\r\nUnicode café ✓');
    const long = gmailRaw(preparePreview('gmail', { ...draft, subject: '🐈'.repeat(60) }) as EmailPreview, new Date(createdAt));
    expect(Buffer.from(long, 'base64url').toString().split('\r\n').every((line) => line.length < 998)).toBe(true);
  });
  it('resolves normal local time and derives a strictly later end', () => {
    const p = event(); expect(p.start).toBe('2026-10-25T09:00:00.000Z'); expect(p.end).toBe('2026-10-25T10:00:00.000Z'); expect(p.endLocal).toBe('2026-10-25T15:30');
    for (const durationMinutes of [0, -1, 0.5, 10081]) expect(() => preparePreview('calendar', { ...eventDraft, durationMinutes })).toThrow();
  });
  it('rejects nonexistent DST local times and requires explicit overlapping-time choice', () => {
    expect(() => resolveLocalTime('2026-03-08T02:30', 'America/New_York', 'reject')).toThrow('does not exist');
    expect(() => resolveLocalTime('2026-11-01T01:30', 'America/New_York', 'reject')).toThrow('occurs twice');
    const first = resolveLocalTime('2026-11-01T01:30', 'America/New_York', 'earlier');
    const last = resolveLocalTime('2026-11-01T01:30', 'America/New_York', 'later');
    expect(last.instant - first.instant).toBe(3600000);
  });
  it('handles non-hour DST shifts and elapsed duration across a transition', () => {
    expect(() => resolveLocalTime('2026-10-04T02:15', 'Australia/Lord_Howe', 'reject')).toThrow('does not exist');
    const p = preparePreview('calendar', { ...eventDraft, localStart: '2026-11-01T01:30', timeZone: 'America/New_York', disambiguation: 'earlier' }) as CalendarPreview;
    expect(Date.parse(p.end) - Date.parse(p.start)).toBe(3600000); expect(p.endLocal).toBe(p.localStart);
  });
  it('rejects invalid dates, zones and silent extra calendar options', () => {
    for (const change of [{ localStart: '2026-02-30T10:00' }, { localStart: '1900-01-01T10:00' }, { timeZone: 'Not/AZone' }, { timeZone: '+01:00' }, { timeZone: '+0100' }, { timeZone: '-05:00' }, { recurrence: ['RRULE:FREQ=DAILY'] }, { sendUpdates: 'externalOnly' }]) expect(() => preparePreview('calendar', { ...eventDraft, ...change })).toThrow();
  });
  it('binds sender edits to a different preview digest', () => {
    expect(previewHash(preparePreview('gmail', { ...draft, from: 'another@example.test' }))).not.toBe(previewHash(email()));
  });
  it('changes the content digest for every meaningful destination/content/notification edit', () => {
    expect(previewHash(email())).toBe(previewHash(email()));
    expect(previewHash(preparePreview('gmail', { ...draft, to: ['other@example.test'] }))).not.toBe(previewHash(email()));
    expect(previewHash(preparePreview('calendar', { ...eventDraft, sendUpdates: 'none' }))).not.toBe(previewHash(event()));
  });
  it('escapes plain-text descriptions for Calendar’s HTML-capable field', () => {
    const p = preparePreview('calendar', { ...eventDraft, description: '<a href=\"https://evil.test\">Click</a> & text\nNext' }) as CalendarPreview;
    expect(calendarBody(p, id, previewHash(p)).description).toBe('&lt;a href=\"https://evil.test\"&gt;Click&lt;/a&gt; &amp; text<br>Next');
  });
  it('uses legal UUID-based Calendar event ID, no reminders and exact selected attendees', () => {
    expect(calendarEventId(id)).toMatch(/^[a-v0-9]{5,1024}$/);
    const body = calendarBody(event(), id, previewHash(event()));
    expect(body.attendees).toEqual([{ email: 'person@example.test' }]); expect(body.reminders).toEqual({ useDefault: false });
    expect(body.extendedProperties.private.moupAction).toBe(id); expect(body).not.toHaveProperty('conferenceData');
  });
});

describe('one-shot Google writes and read-only reconciliation', () => {
  it.each(['gmail', 'calendar'] as const)('makes exactly one %s POST using only previewed content', async (purpose) => {
    const p = purpose === 'gmail' ? email() : event();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: purpose === 'gmail' ? 'abc123' : calendarEventId(id) })));
    expect(await performGoogleAction(p, id, previewHash(p), 'synthetic-token', createdAt)).toMatchObject({ state: 'completed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe(purpose === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/sender%40example.test/messages/send' : 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer synthetic-token' } });
  });
  it.each([409, 500, 502, 503])('treats HTTP %s as uncertain without retry or logging', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('SECRET diagnostics', { status }));
    const log = vi.spyOn(console, 'error');
    expect(await performGoogleAction(email(), id, previewHash(email()), 'synthetic-token', createdAt)).toEqual({ state: 'uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
  });
  it('uses exact primary sender target and never falls back to me after mismatch', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Mailbox not authorized', { status: 403 }));
    const p = preparePreview('gmail', { ...draft, from: 'different@example.test' }) as EmailPreview;
    expect(await performGoogleAction(p, id, previewHash(p), 'synthetic-token', createdAt)).toEqual({ state: 'rejected' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/different%40example.test/messages/send');
    const mime = Buffer.from(JSON.parse(String(init?.body)).raw, 'base64url').toString();
    expect(mime).toContain('From: different@example.test\r\n');
    expect(mime).toContain('Date: Sun, 25 Oct 2026 04:00:00 +0000\r\n');
  });
  it.each([400, 401, 403, 404, 413, 422, 429])('records explicit HTTP %s rejection without automatic retry', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
    expect(await performGoogleAction(email(), id, previewHash(email()), 'synthetic-token', createdAt)).toEqual({ state: 'rejected' }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('treats timeout, body parse failure and wrong event ID as unknown', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('timeout'));
    expect((await performGoogleAction(email(), id, previewHash(email()), 'synthetic-token', createdAt)).state).toBe('uncertain');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not json'));
    expect((await performGoogleAction(email(), id, previewHash(email()), 'synthetic-token', createdAt)).state).toBe('uncertain');
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'wrong' })));
    expect((await performGoogleAction(event(), id, previewHash(event()), 'synthetic-token', createdAt)).state).toBe('uncertain');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('reconciles only an exact ID plus private action/content binding with GET', async () => {
    const hash = previewHash(event());
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: calendarEventId(id), extendedProperties: { private: { moupAction: id, moupPreview: hash } } })));
    expect(await reconcileCalendarAction(id, hash, 'synthetic-token')).toEqual({ state: 'completed', providerRef: calendarEventId(id) });
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
  });
  it.each([null, { id: 'other' }, { id: calendarEventId(id), extendedProperties: { private: { moupAction: id, moupPreview: 'other' } } }])('never recreates on missing, wrong or mismatched GET result', async (data) => {
    vi.mocked(fetch).mockResolvedValue(data ? new Response(JSON.stringify(data)) : new Response('', { status: 404 }));
    expect(await reconcileCalendarAction(id, previewHash(event()), 'synthetic-token')).toEqual({ state: 'uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('GET');
  });
});
