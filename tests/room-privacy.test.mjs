import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asRole, identities, privacyDatabase, seedPrivateData } from './helpers/privacy-db.mjs';
import { pgliteClient } from './helpers/pglite-client.mjs';

const deps = vi.hoisted(() => ({
  admin: null, userClient: null, cookies: null,
  getOrderStatus: vi.fn(), mintLiveToken: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => deps.cookies() }));
vi.mock('@/lib/supabase/admin', () => ({ adminClient: () => deps.admin }));
vi.mock('@/lib/supabase/server', () => ({ userClient: (req) => deps.userClient(req) }));
// Rate limiting is orthogonal here; no network or payment-provider call is made.
vi.mock('@/lib/ratelimit', () => ({ limitRoom: vi.fn(), limitUser: vi.fn(), rateLimit: vi.fn(), LIMITS: { view: 100, joinHourly: 100 } }));
vi.mock('@/lib/live-token', () => ({ mintLiveToken: deps.mintLiveToken }));
vi.mock('@/lib/pinelabs', async (importOriginal) => ({
  ...await importOriginal(),
  isConfigured: () => true,
  getOrderStatus: deps.getOrderStatus,
  createOrder: () => { throw new Error('Payment creation outside privacy-test scope'); },
  cancelOrder: () => { throw new Error('Payment cancellation outside privacy-test scope'); },
}));

import { hashSecret } from '../lib/room';
import { GET as viewRoom } from '../app/api/rooms/[token]/route';
import { POST as joinRoom } from '../app/api/rooms/[token]/join/route';
import { GET as getGuest, PATCH as editGuest } from '../app/api/rooms/[token]/me/route';
import { POST as vote, DELETE as unvote } from '../app/api/rooms/[token]/vote/route';
import { POST as closeRoom } from '../app/api/rooms/[token]/close/route';
import { POST as confirmRoom } from '../app/api/rooms/[token]/confirm/route';
import { GET as getPayment } from '../app/api/rooms/[token]/pay/route';
import { GET as getVoiceToken } from '../app/api/rooms/[token]/voice-token/route';
import * as contacts from '../app/api/me/contacts/route';
import * as contact from '../app/api/me/contacts/[id]/route';
import * as goals from '../app/api/me/goals/route';
import * as interactions from '../app/api/me/interactions/route';
import * as meetups from '../app/api/me/meetups/route';
import * as meetup from '../app/api/me/meetups/[id]/route';

