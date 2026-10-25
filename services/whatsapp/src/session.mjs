// Owns every user's WhatsApp socket. One Session per muop user id.
// The socket factory is injected (see socket.mjs) so tests drive this with a fake.
//
// Logging rule: ids, states and close codes only. Never message text, phone
// numbers, JIDs or contact names.
import { onClose, initialState, reduce } from './state.mjs';
import { isGroupJid, isPersonJid, listUsers, UserStore } from './store.mjs';

const PENDING_TTL_MS = 150_000; // a QR / pairing code that is not used within this is dropped
const MAX_PENDING = 20; // concurrent unlinked sessions waiting on a scan
const SEND_PER_HOUR = 25; // bridge-side hard cap (Next enforces a lower 20/h per user first)
const SEND_GAP_MS = 1500;
const MAX_TEXT = 4096;

export class BridgeError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const phoneOf = (jid) => (jid && /@s\.whatsapp\.net$/.test(jid) ? jid.split('@')[0].split(':')[0] : null);
const cleanJid = (jid) => (jid ? jid.replace(/:[0-9]+@/, '@') : null);

export class SessionManager {
  constructor({ root, key, makeSocket, log = () => {}, now = () => Date.now() }) {
    this.root = root;
    this.key = key;
    this.makeSocket = makeSocket;
    this.log = log;
    this.now = now;
    this.sessions = new Map();
    this.closing = false;
  }

  /** Reconnects every paired session found on disk; sweeps never-paired leftovers. */
  async restoreAll() {
    for (const uid of await listUsers(this.root)) {
      const store = new UserStore(this.root, uid, this.key);
      try {
        await store.load();
      } catch {
        this.log('unreadable session, leaving file untouched', uid);
        continue;
      }
      if (!store.paired) {
        await store.wipe();
        continue;
      }
      const s = this.#create(uid, store);
      s.st = reduce(initialState(), { type: 'start' });
      void this.#connect(s);
    }
  }

