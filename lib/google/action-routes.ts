import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError, requireUser } from '../http';
import { acquireGoogleSession, authorization, consumeGoogleAuthorization, createGoogleSession, deleteGoogleSession, discardGoogleSession,
  exchangeCode, googleAccessToken, googleConfig, googleConnectorSchemaReady, GOOGLE_SETUP_UNVERIFIED, googleResponse, googleRoute, releaseGoogleSession, sameOrigin, saveGoogleSession, validState,
  type GoogleConfig, type Session } from './connector';
import { preparePreview, type ActionPurpose } from './action-content';
import { actionView, cancelAction, claimAction, contentForAction, finishAction, loadAction, recentActions, storePreview } from './action-store';
import { performGoogleAction, reconcileCalendarAction } from './action-provider';

type AuthorizationPayload = { phase: 'authorizing'; state: string; verifier: string };
type ReadyPayload = { phase: 'ready'; token: string; tokenExpiresAt: number };
type Payload = AuthorizationPayload | ReadyPayload;
const operationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('start') }).strict(),
  z.object({ operation: z.literal('disconnect') }).strict(),
  z.object({ operation: z.literal('preview'), draft: z.unknown() }).strict(),
  z.object({ operation: z.literal('confirm'), id: z.uuid(), previewHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true), senderAcknowledged: z.literal(true).optional() }).strict(),
  z.object({ operation: z.literal('cancel'), id: z.uuid() }).strict(),
  z.object({ operation: z.literal('reconcile'), id: z.uuid() }).strict(),
]);
async function parseOperation(req: Request) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use a JSON action request.');
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, 'An action request is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 100000) { await reader.cancel(); throw new HttpError(413, 'This draft is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON action.'); }
  const parsed = operationSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'Invalid action request. Review the draft and use its confirmation button.');
  return parsed.data;
}
const enabledConfig = (purpose: ActionPurpose) => process.env[`GOOGLE_${purpose.toUpperCase()}_ENABLED`] === 'true' ? googleConfig(purpose) : null;
const setupText = 'This feature is not enabled yet. An administrator must approve Google setup before you can connect an account. Nothing has been sent or created.';
const configRequired = (purpose: ActionPurpose) => { const c = enabledConfig(purpose); if (!c) throw new HttpError(503, setupText); return c; };
const readySession = async (config: GoogleConfig, owner: string) => {
  const session = await acquireGoogleSession<Payload>(config, owner);
  if (session.payload.phase !== 'ready') { await releaseGoogleSession(config, session); throw new HttpError(409, 'Finish connecting Google before reviewing this action.'); }
  return session as Session<ReadyPayload>;
};
const release = async (config: GoogleConfig, session: Session<unknown>) => { try { await releaseGoogleSession(config, session); } catch { /* no credentials or provider data are logged */ } };

