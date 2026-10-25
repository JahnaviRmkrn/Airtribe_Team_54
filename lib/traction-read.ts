import type { SupabaseClient } from '@supabase/supabase-js';
import type { LedgerAttendee, LedgerVote } from './traction';

import { withCompleteReads, type CompleteReader } from './complete-read';
import { HttpError } from './http';

type Page<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };
type LoadPage<T> = (after: string | null, limit: number, verifyEmpty: boolean, signal: AbortSignal) => PromiseLike<Page<T>>;
const PAGE_SIZE = 1000;
const MAX_ROWS = 50_000;
// Preserve 51 data requests, including the terminal empty SELECT at 50,000.
// An independent exact HEAD verification gets one additional request.
const MAX_DATA_PAGES = 51;
const SCAN_LIMITS = { pageRows: PAGE_SIZE, rows: MAX_ROWS, requests: MAX_DATA_PAGES + 1, bytes: 16 * 1024 * 1024, milliseconds: 10_000 };
// Attendees + votes (52 each), plus at most 500 referenced-meetup chunks
// (SELECT, empty SELECT, HEAD at the normal cap). Lower caps may exhaust this
// finite aggregate budget and explicitly fail, never publish partial counts.
const LOAD_LIMITS = { ...SCAN_LIMITS, rows: 3 * MAX_ROWS, requests: 1604, bytes: 32 * 1024 * 1024 };
const failure = (reason: string) => new HttpError(503, `traction: ${reason}`);
type ByteBudget = { used: number; maximum: number };

async function scanById<T extends { id: string }>(read: CompleteReader, page: LoadPage<T>, bytes: ByteBudget): Promise<T[]> {
  const seen = new Set<string>();
  let dataPages = 0;
  return read<T>(async (after, signal, limit, verifyEmpty) => {
    if (!verifyEmpty && ++dataPages > MAX_DATA_PAGES) throw failure('pagination safety limit exceeded');
    const result = await page(after, limit, verifyEmpty, signal);
    if (result.error || verifyEmpty) return result;
    // Check received shape/size/order before dedup. Never sort a broken backend
    // page, or turn a duplicate-only nonempty page into a false terminal page.
    if (!Array.isArray(result.data)) throw failure('invalid database page');
    if (result.data.length > limit) throw failure('page exceeded requested row limit');
    bytes.used += Buffer.byteLength(JSON.stringify(result.data), 'utf8');
    if (bytes.used > bytes.maximum) throw failure('read byte safety limit exceeded');
    let previous: string | null = null;
    for (const row of result.data) {
      if (!row || typeof row.id !== 'string' || !row.id || (previous !== null && row.id < previous)) throw failure('invalid database page order');
      previous = row.id;
    }
    if (previous !== null && after !== null && previous <= after) throw failure('ID cursor did not advance');
    const unique = result.data.filter((row) => {
      if (seen.has(row.id)) return false;
      if (seen.size === MAX_ROWS) throw failure('too many rows to count');
      seen.add(row.id); return true;
    });
    if (result.data.length && !unique.length) throw failure('ID cursor did not advance');
    return { ...result, data: unique };
  }, (row) => row.id);
}

// ID keysets avoid offset shifts, not concurrent snapshots. A short page is
// never an end marker; empty SELECT must be verified by exact same-cursor HEAD.
export async function allById<T extends { id: string }>(page: LoadPage<T>): Promise<T[]> {
  return withCompleteReads(new Request('https://traction.invalid/read'),
    (read) => scanById(read, page, { used: 0, maximum: SCAN_LIMITS.bytes }), SCAN_LIMITS);
}

type UserLookup = (id: string) => PromiseLike<{
  data: { user: { email?: string | null } | null } | null;
  error: unknown;
}>;

