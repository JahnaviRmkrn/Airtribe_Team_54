import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseKey } from '../../../lib/secretbox.mjs';
import { createHandler } from '../src/server.mjs';
import { BridgeError, SessionManager } from '../src/session.mjs';
import { UserStore } from '../src/store.mjs';

const UID = '11111111-1111-4111-8111-111111111111';
const key = parseKey('cd'.repeat(32));
const SECRET = 's'.repeat(40);

function fakeSocket() {
  const sock = {
    ev: new EventEmitter(),
    user: { id: '919876543210:7@s.whatsapp.net' },
    sent: [],
    ended: false,
    loggedOut: false,
    end() { this.ended = true; },
    async logout() { this.loggedOut = true; },
    async sendMessage(jid, content) { this.sent.push([jid, content]); return { key: { id: 'MSG1' } }; },
    async onWhatsApp(jid) { return [{ jid, exists: !jid.startsWith('0') }]; },
    async groupFetchAllParticipating() { return { '120363000000000001@g.us': { id: '120363000000000001@g.us', subject: 'Climbing', participants: [{}, {}] } }; },
    async requestPairingCode() { return 'ABCD1234'; },
  };
  return sock;
}

let root;
let socks;
let mgr;
const make = () => new SessionManager({
  root, key, now: () => clock,
  makeSocket: async (auth) => { const s = fakeSocket(); s.auth = auth; socks.push(s); return s; },
});
let clock;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wa-test-'));
  socks = [];
  clock = 1_000_000;
  mgr = make();
});
afterEach(async () => {
  await mgr.shutdown();
  await rm(root, { recursive: true, force: true });
});

const emit = (n, ev, payload) => socks[n].ev.emit(ev, payload);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function link() {
  await mgr.start(UID);
  emit(0, 'connection.update', { qr: 'qr-string' });
  await tick();
  // Pairing finished: Baileys stores `me` in creds, then the socket opens.
  mgr.sessions.get(UID).store.creds.me = { id: '919876543210:7@s.whatsapp.net' };
  emit(0, 'connection.update', { connection: 'open' });
  await tick();
}