export function actionRoutes(purpose: ActionPurpose) {
  const GET = googleRoute(async (req) => {
    const { user } = await requireUser(req); const config = enabledConfig(purpose);
    if (!config) return googleResponse({ enabled: false, connected: false, message: setupText, actions: [] });
    if (!await googleConnectorSchemaReady(purpose)) return googleResponse({ enabled: false, connected: false, message: GOOGLE_SETUP_UNVERIFIED, actions: [] });
    const id = new URL(req.url).searchParams.get('id');
    if (id) { if (!z.uuid().safeParse(id).success) throw new HttpError(400, 'Invalid action ID.'); return googleResponse({ action: actionView(config, await loadAction(config, user.id, id)) }); }
    let connected = false;
    try {
      const session = await acquireGoogleSession<Payload>(config, user.id);
      try { if (session.payload.phase === 'ready') { googleAccessToken(session as Session<ReadyPayload>); connected = true; } }
      finally { await release(config, session); }
    } catch (error) { if (!(error instanceof HttpError) || ![409, 410].includes(error.status)) throw error; }
    return googleResponse({ enabled: true, connected, actions: (await recentActions(config, user.id)).map((row) => actionView(config, row)) });
  });
  const POST = googleRoute(async (req) => {
    const { user } = await requireUser(req); const config = configRequired(purpose); sameOrigin(req, config);
    if (!await googleConnectorSchemaReady(purpose)) throw new HttpError(503, GOOGLE_SETUP_UNVERIFIED);
    // Reject both declared and actual oversized bodies, including chunked input.
    if (Number(req.headers.get('content-length') || 0) > 100000) throw new HttpError(413, 'This draft is too large.');
    const body = await parseOperation(req);
    if (body.operation === 'start') {
      const auth = authorization(config);
      const consent = new URL(auth.url);
      consent.searchParams.set('prompt', 'select_account consent');
      await createGoogleSession(config, user.id, { phase: 'authorizing', state: auth.state, verifier: auth.verifier });
      return googleResponse({ authorizationUrl: consent.toString() });
    }
    if (body.operation === 'disconnect') {
      await deleteGoogleSession(config, user.id);
      return googleResponse({ disconnected: true, message: 'This app’s temporary connection was removed. Existing action history is unchanged. Manage the Google grant separately in your Google account.' });
    }
    if (body.operation === 'cancel') return googleResponse({ action: actionView(config, await cancelAction(config, user.id, body.id)) });
    const session = await readySession(config, user.id);
    try {
      const token = googleAccessToken(session);
      if (body.operation === 'preview') return googleResponse({ action: actionView(config, await storePreview(config, session, preparePreview(purpose, body.draft))) });
      if (body.operation === 'reconcile') {
        if (purpose !== 'calendar') throw new HttpError(400, 'Gmail send-only permission cannot check your Sent mailbox. Check Gmail yourself; do not resend automatically.');
        const row = await loadAction(config, user.id, body.id);
        if (!['claimed', 'uncertain'].includes(row.state)) return googleResponse({ action: actionView(config, row) });
        const outcome = await reconcileCalendarAction(row.id, row.preview_hash, token);
        if (outcome.state === 'completed') await finishAction(config, user.id, row.id, outcome);
        return googleResponse({ action: actionView(config, await loadAction(config, user.id, row.id)), checked: true });
      }
      // Confirmation accepts only the ID + digest shown in the preview, never
      // recipients, message text or mutable event details from the browser.
      if (purpose === 'gmail' && body.senderAcknowledged !== true) throw new HttpError(400, 'Confirm that the previewed primary sender address is the Google mailbox you selected.');
      const existing = await loadAction(config, user.id, body.id);
      if (existing.preview_hash !== body.previewHash) throw new HttpError(409, 'This confirmation does not match the saved preview. Review the draft again.');
      if (existing.state !== 'preview') return googleResponse({ action: actionView(config, existing) });
      if (existing.session_id !== session.id) throw new HttpError(409, 'The Google connection changed. Create a fresh preview for the selected account.');
      contentForAction(config, existing); // verify integrity before claiming
      const claimed = await claimAction(config, session, body.id, body.previewHash);
      if (!claimed) return googleResponse({ action: actionView(config, await loadAction(config, user.id, body.id)) });
      const preview = contentForAction(config, claimed);
      const outcome = await performGoogleAction(preview, claimed.id, claimed.preview_hash, token, claimed.created_at);
      try {
        await finishAction(config, user.id, claimed.id, outcome);
        return googleResponse({ action: actionView(config, { ...claimed, state: outcome.state, provider_ref: outcome.providerRef || null }) });
      } catch {
        // The one-time claim remains forever even if saving the outcome fails.
        return googleResponse({ action: { ...actionView(config, claimed), state: 'uncertain' }, message: 'The provider outcome could not be saved. Do not send or create this again. Check the status or verify in Google.' });
      }
    } finally { await release(config, session); }
  });
  const callback = googleRoute(async (req) => {
    const { user } = await requireUser(req); const config = configRequired(purpose);
    if (!await googleConnectorSchemaReady(purpose)) throw new HttpError(503, GOOGLE_SETUP_UNVERIFIED);
    let session: Session<Payload> | undefined; let verifiedAuthorization = false;
    try {
      session = await acquireGoogleSession<Payload>(config, user.id);
      const url = new URL(req.url);
      if (session.payload.phase !== 'authorizing' || !validState(url.searchParams.get('state'), session.payload.state)) throw new HttpError(400, 'This Google response does not match the connection you started.');
      verifiedAuthorization = true;
      if (url.searchParams.has('error')) throw new HttpError(400, 'Google connection was not approved.');
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) throw new HttpError(400, 'Google did not provide a valid authorization response.');
      const verifier = session.payload.verifier;
      await consumeGoogleAuthorization(config, session);
      const tokens = await exchangeCode(config, code, verifier);
      session.payload = { phase: 'ready', ...tokens };
      await saveGoogleSession(config, session);
    } catch {
      if (session && verifiedAuthorization) { try { await discardGoogleSession(config, session); } catch { /* fail closed */ } }
    } finally { if (session) await release(config, session); }
    return NextResponse.redirect(`${config.origin}/organizer/#/${purpose}`, { status: 303, headers: { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' } });
  });
  return { GET, POST, callback };
}
