import type { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import { adminClient } from '@/lib/supabase/admin';
import { buildLedger, type LedgerStep } from '@/lib/traction';
import { readTractionData } from '@/lib/traction-read';
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

async function load() {
  const { meetups, attendees, votes } = await readTractionData(adminClient(), SINCE);
  return buildLedger(
    meetups,
    attendees,
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

const STEP: Record<LedgerStep, string> = { joined: 'joined', voted: 'voted on a place' };
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
      {excluded.unverified > 0 && (
        <p className="tr-note">
          {excluded.unverified} {excluded.unverified === 1 ? 'visit is' : 'visits are'} excluded because the room or organizer could not be verified; totals may be incomplete.
        </p>
      )}
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
        <p className="tr-note">Sharing is counted from current saved preferences or availability. The original sharing time is not recorded, so this list shows only joins and votes.</p>
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