describe('SessionManager', () => {
  it('reports the QR while waiting and the number once connected', async () => {
    await mgr.start(UID);
    emit(0, 'connection.update', { qr: 'qr-string' });
    await tick();
    expect(mgr.status(UID)).toMatchObject({ state: 'waiting_qr', qr: 'qr-string', phone: null });
    mgr.sessions.get(UID).store.creds.me = { id: '919876543210:7@s.whatsapp.net' };
    emit(0, 'connection.update', { connection: 'open' });
    await tick();
    expect(mgr.status(UID)).toMatchObject({ state: 'connected', qr: null, phone: '919876543210' });
  });

  it('requests a pairing code when a phone number is given', async () => {
    await mgr.start(UID, { phone: '919876543210' });
    emit(0, 'connection.update', { qr: 'qr-string' });
    await tick();
    expect(mgr.status(UID)).toMatchObject({ state: 'waiting_qr', qr: null, pairing_code: 'ABCD1234' });
  });

  it('start is idempotent while a link is in progress', async () => {
    await mgr.start(UID);
    await mgr.start(UID);
    expect(socks).toHaveLength(1);
  });

  it('stores sessions encrypted and wipes them on unlink', async () => {
    await link();
    await mgr.sessions.get(UID).store.flush();
    const files = await readdir(join(root, UID));
    expect(files).toContain('auth.enc');
    expect((await readFile(join(root, UID, 'auth.enc'))).includes('919876543210')).toBe(false);
    await mgr.unlink(UID);
    expect(socks[0].loggedOut).toBe(true);
    expect(await readdir(root)).toEqual([]);
    expect(mgr.status(UID).state).toBe('unlinked');
  });

  it('wipes everything and reports logged_out on a 401 close', async () => {
    await link();
    await mgr.sessions.get(UID).store.flush();
    emit(0, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await tick();
    expect(mgr.status(UID)).toMatchObject({ state: 'logged_out', error: 'logged_out' });
    expect(await readdir(root)).toEqual([]);
  });

  it('reconnects with backoff after a network drop and keeps the session', async () => {
    await link();
    emit(0, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await tick();
    expect(mgr.status(UID).state).toBe('connecting');
    expect(mgr.sessions.get(UID).attempts).toBe(1);
  });

  it('drops an unscanned session when the QR times out', async () => {
    await mgr.start(UID);
    emit(0, 'connection.update', { qr: 'q' });
    await tick();
    emit(0, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
    await tick();
    expect(mgr.status(UID).state).toBe('unlinked');
    expect(await readdir(root)).toEqual([]);
  });

  it('restores paired sessions on start and sweeps unpaired leftovers', async () => {
    await link();
    await mgr.sessions.get(UID).store.flush();
    const stale = new UserStore(root, '22222222-2222-4222-8222-222222222222', key);
    await stale.load();
    await stale.flush();
    stale.saveCreds();
    await stale.flush();
    await mgr.shutdown();

    mgr = make();
    await mgr.restoreAll();
    expect(mgr.status(UID).state).toBe('connecting');
    expect(await readdir(root)).toEqual([UID]);
  });

  it('collects contacts, groups and push names; lists and looks them up', async () => {
    await link();
    emit(0, 'contacts.upsert', [{ id: '919000000001@s.whatsapp.net', name: 'Asha Rao' }, { id: 'status@broadcast', name: 'x' }]);
    emit(0, 'messaging-history.set', { contacts: [{ id: '919000000002@s.whatsapp.net', notify: 'ravi' }] });
    emit(0, 'messages.upsert', { messages: [{ key: { remoteJid: '919000000003@s.whatsapp.net', fromMe: false }, pushName: 'Meera' }] });
    await tick(60);
    const all = mgr.contacts(UID);
    expect(all.total).toBe(3);
    expect(all.contacts.map((c) => c.name)).toEqual(['Asha Rao', 'Meera', 'ravi']);
    expect(mgr.contacts(UID, { q: '0002' }).contacts).toHaveLength(1);
    expect(mgr.lookup(UID, ['919000000001@s.whatsapp.net', '1@s.whatsapp.net'])).toEqual([{ jid: '919000000001@s.whatsapp.net', name: 'Asha Rao', phone: '919000000001' }]);
    expect(mgr.groups(UID)).toEqual([{ jid: '120363000000000001@g.us', subject: 'Climbing', size: 2 }]);
  });

  describe('send', () => {
    beforeEach(async () => {
      await link();
      emit(0, 'contacts.upsert', [{ id: '919000000001@s.whatsapp.net', name: 'Asha' }]);
      await tick(60);
    });

    it('sends to a synced contact and a group', async () => {
      await mgr.send(UID, '919000000001@s.whatsapp.net', 'hi');
      clock += 2000;
      await mgr.send(UID, '120363000000000001@g.us', 'hi all');
      expect(socks[0].sent).toHaveLength(2);
    });

    it('refuses unknown recipients unless the caller vouches for a muop contact on WhatsApp', async () => {
      await expect(mgr.send(UID, '919111111111@s.whatsapp.net', 'x')).rejects.toMatchObject({ status: 403 });
      await expect(mgr.send(UID, '919111111111@s.whatsapp.net', 'x', { viaContact: true })).resolves.toBeTruthy();
      clock += 2000;
      await expect(mgr.send(UID, '0123456789@s.whatsapp.net', 'x', { viaContact: true })).rejects.toMatchObject({ status: 404 });
      await expect(mgr.send(UID, '120363999999999999@g.us', 'x', { viaContact: true })).rejects.toMatchObject({ status: 403 });
    });

    it('rejects malformed jids and empty or oversized text', async () => {
      await expect(mgr.send(UID, 'status@broadcast', 'x')).rejects.toMatchObject({ status: 400 });
      await expect(mgr.send(UID, '919000000001@s.whatsapp.net', '  ')).rejects.toMatchObject({ status: 400 });
      await expect(mgr.send(UID, '919000000001@s.whatsapp.net', 'x'.repeat(5000))).rejects.toMatchObject({ status: 400 });
    });

    it('enforces a gap between sends and an hourly cap', async () => {
      await mgr.send(UID, '919000000001@s.whatsapp.net', 'a');
      await expect(mgr.send(UID, '919000000001@s.whatsapp.net', 'b')).rejects.toMatchObject({ status: 429 });
      for (let i = 0; i < 24; i++) {
        clock += 2000;
        await mgr.send(UID, '919000000001@s.whatsapp.net', 'c');
      }
      clock += 2000;
      await expect(mgr.send(UID, '919000000001@s.whatsapp.net', 'd')).rejects.toMatchObject({ status: 429 });
      clock += 3_600_000;
      await expect(mgr.send(UID, '919000000001@s.whatsapp.net', 'e')).resolves.toBeTruthy();
    });

    it('requires a connected session', async () => {
      await expect(mgr.send('33333333-3333-4333-8333-333333333333', 'x', 'y')).rejects.toBeInstanceOf(BridgeError);
    });
  });
});

describe('http handler', () => {
  const run = async (method, url, { secret = SECRET, body } = {}) => {
    const handler = createHandler({ manager: mgr, secret: SECRET });
    const { Readable } = await import('node:stream');
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method, url, headers: secret ? { 'x-wa-bridge-secret': secret } : {} });
    let status; let text = '';
    const res = { writeHead: (s) => { status = s; }, end: (t) => { text = t; } };
    await handler(req, res);
    return { status, json: JSON.parse(text) };
  };

  it('requires the shared secret', async () => {
    expect((await run('GET', `/sessions/${UID}/status`, { secret: '' })).status).toBe(401);
    expect((await run('GET', `/sessions/${UID}/status`, { secret: 'x'.repeat(40) })).status).toBe(401);
    expect((await run('GET', `/sessions/${UID}/status`)).status).toBe(200);
  });

  it('rejects ids that are not uuids (no path traversal into the session dir)', async () => {
    expect((await run('GET', '/sessions/..%2F..%2Fetc/status')).status).toBe(404);
    expect((await run('DELETE', '/sessions/../x')).status).toBe(404);
  });

  it('starts a session and maps bridge errors to status codes', async () => {
    expect((await run('POST', `/sessions/${UID}/start`, { body: {} })).json.state).toBe('connecting');
    const r = await run('POST', `/sessions/${UID}/send`, { body: { jid: 'a@s.whatsapp.net', text: 'x' } });
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: 'not_connected' });
  });
});
