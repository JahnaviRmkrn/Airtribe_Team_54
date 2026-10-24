// End-to-end API smoke test. Run with the dev server up:
//   node scripts/smoke.mjs
// Reads NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY from .env.local.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const sb = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

async function signUp(tag) {
  const email = `${tag}-${Date.now()}@example.com`;
  const { data, error } = await sb().auth.signUp({ email, password: 'password-123456' });
  if (error) throw error;
  return data.session.access_token;
}

async function call(method, path, { token, guest, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (guest) headers['x-guest-secret'] = guest;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const alice = await signUp('alice');
const bob = await signUp('bob');

check('unauthenticated /api/me is 401', (await call('GET', '/api/me/contacts')).status === 401);

let r = await call('POST', '/api/me/contacts', {
  token: alice,
  body: {
    contacts: [
      { name: 'Sister', category: 'personal', interests: ['food'], notes: 'PRIVATE-NOTE', preferred_frequency_days: 7 },
      { name: 'Mentor', category: 'professional', next_followup_at: new Date(Date.now() - 86400000).toISOString() },
    ],
  },
});
check('onboarding bulk insert', r.status === 201 && r.json.contacts.length === 2, JSON.stringify(r.json));
const sister = r.json.contacts[0];

check('6 contacts rejected', (await call('POST', '/api/me/contacts', { token: alice, body: { contacts: Array(6).fill({ name: 'x', category: 'personal' }) } })).status === 400);
check('goals must total 100', (await call('PUT', '/api/me/goals', { token: alice, body: { personal: 50, professional: 40, community: 20 } })).status === 400);
check('goals saved', (await call('PUT', '/api/me/goals', { token: alice, body: { personal: 50, professional: 30, community: 20 } })).status === 200);

r = await call('GET', '/api/me/contacts?category=personal', { token: alice });
check('filter by category', r.json.contacts.length === 1 && r.json.contacts[0].name === 'Sister');

check("bob can't see alice's contacts", (await call('GET', '/api/me/contacts', { token: bob })).json.contacts.length === 0);
check("bob can't read alice's contact", (await call('GET', `/api/me/contacts/${sister.id}`, { token: bob })).status === 404);
check("bob can't edit alice's contact", (await call('PATCH', `/api/me/contacts/${sister.id}`, { token: bob, body: { name: 'hacked' } })).status === 404);

r = await call('POST', '/api/me/interactions', { token: alice, body: { contact_id: sister.id, type: 'call', notes: 'caught up' } });
check('interaction updates contact', r.status === 201 && r.json.contact.last_interaction_at && r.json.contact.next_followup_at, JSON.stringify(r.json));
check("bob can't log interaction on alice's contact", (await call('POST', '/api/me/interactions', { token: bob, body: { contact_id: sister.id } })).status === 404);

r = await call('GET', '/api/me/dashboard', { token: alice });
check('dashboard', r.status === 200 && r.json.contact_counts.personal === 1 && r.json.followups.overdue.length === 1 && r.json.goals.personal === 50, JSON.stringify(r.json));

r = await call('POST', '/api/me/meetups', { token: alice, body: { title: 'Friday dinner', activity: 'dinner', area: 'Koramangala', budget: 1500 } });
check('meetup created with link', r.status === 201 && r.json.meetup.room_url.includes('/m/') && r.json.invite_text, JSON.stringify(r.json));
const { room_token: token, id: meetupId } = r.json.meetup;

check('bad token 404', (await call('GET', '/api/rooms/not-a-real-token-xxxxxxxxxxxx')).status === 404);

r = await call('GET', `/api/rooms/${token}`);
const pub = JSON.stringify(r.json);
check('public room readable', r.status === 200 && r.json.meetup.title === 'Friday dinner');
check('room hides private data', !pub.includes('PRIVATE-NOTE') && !pub.includes('organizer_id') && !pub.includes('secret'));

r = await call('POST', `/api/rooms/${token}/join`, { body: { guest_name: 'Guest One', preferences: { area: 'Koramangala', food: ['veg', 'south-indian'], budget_max: 800 } } });
check('guest 1 joins', r.status === 201 && r.json.guest_secret, JSON.stringify(r.json));
const g1 = r.json.guest_secret;
r = await call('POST', `/api/rooms/${token}/join`, { body: { guest_name: 'Guest Two', preferences: { area: 'Koramangala', activities: ['board-games'], budget_max: 1000 } } });
const g2 = r.json.guest_secret;
check('guest 2 joins', r.status === 201);
check('rejoin with same secret blocked', (await call('POST', `/api/rooms/${token}/join`, { guest: g1, body: { guest_name: 'dup' } })).status === 409);
check('invalid guest input rejected', (await call('POST', `/api/rooms/${token}/join`, { body: { guest_name: '' } })).status === 400);

r = await call('GET', `/api/rooms/${token}`, { guest: g1 });
check('room shows 2 attendees', r.json.attendees.length === 2);
check('shortlist present and labelled', r.json.shortlist.length > 0 && r.json.shortlist.every((s) => s.label === 'Sample suggestion'), JSON.stringify(r.json.shortlist));
check('me identifies guest', r.json.me?.attendee_id);
const venueId = r.json.shortlist[0].venue.id;

check('vote without joining is 401', (await call('POST', `/api/rooms/${token}/vote`, { body: { venue_id: venueId } })).status === 401);
check('vote for non-shortlisted venue is 400', (await call('POST', `/api/rooms/${token}/vote`, { guest: g1, body: { venue_id: '00000000-0000-0000-0000-000000000000' } })).status === 400);
await call('POST', `/api/rooms/${token}/vote`, { guest: g1, body: { venue_id: venueId } });
await call('POST', `/api/rooms/${token}/vote`, { guest: g1, body: { venue_id: venueId } });
r = await call('POST', `/api/rooms/${token}/vote`, { guest: g2, body: { venue_id: venueId } });
check('one vote per guest, totals correct', r.json.votes[venueId] === 2 && r.json.leading_venue_id === venueId, JSON.stringify(r.json.votes));

r = await call('PATCH', `/api/rooms/${token}/me`, { guest: g2, body: { guest_name: 'Guest Two (edited)' } });
check('guest edits own entry only', r.json.attendees.some((a) => a.guest_name === 'Guest Two (edited)') && r.json.attendees.some((a) => a.guest_name === 'Guest One'));

check('guest cannot confirm', (await call('POST', `/api/rooms/${token}/confirm`, { guest: g1, body: { venue_id: venueId } })).status === 401);
check('other user cannot confirm', (await call('POST', `/api/rooms/${token}/confirm`, { token: bob, body: { venue_id: venueId } })).status === 403);
r = await call('POST', `/api/rooms/${token}/confirm`, { token: alice, body: { venue_id: venueId } });
check('organiser confirms venue', r.status === 200 && r.json.meetup.final_venue?.id === venueId, JSON.stringify(r.json));

check("bob can't see alice's meetup", (await call('GET', `/api/me/meetups/${meetupId}`, { token: bob })).status === 404);
check('other user cannot close', (await call('POST', `/api/rooms/${token}/close`, { token: bob })).status === 403);
check('organiser closes room', (await call('POST', `/api/rooms/${token}/close`, { token: alice })).status === 200);
check('closed room is read-only', (await call('POST', `/api/rooms/${token}/join`, { body: { guest_name: 'Late' } })).status === 410);
check('closed room still readable', (await call('GET', `/api/rooms/${token}`)).json.meetup.status === 'closed');

// --- regression checks for review fixes ---------------------------------
r = await call('PATCH', `/api/me/contacts/${sister.id}`, { token: alice, body: { name: 'Sister (renamed)' } });
check('partial contact edit keeps interests', r.json.contact.interests?.includes('food'), JSON.stringify(r.json));

const today = new Date().toISOString();
r = await call('POST', '/api/me/interactions', { token: alice, body: { contact_id: sister.id, occurred_at: today } });
const latest = r.json.contact;
r = await call('POST', '/api/me/interactions', {
  token: alice,
  body: { contact_id: sister.id, occurred_at: new Date(Date.now() - 30 * 86400000).toISOString().replace('Z', '+05:30') },
});
check(
  'older interaction does not move dates back',
  r.status === 201 && r.json.contact.last_interaction_at === latest.last_interaction_at && r.json.contact.next_followup_at === latest.next_followup_at,
  JSON.stringify({ before: latest, after: r.json.contact }),
);

r = await call('POST', '/api/me/meetups', { token: alice, body: { title: 'Coffee', activity: 'coffee', area: 'Indiranagar' } });
const coffee = r.json.meetup;
const later = new Date(Date.now() + 40 * 86400000).toISOString();
r = await call('PATCH', `/api/me/meetups/${coffee.id}`, { token: alice, body: { starts_at: later } });
check('reschedule extends room expiry', Date.parse(r.json.meetup.expires_at) > Date.parse(later), JSON.stringify(r.json.meetup));
r = await call('PATCH', `/api/me/meetups/${coffee.id}`, { token: alice, body: { status: 'closed' } });
check('closing keeps activity', r.json.meetup.activity === 'coffee' && r.json.meetup.status === 'closed', JSON.stringify(r.json.meetup));

r = await call('POST', '/api/me/meetups', { token: alice, body: { title: 'Brunch', activity: 'brunch', area: 'Jayanagar' } });
const brunch = r.json.meetup.room_token;
r = await call('POST', `/api/rooms/${brunch}/join`, { body: { guest_name: 'Pref Guest', preferences: { food: ['veg'] }, availability: ['Sun'] } });
const pg = r.json.guest_secret;
r = await call('PATCH', `/api/rooms/${brunch}/me`, { guest: pg, body: { guest_name: 'Pref Guest 2' } });
const mine = r.json.attendees.find((a) => a.guest_name === 'Pref Guest 2');
check('guest name edit keeps preferences', mine?.preferences?.food?.[0] === 'veg' && mine?.availability?.[0] === 'Sun', JSON.stringify(mine));

// Room-state rules hold even if the API's own check is bypassed (DB trigger).
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
await call('POST', `/api/rooms/${brunch}/close`, { token: alice });
const { data: m } = await admin.from('meetups').select('id').eq('room_token', brunch).single();
const { error: dbErr } = await admin.from('meetup_attendees').insert({ meetup_id: m.id, guest_name: 'sneaky', secret_hash: 'x' });
check('DB rejects join into closed room', dbErr?.message.includes('room_closed'), JSON.stringify(dbErr));

r = await call('POST', '/api/me/meetups', { token: alice, body: { title: 'Full room', activity: 'dinner' } });
const full = r.json.meetup;
await admin.from('meetup_attendees').insert(Array.from({ length: 50 }, (_, i) => ({ meetup_id: full.id, guest_name: `g${i}`, secret_hash: `h${i}` })));
check('51st guest is rejected', (await call('POST', `/api/rooms/${full.room_token}/join`, { body: { guest_name: 'one too many' } })).status === 429);

r = await call('POST', '/api/me/meetups', { token: alice, body: { title: 'Last week', starts_at: new Date(Date.now() - 7 * 86400000).toISOString() } });
const pastId = r.json.meetup.id;
r = await call('POST', '/api/me/meetups', { token: alice, body: { title: 'Expired room' } });
const expiredId = r.json.meetup.id;
await admin.from('meetups').update({ expires_at: new Date(Date.now() - 60000).toISOString() }).eq('id', expiredId);
r = await call('POST', '/api/me/meetups', { token: alice, body: { title: 'Unscheduled' } });
const unscheduledId = r.json.meetup.id;
r = await call('GET', '/api/me/dashboard', { token: alice });
const upIds = r.json.upcoming_meetups.map((m) => m.id);
check(
  'dashboard hides past and expired meetups, keeps unscheduled',
  !upIds.includes(pastId) && !upIds.includes(expiredId) && upIds.includes(unscheduledId),
  JSON.stringify(r.json.upcoming_meetups.map((m) => m.title)),
);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