let db, tenants;
const requestStorage = new AsyncLocalStorage();
const browser = () => {
  const values = new Map();
  const writes = [];
  return {
    values, writes,
    get: (name) => values.has(name) ? { value: values.get(name) } : undefined,
    set(name, value, options) { values.set(name, value); writes.push({ name, options }); },
  };
};
function invoke(handler, { session = browser(), token = tenants.alice.meetup.room_token, id, uid, secret, body, method = 'GET' } = {}) {
  const headers = new Headers();
  if (uid) headers.set('x-test-user', uid); // Test identity only; real Supabase Auth is not exercised.
  if (secret !== undefined) headers.set('x-guest-secret', secret);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const request = new Request(`https://example.test/api/rooms/${token}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return requestStorage.run(session, () => handler(request, { params: Promise.resolve({ token, id }) }));
}
async function join(session, name, token = tenants.alice.meetup.room_token, preferences = {}) {
  const response = await invoke(joinRoom, { session, token, method: 'POST', body: { guest_name: name, preferences } });
  expect(response.status).toBe(201);
  return response.json();
}
const guestRows = () => asRole(db, 'service_role', null, (tx) => tx.query('select * from meetup_attendees order by guest_name'));

beforeAll(async () => { db = await privacyDatabase(); }, 30_000);
beforeEach(async () => {
  tenants = await seedPrivateData(db);
  vi.clearAllMocks();
  deps.getOrderStatus.mockResolvedValue('pending');
  deps.mintLiveToken.mockResolvedValue({ token: 'synthetic-ephemeral-token', model: 'synthetic-model', voice: 'synthetic-voice' });
  deps.admin = pgliteClient(db, 'service_role');
  deps.userClient = (req) => {
    const uid = req.headers.get('x-test-user');
    return pgliteClient(db, uid ? 'authenticated' : 'anon', uid);
  };
  deps.cookies = () => requestStorage.getStore();
  // Any accidental external fetch is a test failure, not a provider call.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External fetch forbidden in local privacy tests'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => { await db?.close(); });

describe('public room privacy, using real routes and a service-role PostgreSQL adapter', () => {
  it('keeps two independent cookie sessions distinct and returns each secret only to its joining guest', async () => {
    const first = browser(), second = browser();
    const [a, b] = await Promise.all([join(first, 'Guest A'), join(second, 'Guest B')]);
    expect(a.attendee_id).not.toBe(b.attendee_id);
    expect(a.guest_secret).not.toBe(b.guest_secret);
    expect(a.room.me.attendee_id).toBe(a.attendee_id);
    expect(b.room.me.attendee_id).toBe(b.attendee_id);
    for (const [session, guest] of [[first, a], [second, b]]) {
      const response = await invoke(getGuest, { session });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.attendee.id).toBe(guest.attendee_id);
      expect(payload.attendee).not.toHaveProperty('secret_hash');
      expect(session.writes).toEqual([{ name: `guest_${tenants.alice.meetup.id}`, options: expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }) }]);
      expect((await invoke(joinRoom, { session, method: 'POST', body: { guest_name: 'Duplicate' } })).status).toBe(409);
    }
    const rows = (await guestRows()).rows;
    expect(rows.map((row) => row.secret_hash).sort()).toEqual([hashSecret(a.guest_secret), hashSecret(b.guest_secret)].sort());
    expect(JSON.stringify(a.room)).not.toContain(b.guest_secret);
    expect(JSON.stringify(b.room)).not.toContain(a.guest_secret);
  });

  it('projects only the intended public fields, excluding private notes, identities, secrets, and payment details', async () => {
    const a = await join(browser(), 'Guest A', undefined, { location: { lat: 12.971, lng: 77.641, label: 'Shared A' } });
    const b = await join(browser(), 'Guest B', undefined, { location: { lat: 12.981, lng: 77.651, label: 'Shared B' } });
    const otherRoomGuest = await join(browser(), 'Other room guest', tenants.bob.meetup.room_token);
    await asRole(db, 'service_role', null, (tx) => tx.query(`insert into meetup_payments
      (meetup_id, attendee_id, amount_paise, pine_order_id, redirect_url)
      values ($1, $2, 50000, 'synthetic-private-order', 'https://checkout.example.test/private')`, [tenants.alice.meetup.id, a.attendee_id]));
    const response = await invoke(viewRoom);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(Object.keys(payload).sort()).toEqual(['amount_due_paise', 'attendees', 'is_organizer', 'leading_venue_id', 'me', 'meeting_point', 'meetup', 'payments', 'shortlist', 'shortlist_note', 'votes'].sort());
    expect(Object.keys(payload.meetup).sort()).toEqual(['title', 'activity', 'area', 'starts_at', 'budget', 'status', 'expires_at', 'final_venue'].sort());
    expect(payload.me).toBeNull();
    expect(payload.is_organizer).toBe(false);
    expect(payload.payments).toEqual({ [a.attendee_id]: 'pending' });
    expect(payload.attendees.map((row) => row.id).sort()).toEqual([a.attendee_id, b.attendee_id].sort());
    for (const attendee of payload.attendees) {
      expect(Object.keys(attendee).sort()).toEqual(['id', 'guest_name', 'preferences', 'availability', 'joined_at'].sort());
      expect(Object.keys(attendee.preferences.location)).toEqual(['label']);
    }
    expect(payload.meeting_point.pins).toEqual(expect.arrayContaining([
      { name: 'Guest A', lat: 12.97, lng: 77.64 }, { name: 'Guest B', lat: 12.98, lng: 77.65 },
    ]));
    const serialized = JSON.stringify(payload);
    for (const hidden of [
      identities.alice, identities.bob, tenants.alice.contact.notes, tenants.bob.contact.notes,
      tenants.alice.interaction.notes, tenants.alice.meetup.notes, tenants.bob.meetup.notes,
      tenants.alice.contact.email, tenants.alice.meetup.room_token, tenants.bob.meetup.room_token,
      a.guest_secret, b.guest_secret, hashSecret(a.guest_secret), hashSecret(b.guest_secret),
      otherRoomGuest.attendee_id, 'synthetic-private-order', 'https://checkout.example.test/private',
    ]) expect(serialized).not.toContain(hidden);
  });

  it('denies absent, forged, or other-room guest credentials without changing any guest', async () => {
    const valid = await join(browser(), 'Guest A');
    const foreign = await join(browser(), 'Other room', tenants.bob.meetup.room_token);
    const before = (await guestRows()).rows;
    for (const secret of [undefined, 'synthetic-invalid-secret', foreign.guest_secret]) {
      for (const [handler, method, body] of [[getGuest, 'GET'], [editGuest, 'PATCH', { guest_name: 'Intruder' }], [vote, 'POST', { venue_id: identities.venue }], [unvote, 'DELETE'], [getPayment, 'GET'], [getVoiceToken, 'GET']]) {
        const response = await invoke(handler, { secret, method, body });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Join this room first' });
      }
    }
    expect((await guestRows()).rows).toEqual(before);
    expect(deps.getOrderStatus).not.toHaveBeenCalled();
    expect(deps.mintLiveToken).not.toHaveBeenCalled();
    expect((await invoke(getGuest, { secret: valid.guest_secret })).status).toBe(200);
    expect((await invoke(getGuest, { secret: valid.guest_secret, token: tenants.bob.meetup.room_token })).status).toBe(401);
  });

  it('ignores forged attendee/room/secret fields and edits only the authenticated guest', async () => {
    const first = browser(), second = browser();
    const a = await join(first, 'Guest A');
    const b = await join(second, 'Guest B');
    const response = await invoke(editGuest, { session: first, method: 'PATCH', body: {
      id: b.attendee_id, meetup_id: tenants.bob.meetup.id, secret_hash: 'replacement-hash', guest_name: 'Guest A edited',
    } });
    expect(response.status).toBe(200);
    expect((await response.json()).me.attendee_id).toBe(a.attendee_id);
    const rows = (await guestRows()).rows;
    expect(rows.find((row) => row.id === a.attendee_id)).toMatchObject({ guest_name: 'Guest A edited', meetup_id: tenants.alice.meetup.id, secret_hash: hashSecret(a.guest_secret) });
    expect(rows.find((row) => row.id === b.attendee_id)).toMatchObject({ guest_name: 'Guest B', secret_hash: hashSecret(b.guest_secret) });
  });

  it('keeps votes and withdrawals independent, including a header overriding a different cookie session', async () => {
    const first = browser(), second = browser();
    const a = await join(first, 'Guest A');
    const b = await join(second, 'Guest B');
    for (const session of [first, second]) expect((await invoke(vote, { session, method: 'POST', body: { venue_id: identities.venue, attendee_id: b.attendee_id } })).status).toBe(200);
    const withdrawn = await invoke(unvote, { session: first, method: 'DELETE' });
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json()).votes).toEqual({ [identities.venue]: 1 });
    const own = await (await invoke(viewRoom, { session: first })).json();
    const other = await (await invoke(viewRoom, { session: first, secret: b.guest_secret })).json();
    expect(own.me).toEqual({ attendee_id: a.attendee_id, voted_venue_id: null });
    expect(other.me).toEqual({ attendee_id: b.attendee_id, voted_venue_id: identities.venue });
    expect((await invoke(getGuest, { session: first, secret: 'bad-header-even-with-valid-cookie' })).status).toBe(401);
  });

  it("exposes only the current guest's payment and never refreshes another guest's provider order", async () => {
    const first = browser(), second = browser(), third = browser();
    const a = await join(first, 'Guest A');
    const b = await join(second, 'Guest B');
    await join(third, 'Guest without payment');
    for (const [guest, marker] of [[a, 'A'], [b, 'B']]) {
      await asRole(db, 'service_role', null, (tx) => tx.query(`insert into meetup_payments
        (meetup_id, attendee_id, amount_paise, pine_order_id, redirect_url)
        values ($1, $2, 50000, $3, $4)`,
      [tenants.alice.meetup.id, guest.attendee_id, `synthetic-order-${marker}`, `https://checkout.example.test/${marker}`]));
    }
    for (const [session, marker] of [[first, 'A'], [second, 'B']]) {
      deps.getOrderStatus.mockClear();
      const response = await invoke(getPayment, { session });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ payment: {
        status: 'pending', amount_paise: 50000, redirect_url: `https://checkout.example.test/${marker}`,
      } });
      expect(deps.getOrderStatus).toHaveBeenCalledExactlyOnceWith(`synthetic-order-${marker}`);
    }
    deps.getOrderStatus.mockClear();
    expect(await (await invoke(getPayment, { session: third })).json()).toEqual({ payment: null });
    expect(deps.getOrderStatus).not.toHaveBeenCalled();
  });

  it('only mints a voice token for a valid joined guest and marks the response non-cacheable', async () => {
    const session = browser();
    await join(session, 'Voice guest');
    const response = await invoke(getVoiceToken, { session });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ token: 'synthetic-ephemeral-token', model: 'synthetic-model', voice: 'synthetic-voice' });
    expect(deps.mintLiveToken).toHaveBeenCalledOnce();
    await invoke(closeRoom, { uid: identities.alice, method: 'POST' });
    expect((await invoke(getVoiceToken, { session })).status).toBe(410);
    expect(deps.mintLiveToken).toHaveBeenCalledOnce();
  });

  it('requires organizer authentication and ownership to confirm or close a room', async () => {
    for (const handler of [confirmRoom, closeRoom]) {
      expect((await invoke(handler, { method: 'POST', body: { venue_id: identities.venue } })).status).toBe(401);
      expect((await invoke(handler, { uid: identities.bob, method: 'POST', body: { venue_id: identities.venue } })).status).toBe(403);
    }
    const foreignView = await (await invoke(viewRoom, { uid: identities.bob })).json();
    expect(foreignView.is_organizer).toBe(false);
    const ownerView = await (await invoke(viewRoom, { uid: identities.alice })).json();
    expect(ownerView.is_organizer).toBe(true);
    expect((await invoke(confirmRoom, { uid: identities.alice, method: 'POST', body: { venue_id: identities.venue } })).status).toBe(200);
    expect((await invoke(closeRoom, { uid: identities.alice, method: 'POST' })).status).toBe(200);
  });
});

