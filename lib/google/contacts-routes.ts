import 'server-only';
import { NextResponse } from 'next/server';
import { HttpError, requireUser } from '../http';
import { adminClient } from '../supabase/admin';
import {
  acquireGoogleSession, authorization, consumeGoogleAuthorization, createGoogleSession, deleteGoogleSession, discardGoogleSession, exchangeCode,
  googleConfig, googleConnectorSchemaReady, googleResponse, googleRoute, releaseGoogleSession, requireGoogleConfig,
  sameOrigin, saveGoogleSession, validState, type Session,
} from './connector';
import { contactPreview, importSelection, loadContactsPage, type ContactsSession } from './contacts';

export const status = googleRoute(async (req) => {
  const { user } = await requireUser(req);
  const config = googleConfig('contacts');
  if (!config) return googleResponse({ configured: false, ready: false });
  // Require the additive replacement guard too, not just the original table.
  if (!await googleConnectorSchemaReady()) return googleResponse({ configured: false, ready: false });
  let session;
  try { session = await acquireGoogleSession<ContactsSession>(config, user.id); }
  catch (error) { if (error instanceof HttpError && error.status === 410) return googleResponse({ configured: true, ready: false }); throw error; }
  try {
    if (session.payload.phase !== 'ready') return googleResponse({ configured: true, ready: false, pending: true });
    return googleResponse({ configured: true, expires_at: session.expiresAt, ...await contactPreview(session.payload, user.id) });
  } finally { await releaseGoogleSession(config, session); }
});

export const start = googleRoute(async (req) => {
  const { user } = await requireUser(req);
  const config = requireGoogleConfig('contacts');
  sameOrigin(req, config);
  const { data, error } = await adminClient().rpc('hit_rate_limit', { p_key: `google-contacts:${user.id}`, p_window_seconds: 600, p_max: 5 });
  if (error) throw new HttpError(503, 'Google import is temporarily unavailable. Try again later.');
  if (!data) throw new HttpError(429, 'Too many connection attempts. Wait ten minutes and try again.');
  const auth = authorization(config);
  await createGoogleSession(config, user.id, { phase: 'authorizing', state: auth.state, verifier: auth.verifier } satisfies ContactsSession);
  return googleResponse({ authorization_url: auth.url });
});

export const callback = googleRoute(async (req) => {
  const config = requireGoogleConfig('contacts');
  let result = 'expired';
  let session: Session<ContactsSession> | undefined;
  let verifiedAuthorization = false;
  try {
    const { user } = await requireUser(req);
    session = await acquireGoogleSession<ContactsSession>(config, user.id);
    const params = new URL(req.url).searchParams;
    if (session.payload.phase !== 'authorizing' || !validState(params.get('state'), session.payload.state)) {
      await releaseGoogleSession(config, session);
      throw new HttpError(400, 'Invalid authorization state');
    }
    verifiedAuthorization = true;
    // Consume state before exchanging code: callback replays must never exchange
    // it twice, including when the first provider request has an uncertain result.
    if (params.has('error')) { result = params.get('error') === 'access_denied' ? 'denied' : 'failed'; await discardGoogleSession(config, session); }
    else {
      const code = params.get('code');
      if (!code || code.length > 8192) throw new HttpError(400, 'Missing authorization code');
      const verifier = session.payload.verifier;
      session.payload = { phase: 'ready', token: null, tokenExpiresAt: 0, contacts: [], pages: 0, nextPageToken: null, seenPages: [], skipped: 0, truncated: false };
      // Keep a durable consumed state, with the lease still held, until exchange.
      await consumeGoogleAuthorization(config, session);
      Object.assign(session.payload, await exchangeCode(config, code, verifier));
      await saveGoogleSession(config, session);
      result = 'ready';
    }
  } catch (error) {
    if (session && verifiedAuthorization) await discardGoogleSession(config, session).catch(() => {});
    if (error instanceof HttpError && error.status === 403) result = 'denied';
  }
  // Fixed, configured return path: no code/state/token or provider error text
  // is copied into a page, redirect, analytic event, or log.
  return NextResponse.redirect(`${config.origin}/organizer/?google_import=${result}#/google-contacts`, { status: 303, headers: { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' } });
});

export const preview = googleRoute(async (req) => {
  const { user } = await requireUser(req);
  const config = requireGoogleConfig('contacts');
  sameOrigin(req, config);
  const session = await acquireGoogleSession<ContactsSession>(config, user.id);
  try {
    if (session.payload.phase !== 'ready') throw new HttpError(409, 'Finish Google authorization before previewing.');
    await loadContactsPage(session.payload);
    const result = await contactPreview(session.payload, user.id);
    await saveGoogleSession(config, session);
    return googleResponse(result);
  } finally { await releaseGoogleSession(config, session); }
});

export const save = googleRoute(async (req) => {
  const { user } = await requireUser(req);
  const config = requireGoogleConfig('contacts');
  sameOrigin(req, config);
  let raw;
  try { raw = await req.json(); } catch { throw new HttpError(400, 'Invalid import selection.'); }
  const session = await acquireGoogleSession<ContactsSession>(config, user.id);
  try { return googleResponse(await importSelection(config, session, raw)); }
  finally { await releaseGoogleSession(config, session); }
});

export const cancel = googleRoute(async (req) => {
  const { user } = await requireUser(req);
  const config = requireGoogleConfig('contacts');
  sameOrigin(req, config);
  await deleteGoogleSession(config, user.id);
  return googleResponse({ disconnected: true });
});