  #create(uid, store) {
    const s = { uid, store, sock: null, st: initialState(), attempts: 0, timer: null, ttl: null, phone: null, sends: [], lastSend: 0, syncedAt: null };
    this.sessions.set(uid, s);
    return s;
  }

  /** Starts (or resumes) a link. Idempotent while a link is in progress or connected. */
  async start(uid, { phone } = {}) {
    let s = this.sessions.get(uid);
    if (s && ['connected', 'connecting', 'waiting_qr'].includes(s.st.state)) return this.status(uid);
    if (s) await this.#teardown(s, false);
    const store = new UserStore(this.root, uid, this.key);
    await store.load();
    if (!store.paired) {
      const pending = [...this.sessions.values()].filter((x) => !x.store.paired && ['connecting', 'waiting_qr'].includes(x.st.state)).length;
      if (pending >= MAX_PENDING) throw new BridgeError(503, 'busy');
    }
    s = this.#create(uid, store);
    s.phone = phone ?? null;
    s.st = reduce(s.st, { type: 'start' });
    if (!store.paired) {
      s.ttl = setTimeout(() => void this.#expire(s), PENDING_TTL_MS);
      s.ttl.unref?.();
    }
    await this.#connect(s);
    return this.status(uid);
  }

  async #expire(s) {
    if (s.st.state === 'connected' || s.store.paired) return;
    await this.#teardown(s, true);
    s.st = reduce(s.st, { type: 'unlink' });
  }

  async #connect(s) {
    if (this.closing) return;
    let sock;
    try {
      sock = await this.makeSocket(s.store.authState());
    } catch {
      this.log('socket create failed', s.uid);
      s.st = reduce(s.st, { type: 'fail', error: 'connection_failed' });
      return;
    }
    s.sock = sock;
    const live = () => s.sock === sock; // events from a replaced socket are ignored
    const { ev } = sock;

    ev.on('creds.update', () => live() && s.store.saveCreds());
    ev.on('connection.update', (u) => live() && void this.#onConnection(s, sock, u));
    ev.on('messaging-history.set', ({ contacts }) => {
      if (!live()) return;
      for (const c of contacts ?? []) this.#addContact(s, c);
      s.syncedAt = this.now();
    });
    ev.on('contacts.upsert', (list) => live() && list.forEach((c) => this.#addContact(s, c)));
    ev.on('contacts.update', (list) => live() && list.forEach((c) => this.#addContact(s, c)));
    ev.on('messages.upsert', ({ messages }) => {
      if (!live()) return;
      // Push names: what people call themselves, for anyone who has messaged this account.
      for (const m of messages ?? []) {
        if (!m.key?.fromMe && m.pushName && isPersonJid(m.key?.remoteJid)) s.store.upsertContact(m.key.remoteJid, { notify: m.pushName });
      }
    });
    ev.on('groups.upsert', (list) => live() && list.forEach((g) => s.store.setGroup(g.id, g.subject, g.participants?.length)));
    ev.on('groups.update', (list) => {
      if (!live()) return;
      for (const g of list) if (g.subject) s.store.setGroup(g.id, g.subject, s.store.groups.get(g.id)?.size);
    });
  }

  #addContact(s, c) {
    const jid = c.id ?? c.jid;
    s.store.upsertContact(jid, {
      name: c.name ?? c.verifiedName,
      notify: c.notify,
      phone: phoneOf(c.phoneNumber) ?? phoneOf(jid),
    });
  }

  async #onConnection(s, sock, { connection, lastDisconnect, qr }) {
    if (qr) {
      if (s.phone && !s.store.paired && typeof sock.requestPairingCode === 'function') {
        if (s.st.pairingCode) return;
        try {
          const code = await sock.requestPairingCode(s.phone);
          s.st = reduce(s.st, { type: 'pairing_code', code });
        } catch {
          s.st = reduce(s.st, { type: 'fail', error: 'pairing_code_failed' });
        }
      } else {
        s.st = reduce(s.st, { type: 'qr', qr });
      }
    }
    if (connection === 'open') {
      s.attempts = 0;
      clearTimeout(s.ttl);
      s.st = reduce(s.st, { type: 'open', jid: cleanJid(sock.user?.id ?? s.store.creds?.me?.id) });
      s.store.saveCreds(); // a connected session is always persisted
      await s.store.flush();
      void this.#fetchGroups(s, sock);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const d = onClose(code, { paired: s.store.paired, attempts: s.attempts });
      this.log('closed', s.uid, code, d.action);
      try {
        sock.end(undefined);
      } catch {
        // already closed
      }
      s.sock = null;
      if (d.action === 'wipe') {
        clearTimeout(s.ttl);
        await s.store.wipe();
        s.st = reduce(s.st, { type: d.event });
      } else if (d.action === 'stop') {
        s.st = reduce(s.st, { type: 'fail', error: d.error });
      } else if (!this.closing) {
        if (d.delayMs > 0) s.attempts++;
        s.st = reduce(s.st, { type: 'reconnecting' });
        s.timer = setTimeout(() => void this.#connect(s), d.delayMs);
        s.timer.unref?.();
      }
    }
  }

  async #fetchGroups(s, sock) {
    try {
      const all = await sock.groupFetchAllParticipating();
      for (const g of Object.values(all ?? {})) s.store.setGroup(g.id, g.subject, g.participants?.length);
      s.syncedAt = this.now();
    } catch {
      this.log('group fetch failed', s.uid);
    }
  }

  async #teardown(s, wipe) {
    clearTimeout(s.timer);
    clearTimeout(s.ttl);
    const sock = s.sock;
    s.sock = null;
    try {
      sock?.end(undefined);
    } catch {
      // already closed
    }
    if (wipe) await s.store.wipe();
    else await s.store.flush();
    this.sessions.delete(s.uid);
  }

  status(uid) {
    const s = this.sessions.get(uid);
    if (!s) return { state: 'unlinked', counts: { contacts: 0, groups: 0 } };
    const { state, qr, pairingCode, jid, error } = s.st;
    return {
      state,
      qr: state === 'waiting_qr' ? qr : null,
      pairing_code: state === 'waiting_qr' ? pairingCode : null,
      phone: state === 'connected' ? phoneOf(jid) : null,
      error,
      synced: s.syncedAt !== null,
      counts: { contacts: s.store.contacts.size, groups: s.store.groups.size },
    };
  }

  /** Logs the device out on the phone (best effort) and deletes every stored byte. */
  async unlink(uid) {
    const s = this.sessions.get(uid);
    if (s) {
      if (s.sock && s.st.state === 'connected') {
        try {
          await Promise.race([s.sock.logout(), new Promise((_, rej) => setTimeout(rej, 5000))]);
        } catch {
          // the phone can still remove the device from Linked devices
        }
      }
      await this.#teardown(s, true);
    } else {
      await new UserStore(this.root, uid, this.key).wipe();
    }
  }

  #connected(uid) {
    const s = this.sessions.get(uid);
    if (!s || s.st.state !== 'connected') throw new BridgeError(409, 'not_connected');
    return s;
  }

  contacts(uid, { q = '', limit = 50, offset = 0 } = {}) {
    const s = this.#connected(uid);
    const needle = q.trim().toLowerCase();
    const rows = [];
    for (const [jid, c] of s.store.contacts) {
      const name = c.name ?? c.notify ?? '';
      const phone = c.phone ?? phoneOf(jid);
      if (needle && !(name.toLowerCase().includes(needle) || (phone ?? '').includes(needle))) continue;
      rows.push({ jid, name, phone });
    }
    rows.sort((a, b) => (a.name || '￿').localeCompare(b.name || '￿') || a.jid.localeCompare(b.jid));
    return { total: rows.length, contacts: rows.slice(offset, offset + limit) };
  }

  /** Name/phone for specific JIDs, so the import route never trusts client-supplied names. */
  lookup(uid, jids) {
    const s = this.#connected(uid);
    return jids.flatMap((jid) => {
      const c = s.store.contacts.get(jid);
      return c ? [{ jid, name: c.name ?? c.notify ?? '', phone: c.phone ?? phoneOf(jid) }] : [];
    });
  }

  groups(uid) {
    const s = this.#connected(uid);
    return [...s.store.groups].map(([jid, g]) => ({ jid, subject: g.subject, size: g.size })).sort((a, b) => a.subject.localeCompare(b.subject));
  }

  /**
   * Sends one text from the user's own account. Recipient must be a synced
   * contact or group, unless the caller (Next) vouches it is one of the user's
   * muop contacts (`viaContact`), in which case the number must be on WhatsApp.
   */
  async send(uid, jid, text, { viaContact = false } = {}) {
    const s = this.#connected(uid);
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new BridgeError(400, 'bad_text');
    if (!isPersonJid(jid) && !isGroupJid(jid)) throw new BridgeError(400, 'bad_jid');
    const known = s.store.contacts.has(jid) || s.store.groups.has(jid);
    if (!known && !(viaContact && isPersonJid(jid))) throw new BridgeError(403, 'unknown_recipient');
    const t = this.now();
    s.sends = s.sends.filter((x) => t - x < 3_600_000);
    if (s.sends.length >= SEND_PER_HOUR || t - s.lastSend < SEND_GAP_MS) throw new BridgeError(429, 'rate_limited');
    if (!known) {
      const found = await s.sock.onWhatsApp(jid);
      if (!found?.[0]?.exists) throw new BridgeError(404, 'not_on_whatsapp');
    }
    s.sends.push(t);
    s.lastSend = t;
    const sent = await s.sock.sendMessage(jid, { text });
    return { id: sent?.key?.id ?? null };
  }

  async shutdown() {
    this.closing = true;
    for (const s of this.sessions.values()) {
      clearTimeout(s.timer);
      clearTimeout(s.ttl);
      try {
        s.sock?.end(undefined);
      } catch {
        // ignore
      }
      await s.store.flush();
    }
  }
}