// Only look up organisers whose rooms occur in this load. Missing users and
// temporary lookup failures are unverified, not evidence of test traffic.
export async function organizerEmails(ids: (string | null)[], getUserById: UserLookup, signal?: AbortSignal) {
  const checkDeadline = () => { if (signal?.aborted) throw failure('complete load deadline exceeded'); };
  const uniqueIds = [...new Set(ids.filter((id): id is string => !!id))];
  if (uniqueIds.length > MAX_ROWS) throw failure('organizer lookup safety limit exceeded');
  const emails = new Map<string, string | null>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, uniqueIds.length) }, async () => {
    while (next < uniqueIds.length) {
      checkDeadline();
      const id = uniqueIds[next++];
      let email: string | null = null;
      let onAbort = () => {};
      try {
        // Bound waiting, even though the admin SDK does not expose per-lookup
        // transport cancellation. Never schedule more users after the deadline.
        const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(failure('complete load deadline exceeded')); });
        signal?.addEventListener('abort', onAbort, { once: true });
        checkDeadline();
        const { data, error } = await Promise.race([Promise.resolve().then(() => { checkDeadline(); return getUserById(id); }), aborted]);
        checkDeadline();
        if (!error) email = data?.user?.email?.trim() || null;
      } catch {
        checkDeadline(); // Deadline is incomplete data, not an unknown identity.
        // Other lookup failures keep only this organiser unverified.
      } finally { signal?.removeEventListener('abort', onAbort); }
      emails.set(id, email);
    }
  }));
  return emails;
}

export async function readTractionData(db: SupabaseClient, since: string) {
  // Service-role reads, not owner RLS. One cutoff bounds both event streams;
  // mutable preferences/backdated inserts still make this a non-snapshot read.
  const cutoff = new Date().toISOString();
  return withCompleteReads(new Request('https://traction.invalid/read'), async (read) => {
    const bytes = { used: 0, maximum: LOAD_LIMITS.bytes };
    let loadSignal: AbortSignal | undefined;
    const [attendees, votes] = await Promise.all([
      scanById<LedgerAttendee>(read, (after, limit, verifyEmpty, signal) => {
        loadSignal = signal;
        let query = db.from('meetup_attendees')
          .select('id, meetup_id, guest_name, preferences, availability, joined_at, updated_at', verifyEmpty ? { head: true, count: 'exact' } : undefined)
          .gte('joined_at', since).lte('joined_at', cutoff).order('id', { ascending: true }).limit(limit).abortSignal(signal);
        if (after !== null) query = query.gt('id', after);
        return query;
      }, bytes),
      scanById<LedgerVote & { id: string }>(read, (after, limit, verifyEmpty, signal) => {
        loadSignal = signal;
        let query = db.from('venue_votes').select('id, attendee_id, created_at', verifyEmpty ? { head: true, count: 'exact' } : undefined)
          .gte('created_at', since).lte('created_at', cutoff).order('id', { ascending: true }).limit(limit).abortSignal(signal);
        if (after !== null) query = query.gt('id', after);
        return query;
      }, bytes),
    ]);

    const meetupIds = [...new Set(attendees.map((a) => a.meetup_id))];
    const meetups: { id: string; organizer_id: string | null }[] = [];
    for (let start = 0; start < meetupIds.length; start += 100) {
      const chunk = meetupIds.slice(start, start + 100);
      meetups.push(...await scanById<{ id: string; organizer_id: string | null }>(read, (after, limit, verifyEmpty, signal) => {
        let query = db.from('meetups').select('id, organizer_id', verifyEmpty ? { head: true, count: 'exact' } : undefined)
          .in('id', chunk).order('id', { ascending: true }).limit(limit).abortSignal(signal);
        if (after !== null) query = query.gt('id', after);
        return query;
      }, bytes));
    }
    const emails = await organizerEmails(meetups.map((m) => m.organizer_id), (id) => db.auth.admin.getUserById(id), loadSignal);
    return {
      meetups: meetups.map((m) => ({ id: m.id, organizer_email: m.organizer_id ? emails.get(m.organizer_id) ?? null : null })),
      attendees,
      votes,
    };
  }, LOAD_LIMITS);
}