describe('private route authentication and RLS integration', () => {
  it('returns 401 before querying private data for unauthenticated read and mutation routes', async () => {
    const anonymous = pgliteClient(db, 'anon');
    const userQueries = vi.spyOn(anonymous, 'from');
    const serviceQueries = vi.spyOn(deps.admin, 'from');
    deps.userClient = () => anonymous;
    const cases = [
      [contacts.GET, 'GET'], [contacts.POST, 'POST'], [contact.GET, 'GET'], [contact.PATCH, 'PATCH'], [contact.DELETE, 'DELETE'],
      [goals.GET, 'GET'], [goals.PUT, 'PUT'], [interactions.GET, 'GET'], [interactions.POST, 'POST'],
      [meetups.GET, 'GET'], [meetups.POST, 'POST'], [meetup.GET, 'GET'], [meetup.PATCH, 'PATCH'], [meetup.DELETE, 'DELETE'],
    ];
    for (const [handler, method] of cases) {
      const response = await invoke(handler, { method, id: tenants.bob.contact.id });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Not signed in' });
    }
    expect(userQueries).not.toHaveBeenCalled();
    expect(serviceQueries).not.toHaveBeenCalled();
  });

  it('private contact and meetup detail routes return 404 for another organizer\'s IDs and do not mutate them', async () => {
    for (const [routes, id, body] of [
      [contact, tenants.bob.contact.id, { name: 'Stolen contact', notes: 'Changed' }],
      [meetup, tenants.bob.meetup.id, { title: 'Stolen meetup', notes: 'Changed' }],
    ]) {
      for (const [handler, method] of [[routes.GET, 'GET'], [routes.PATCH, 'PATCH'], [routes.DELETE, 'DELETE']]) {
        const response = await invoke(handler, { uid: identities.alice, id, method, body: method === 'PATCH' ? body : undefined });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Not found' });
      }
      expect((await invoke(routes.GET, { uid: identities.bob, id })).status).toBe(200);
    }
    const ownerContact = await (await invoke(contact.GET, { uid: identities.bob, id: tenants.bob.contact.id })).json();
    const ownerMeetup = await (await invoke(meetup.GET, { uid: identities.bob, id: tenants.bob.meetup.id })).json();
    expect(ownerContact.contact.notes).toBe(tenants.bob.contact.notes);
    expect(ownerMeetup.meetup.notes).toBe(tenants.bob.meetup.notes);
  });
});
