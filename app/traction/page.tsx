import type { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import { adminClient } from '@/lib/supabase/admin';
import { buildLedger, type LedgerAttendee, type LedgerStep } from '@/lib/traction';
import './traction.css';

export const metadata: Metadata = {
  title: 'Traction',
  description: 'Real people completing a muop meetup room: joined, shared what they like, voted.',
};
// Rendered per request, but the service-role reads below are cached for 15s
// (cachedLoad), so a public page can't fan out into DB load under traffic.
export const dynamic = 'force-dynamic';

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// Builders Day, Bengaluru: count from the start of the event day.
const SINCE = process.env.TRACTION_SINCE || '2026-10-24T00:00:00+05:30';

// PostgREST caps a response at 1000 rows and the smoke test adds guests every
// few minutes, so read every page; a silent cap would undercount real guests.
type Page<T> = { data: T[] | null; error: { message: string } | null };
async function all<T>(page: (from: number, to: number) => PromiseLike<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
  throw new Error('traction: too many rows to count');
}

async function load() {
  const db = adminClient();
  const [meetups, attendees, votes] = await Promise.all([
    all((a, b) => db.from('meetups').select('id, organizer_id').order('id').range(a, b)),
    all((a, b) =>
      db.from('meetup_attendees')
        .select('id, meetup_id, guest_name, preferences, availability, joined_at, updated_at')
        .gte('joined_at', SINCE).order('id').range(a, b)),
    all((a, b) => db.from('venue_votes').select('attendee_id, created_at').gte('created_at', SINCE).order('id').range(a, b)),
  ]);

  // Organiser emails decide which rooms are test traffic (smoke/UI tests sign up on example.com).
  const emails = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    data.users.forEach((u) => emails.set(u.id, u.email ?? ''));
    if (data.users.length < 1000) break;
  }

  return buildLedger(
    meetups.map((m) => ({ id: m.id, organizer_email: emails.get(m.organizer_id) ?? null })),
    attendees as LedgerAttendee[],
    votes,
    {
      testDomains: list(process.env.TRACTION_TEST_DOMAINS || 'example.com,muopdemo.dev'),
      teamNames: list(process.env.TRACTION_TEAM_NAMES),
      excludeIds: list(process.env.TRACTION_EXCLUDE_ATTENDEES),
      since: SINCE,
    },
  );
}

const cachedLoad = unstable_cache(load, ['traction-ledger'], { revalidate: 15 });

const STEP: Record<LedgerStep, string> = { joined: 'joined', shared: 'shared what they like', voted: 'voted on a place' };
const time = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default async function TractionPage() {
  let ledger;
  try {
    ledger = await cachedLoad();
  } catch {
    return (
      <main className="traction">
        <h1>Traction</h1>
        <p className="tr-note">Couldn&apos;t load the numbers right now. Try again in a moment.</p>
      </main>
    );
  }
  const { joined, shared, completed, rooms, excluded, timeline } = ledger;
  return (
    <main className="traction">
      <p className="tr-eyebrow">muop · live traction</p>
      <h1>
        {completed} {completed === 1 ? 'person' : 'people'} planned a meetup with muop
      </h1>
      <p className="tr-lede">
        Counted only when a guest joins a meetup room, shares what they like or when they&apos;re free, <em>and</em> votes on a place. Page views and sign-ups don&apos;t count.
      </p>

      <ol className="tr-funnel" aria-label="Guest steps">
        <li><strong>{joined}</strong><span>joined a room</span></li>
        <li><strong>{shared}</strong><span>shared preferences</span></li>
        <li className="done"><strong>{completed}</strong><span>completed (also voted)</span></li>
        <li><strong>{rooms}</strong><span>{rooms === 1 ? 'room' : 'rooms'} with real guests</span></li>
      </ol>

      <section className="tr-card">
        <h2>How we count</h2>
        <ul>
          <li>Since {time(SINCE)} IST. Each row is one guest in one room; someone in two rooms is counted twice.</li>
          <li>
            Not counted: {excluded.test} test {excluded.test === 1 ? 'visit' : 'visits'}, {excluded.seeded} seeded demo{' '}
            {excluded.seeded === 1 ? 'guest' : 'guests'} and {excluded.team} by our own team.
          </li>
          <li>Guests and rooms are numbered, never named. No one is identified on this page.</li>
        </ul>
      </section>

      <section className="tr-card">
        <h2>Latest activity</h2>
        {timeline.length ? (
          <ul className="tr-log">
            {timeline.map((e, i) => (
              <li key={i} className={e.step}>
                <time dateTime={e.at}>{time(e.at)}</time>
                <span>Guest {e.guest} in room {e.room} {STEP[e.step]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tr-note">No guest activity yet today.</p>
        )}
      </section>
    </main>
  );
}
