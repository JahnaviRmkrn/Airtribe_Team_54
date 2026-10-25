import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { HttpError } from '../http';
import { adminClient } from '../supabase/admin';

// Each purpose has its own cookie, callback and scope allowlist. Connector
// families have separate client settings (Sheets import/export share theirs).
// Adding another connector must not silently broaden Contacts authorization.
export type GooglePurpose = 'contacts' | 'sheets-import' | 'sheets-export' | 'gmail' | 'calendar';
export const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
const PURPOSES = {
  contacts: { prefix: 'GOOGLE_CONTACTS', scope: CONTACTS_SCOPE },
  'sheets-import': { prefix: 'GOOGLE_SHEETS', scope: 'https://www.googleapis.com/auth/spreadsheets.readonly' },
  'sheets-export': { prefix: 'GOOGLE_SHEETS', scope: 'https://www.googleapis.com/auth/drive.file' },
  gmail: { prefix: 'GOOGLE_GMAIL', scope: 'https://www.googleapis.com/auth/gmail.send' },
  calendar: { prefix: 'GOOGLE_CALENDAR', scope: 'https://www.googleapis.com/auth/calendar.events.owned' },
} satisfies Record<GooglePurpose, { prefix: string; scope: string }>;
export const SESSION_SECONDS = 15 * 60;
const CALLBACK_ROOT = '/api/me/integrations/google';
const TABLE = 'google_connector_sessions';
const SETUP = 'This Google connector needs administrator setup. You can still add contacts manually.';

export interface GoogleConfig {
  purpose: GooglePurpose; clientId: string; clientSecret: string;
  origin: string; redirectUri: string; key: Buffer; scope: string;
}

export function googleConfig(purpose: GooglePurpose): GoogleConfig | null {
  const definition = PURPOSES[purpose];
  if (!definition) return null;
  const clientId = process.env[`${definition.prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${definition.prefix}_CLIENT_SECRET`];
  const originInput = process.env.GOOGLE_CONNECTOR_ORIGIN;
  const encryptionKey = process.env.GOOGLE_CONNECTOR_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !originInput || !encryptionKey) return null;
  try {
    const url = new URL(originInput);
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey)) return null;
    const key = Buffer.from(encryptionKey, 'base64');
    if (key.length !== 32) return null;
    return { purpose, clientId, clientSecret, origin: url.origin, redirectUri: `${url.origin}${CALLBACK_ROOT}/${purpose}/callback`, key, scope: definition.scope };
  } catch { return null; }
}

export function requireGoogleConfig(purpose: GooglePurpose) {
  const config = googleConfig(purpose);
  if (!config) throw new HttpError(503, SETUP);
  return config;
}

export function sameOrigin(req: Request, config: GoogleConfig) {
  if (req.headers.get('origin') !== config.origin || req.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'Open Google import from this app and try again.');
  }
}

