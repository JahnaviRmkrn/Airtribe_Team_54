import type { SupabaseClient } from '@supabase/supabase-js';
import type { LedgerAttendee, LedgerVote } from './traction';

type Page<T> = { data: T[] | null; error: { message: string } | null };
const PAGE_SIZE = 1000;
const MAX_ROWS = 50_000;
// One extra page distinguishes exactly MAX_ROWS from an incomplete count.
// Bound requests separately so pathological duplicate pages cannot loop.
const MAX_PAGES = Math.ceil(MAX_ROWS / PAGE_SIZE) + 1;

// ID keysets avoid offset shifts as rows are inserted or deleted. The caller
// must order each page by ascending ID and request IDs greater than `after`.
export async function allById<T extends { id: string }>(
  page: (after: string | null, limit: number) => PromiseLike<Page<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
    const { data, error } = await page(after, PAGE_SIZE);
    if (error) throw new Error(error.message);
    if (!data?.length) return rows;
    if (data.length > PAGE_SIZE) throw new Error('traction: page exceeded requested row limit');
    const next = data[data.length - 1].id;
    if (after !== null && next <= after) throw new Error('traction: ID cursor did not advance');
    for (const row of data) {
      if (!seen.has(row.id)) {
        if (rows.length === MAX_ROWS) throw new Error('traction: too many rows to count');
        seen.add(row.id);
        rows.push(row);
      }
    }
    if (data.length < PAGE_SIZE) return rows;
    after = next;
  }
  throw new Error('traction: pagination safety limit exceeded');
}

type UserLookup = (id: string) => PromiseLike<{
  data: { user: { email?: string | null } | null } | null;
  error: unknown;
}>;

// Only look up organisers whose rooms occur in this load. Missing users and
// temporary lookup failures are unverified, not evidence of test traffic.
export async function organizerEmails(ids: (string | null)[], getUserById: UserLookup) {
  const uniqueIds = [...new Set(ids.filter((id): id is string => !!id))];
  const emails = new Map<string, string | null>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, uniqueIds.length) }, async () => {
    while (next < uniqueIds.length) {
      const id = uniqueIds[next++];
      let email: string | null = null;
      try {
        const { data, error } = await getUserById(id);
        if (!error) email = data?.user?.email?.trim() || null;
      } catch { /* Keep this organiser unverified; other lookups can continue. */ }
      emails.set(id, email);
    }
  }));
  return emails;
}

export async function readTractionData(db: SupabaseClient, since: string) {
  // One creation-time cutoff bounds both streams. This is not a transactional
  // snapshot: saved preferences can change and backdated inserts can be missed.
  const cutoff = new Date().toISOString();
  const [attendees, votes] = await Promise.all([
    allById<LedgerAttendee>((after, limit) => {
      let query = db.from('meetup_attendees')
        .select('id, meetup_id, guest_name, preferences, availability, joined_at, updated_at')
        .gte('joined_at', since).lte('joined_at', cutoff).order('id', { ascending: true }).limit(limit);
      if (after !== null) query = query.gt('id', after);
      return query;
    }),
    allById<LedgerVote & { id: string }>((after, limit) => {
      let query = db.from('venue_votes').select('id, attendee_id, created_at')
        .gte('created_at', since).lte('created_at', cutoff).order('id', { ascending: true }).limit(limit);
      if (after !== null) query = query.gt('id', after);
      return query;
    }),
  ]);

  const meetupIds = [...new Set(attendees.map((a) => a.meetup_id))];
  const meetups: { id: string; organizer_id: string | null }[] = [];
  for (let start = 0; start < meetupIds.length; start += 100) {
    const { data, error } = await db.from('meetups').select('id, organizer_id').in('id', meetupIds.slice(start, start + 100));
    if (error) throw new Error(error.message);
    meetups.push(...(data ?? []));
  }
  const emails = await organizerEmails(meetups.map((m) => m.organizer_id), (id) => db.auth.admin.getUserById(id));
  return {
    meetups: meetups.map((m) => ({ id: m.id, organizer_email: m.organizer_id ? emails.get(m.organizer_id) ?? null : null })),
    attendees,
    votes,
  };
}
