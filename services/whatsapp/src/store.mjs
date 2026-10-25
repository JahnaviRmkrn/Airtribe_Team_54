// Per-user encrypted storage under WA_SESSION_DIR/<user id>/:
//   auth.enc       Baileys creds + Signal keys (the linked-device session)
//   directory.enc  synced contacts and groups (names are personal data)
// Everything is AES-256-GCM sealed (lib/secretbox.mjs) with a per-user,
// per-file context, written atomically (tmp + rename) with 0600 permissions.
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { open, seal } from '../../../lib/secretbox.mjs';

export const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CONTACTS = 20_000;
const MAX_GROUPS = 2_000;
const FLUSH_MS = 750;

const ser = (v) => JSON.stringify(v, BufferJSON.replacer);
const de = (s) => JSON.parse(s, BufferJSON.reviver);

/** Only individual accounts are contacts: not groups, broadcasts, status or channels. */
export const isPersonJid = (jid) => typeof jid === 'string' && /^[0-9]{5,20}(:[0-9]+)?@(s\.whatsapp\.net|lid)$/.test(jid);
export const isGroupJid = (jid) => typeof jid === 'string' && /^[0-9-]{5,40}@g\.us$/.test(jid);

export class UserStore {
  constructor(root, uid, key) {
    if (!UID_RE.test(uid)) throw new Error('bad user id');
    this.uid = uid;
    this.key = key;
    this.dir = join(root, uid);
    this.creds = null;
    this.keys = {};
    this.contacts = new Map(); // jid -> { name?, notify?, phone? }
    this.groups = new Map(); // jid -> { subject, size }
    this.dirty = new Set();
    this.timer = null;
    this.chain = Promise.resolve();
    this.wiped = false;
  }

  ctx(file) {
    return `wa:${file}:${this.uid}`;
  }

  async #read(file) {
    try {
      return open(await readFile(join(this.dir, file)), this.key, this.ctx(file)).toString('utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async #write(file, text) {
    if (this.wiped) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, file);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, seal(text, this.key, this.ctx(file)), { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
  }

  /** Loads (or creates) the session. Throws if a file exists but can't be decrypted. */
  async load() {
    const auth = await this.#read('auth.enc');
    if (auth) {
      const parsed = de(auth);
      this.creds = parsed.creds;
      this.keys = parsed.keys ?? {};
    } else {
      this.creds = initAuthCreds();
      this.keys = {};
    }
    const dir = await this.#read('directory.enc');
    if (dir) {
      const d = JSON.parse(dir);
      this.contacts = new Map(Object.entries(d.contacts ?? {}));
      this.groups = new Map(Object.entries(d.groups ?? {}));
    }
  }

  get paired() {
    return Boolean(this.creds?.me?.id);
  }

  /** The `auth` option for makeWASocket. */
  authState() {
    return {
      creds: this.creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let v = this.keys[type]?.[id];
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }
          return out;
        },
        set: async (data) => {
          for (const [type, entries] of Object.entries(data)) {
            this.keys[type] ??= {};
            for (const [id, v] of Object.entries(entries)) {
              if (v == null) delete this.keys[type][id];
              else this.keys[type][id] = v;
            }
          }
          this.#schedule('auth');
        },
      },
    };
  }

  saveCreds() {
    this.#schedule('auth');
  }

  upsertContact(jid, patch) {
    if (!isPersonJid(jid)) return;
    const cur = this.contacts.get(jid);
    if (!cur && this.contacts.size >= MAX_CONTACTS) return;
    const next = { ...cur };
    for (const f of ['name', 'notify']) {
      const v = typeof patch[f] === 'string' ? patch[f].trim().slice(0, 120) : '';
      if (v) next[f] = v;
    }
    if (patch.phone && /^[0-9]{5,15}$/.test(patch.phone)) next.phone = patch.phone;
    if (!cur || JSON.stringify(cur) !== JSON.stringify(next)) {
      this.contacts.set(jid, next);
      this.#schedule('dir');
    }
  }

  setGroup(jid, subject, size) {
    if (!isGroupJid(jid)) return;
    if (!this.groups.has(jid) && this.groups.size >= MAX_GROUPS) return;
    this.groups.set(jid, { subject: String(subject ?? '').slice(0, 120), size: Number.isInteger(size) ? size : 0 });
    this.#schedule('dir');
  }

  #schedule(which) {
    this.dirty.add(which);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  /** Writes whatever changed. Serialised so writes never interleave. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const which = [...this.dirty];
    this.dirty.clear();
    this.chain = this.chain
      .then(async () => {
        if (which.includes('auth')) await this.#write('auth.enc', ser({ creds: this.creds, keys: this.keys }));
        if (which.includes('dir')) {
          await this.#write('directory.enc', JSON.stringify({
            contacts: Object.fromEntries(this.contacts),
            groups: Object.fromEntries(this.groups),
          }));
        }
      })
      .catch((e) => console.error('session write failed', e.code ?? e.name));
    return this.chain;
  }

  /** Deletes every byte stored for this user. */
  async wipe() {
    this.wiped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
    await this.chain.catch(() => {});
    await rm(this.dir, { recursive: true, force: true });
    this.creds = null;
    this.keys = {};
    this.contacts.clear();
    this.groups.clear();
  }
}

/** User ids that have a session directory under root. */
export async function listUsers(root) {
  try {
    return (await readdir(root)).filter((n) => UID_RE.test(n));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