export const hashHandle = (handle: string) => createHash('sha256').update(handle).digest('hex');
const cookieName = (config: GoogleConfig) => `${config.origin.startsWith('https:') ? '__Secure-' : ''}moup_google_${config.purpose}`;
const cookieOptions = (config: GoogleConfig) => ({
  httpOnly: true, secure: config.origin.startsWith('https:'), sameSite: 'lax' as const,
  path: `${CALLBACK_ROOT}/${config.purpose}`, maxAge: SESSION_SECONDS,
});
export async function setGoogleCookie(config: GoogleConfig, handle: string) {
  (await cookies()).set(cookieName(config), handle, cookieOptions(config));
}
export async function clearGoogleCookie(config: GoogleConfig) {
  (await cookies()).set(cookieName(config), '', { ...cookieOptions(config), maxAge: 0 });
}
export async function googleHandle(config: GoogleConfig) {
  const value = (await cookies()).get(cookieName(config))?.value;
  if (!value || !/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new HttpError(410, 'This import expired or was cancelled. Connect Google again.');
  return value;
}

export function seal(payload: unknown, config: GoogleConfig, id: string, owner: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(Buffer.from(`${id}:${owner}:${config.purpose}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function unseal<T>(value: string, config: GoogleConfig, id: string, owner: string): T {
  try {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', config.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${id}:${owner}:${config.purpose}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { throw new HttpError(410, 'This import is no longer available. Connect Google again.'); }
}

export interface Session<T> { id: string; owner: string; lease: string; expiresAt: string; payload: T }
// Only call after acquiring an authenticated owner's purpose-bound session.
// Returns to server code only; it performs no network request or token refresh.
export function googleAccessToken(session: Session<{ token: string | null; tokenExpiresAt: number }>) {
  const sessionExpiry = Date.parse(session.expiresAt);
  if (!session.payload.token || !Number.isFinite(session.payload.tokenExpiresAt) || !Number.isFinite(sessionExpiry)
    || session.payload.tokenExpiresAt <= Date.now() || sessionExpiry <= Date.now()) {
    throw new HttpError(410, 'Google access expired. Connect Google again before continuing.');
  }
  return session.payload.token;
}
export async function googleConnectorSchemaReady() {
  const { data, error } = await adminClient().rpc('google_connector_session_ready');
  return !error && data === true;
}
export async function createGoogleSession(config: GoogleConfig, owner: string, payload: unknown) {
  const handle = randomBytes(32).toString('base64url');
  const id = hashHandle(handle);
  const db = adminClient();
  // The database checks the owner's current purpose row even when this browser
  // has no cookie. Its row lock also closes the connect/confirm race window.
  // Do not delete expired rows first: their lease may still be in flight.
  const result = await db.rpc('replace_google_connector_session', {
    p_id: id, p_owner: owner, p_purpose: config.purpose,
    p_payload: seal(payload, config, id, owner),
    p_expires_at: new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(),
  });
  if (result.error) {
    if (result.error.message?.includes('connector_busy')) throw new HttpError(409, 'A Google action is still running. Wait and check its result before reconnecting.');
    if (result.error.message?.includes('connector_action_pending')) throw new HttpError(409, 'A previous Google action may have completed. Check its result, then explicitly end this connection before reconnecting.');
    throw new HttpError(503, SETUP);
  }
  await setGoogleCookie(config, handle);
}

export async function acquireGoogleSession<T>(config: GoogleConfig, owner: string): Promise<Session<T>> {
  const id = hashHandle(await googleHandle(config));
  const lease = randomUUID();
  const { data, error } = await adminClient().rpc('claim_google_connector_session', { p_id: id, p_owner: owner, p_purpose: config.purpose, p_lease: lease });
  if (error) {
    if (error.message?.includes('connector_busy')) throw new HttpError(409, 'Another import request is still running. Try again in a moment.');
    throw new HttpError(503, SETUP);
  }
  const row = data?.[0];
  if (!row) throw new HttpError(410, 'This import expired or was cancelled. Connect Google again.');
  return { id, owner, lease, expiresAt: row.expires_at, payload: unseal<T>(row.encrypted_payload, config, id, owner) };
}

export async function saveGoogleSession<T>(config: GoogleConfig, session: Session<T>) {
  const { data, error } = await adminClient().from(TABLE).update({ encrypted_payload: seal(session.payload, config, session.id, session.owner), lease: null, locked_until: null })
    .eq('id', session.id).eq('user_id', session.owner).eq('purpose', config.purpose).eq('lease', session.lease)
    .gt('expires_at', new Date().toISOString()).select('id');
  if (error) throw new HttpError(503, 'Could not save the import preview. Please retry.');
  if (!data?.length) throw new HttpError(410, 'This import expired or was cancelled. Connect Google again.');
}
// Durable checkpoint for a bounded action intent/result while retaining the
// caller's lease. Never use this to retry an uncertain provider-side mutation.
// The absolute session expiry is not extended; an expired lease cannot revive.
export async function checkpointGoogleSession<T>(config: GoogleConfig, session: Session<T>) {
  const now = new Date().toISOString();
  const { data, error } = await adminClient().from(TABLE).update({
    encrypted_payload: seal(session.payload, config, session.id, session.owner),
    protected_action: true,
    locked_until: new Date(Math.min(Date.now() + 30_000, Date.parse(session.expiresAt))).toISOString(),
  }).eq('id', session.id).eq('user_id', session.owner).eq('purpose', config.purpose).eq('lease', session.lease)
    .gt('expires_at', now).gt('locked_until', now).select('id');
  if (error) throw new HttpError(503, 'Could not save the Google action state. No further action will be attempted.');
  if (!data?.length) throw new HttpError(410, 'This Google action expired or was cancelled.');
}
// Make an authorization response one-use before sending the code to Google.
// Preserve the lease while replacing state/verifier with a harmless marker.
export async function consumeGoogleAuthorization(config: GoogleConfig, session: Session<unknown>) {
  const { data, error } = await adminClient().from(TABLE).update({ encrypted_payload: seal({ phase: 'exchanging' }, config, session.id, session.owner) })
    .eq('id', session.id).eq('user_id', session.owner).eq('purpose', config.purpose).eq('lease', session.lease)
    .gt('expires_at', new Date().toISOString()).select('id');
  if (error || !data?.length) throw new HttpError(410, 'This connection expired or was cancelled. Connect Google again.');
}
export async function releaseGoogleSession(config: GoogleConfig, session: Session<unknown>) {
  await adminClient().from(TABLE).update({ lease: null, locked_until: null })
    .eq('id', session.id).eq('user_id', session.owner).eq('purpose', config.purpose).eq('lease', session.lease);
}
export async function deleteGoogleSession(config: GoogleConfig, owner: string) {
  const { error } = await adminClient().from(TABLE).delete().eq('user_id', owner).eq('purpose', config.purpose);
  if (error) throw new HttpError(503, 'Could not clear Google import. Please retry.');
  await clearGoogleCookie(config);
}
// A late/failed callback must not erase a newer connection started in another
// tab. Unlike explicit cancel, this only removes the exact acquired session.
export async function discardGoogleSession(config: GoogleConfig, session: Session<unknown>) {
  const { error } = await adminClient().from(TABLE).delete().eq('id', session.id).eq('user_id', session.owner).eq('purpose', config.purpose);
  if (error) throw new HttpError(503, 'Could not clear Google connection. Please cancel and retry.');
}

export function authorization(config: GoogleConfig) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
    scope: config.scope, access_type: 'online', prompt: 'consent', state,
    include_granted_scopes: 'false', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  }).toString();
  return { state, verifier, url: url.toString() };
}
export function validState(received: string | null, expected: string) {
  return !!received && /^[A-Za-z0-9_-]{43}$/.test(received) && received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// Deliberately do not log provider errors, response bodies, URLs or credentials.
// Timeout includes body consumption; redirects cannot forward Authorization.
export async function googleJson(url: string, init: RequestInit): Promise<unknown> {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !['oauth2.googleapis.com', 'people.googleapis.com', 'sheets.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com'].includes(target.hostname)) {
      throw new HttpError(400, 'Unsupported Google API destination.');
    }
    const response = await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (response.status === 429) throw new HttpError(429, 'Google is temporarily rate limiting requests. Wait a minute, then retry.');
    if (response.status === 401 || response.status === 403) throw new HttpError(403, 'Google access expired or was not granted. Cancel this import and reconnect.');
    if (!response.ok) throw new HttpError(502, 'Google could not complete the request. Please retry or reconnect.');
    return await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Google did not respond in time. Please retry.');
  }
}

export async function exchangeCode(config: GoogleConfig, code: string, verifier: string) {
  const raw = await googleJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
    code, code_verifier: verifier, grant_type: 'authorization_code',
  }) }) as Record<string, unknown>;
  if (typeof raw.access_token !== 'string' || raw.access_token.length > 8192 || !raw.access_token || raw.token_type !== 'Bearer'
    || typeof raw.scope !== 'string' || !raw.scope.split(' ').includes(config.scope)
    || typeof raw.expires_in !== 'number' || raw.expires_in <= 0) {
    throw new HttpError(403, 'The requested Google permission was not granted. Connect again if you want to continue.');
  }
  // Ignore and never retain a refresh token, even if a provider returns one.
  return { token: raw.access_token, tokenExpiresAt: Date.now() + Math.min(raw.expires_in, SESSION_SECONDS) * 1000 };
}

export function googleResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' } });
}
export function googleRoute(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    try { return await fn(req); }
    catch (error) { return googleResponse({ error: error instanceof HttpError ? error.message : 'Google import is temporarily unavailable. Please retry.' }, error instanceof HttpError ? error.status : 503); }
  };
}
