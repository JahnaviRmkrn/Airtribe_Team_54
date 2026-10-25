// AES-256-GCM sealing for secrets stored at rest (WhatsApp sessions, SMS
// gateway credentials). Plain .mjs so the Next server (lib/*.ts) and the
// WhatsApp bridge service (services/whatsapp) share one implementation.
//
// Blob layout: version(1) | iv(12) | tag(16) | ciphertext. The master key
// (env WA_SESSION_KEY) is never used directly: each `context` string (for
// example "wa-auth:<user id>") derives its own subkey via HKDF and is also
// bound as GCM additional data, so a blob copied to another user or another
// purpose fails to open instead of decrypting.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;
const SALT = Buffer.from('muop-secretbox-v1');

/** Parses WA_SESSION_KEY: 32 bytes as 64 hex chars or base64. Throws on anything else. */
export function parseKey(raw) {
  const s = String(raw ?? '').trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) key = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) key = Buffer.from(s, 'base64');
  if (!key || key.length !== 32) throw new Error('WA_SESSION_KEY must be 32 bytes, as 64 hex characters or base64 (generate: openssl rand -hex 32)');
  return key;
}

const subkey = (key, context) => Buffer.from(hkdfSync('sha256', key, SALT, Buffer.from(context), 32));

/** Encrypts `plaintext` (Buffer or string) for `context`; returns a Buffer. */
export function seal(plaintext, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', subkey(key, context), iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

/** Decrypts a blob from seal(); throws if tampered, truncated or opened with the wrong key/context. */
export function open(blob, key, context) {
  if (!Buffer.isBuffer(blob) || blob.length < 1 + 12 + 16 || blob[0] !== VERSION) throw new Error('Unreadable encrypted blob');
  const decipher = createDecipheriv('aes-256-gcm', subkey(key, context), blob.subarray(1, 13));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
}

/** String variants (base64) for database columns. */
export const sealString = (plaintext, key, context) => seal(plaintext, key, context).toString('base64');
export const openString = (b64, key, context) => open(Buffer.from(String(b64), 'base64'), key, context).toString('utf8');
