import assert from 'node:assert/strict';
import { hashHandle, googleConfig, unseal } from '../../lib/google/connector';
import { calendarBody, calendarEventId, gmailRaw } from '../../lib/google/action-content';

export const purposes = ['contacts', 'sheets-import', 'sheets-export', 'gmail', 'calendar'];
export const bookId = 'synthetic_spreadsheet_00000001';
export const exportId = 'synthetic_export_000000000001';
export const drafts = {
  gmail: { from: 'sender@example.test', to: ['recipient@example.test'], subject: 'Synthetic review', body: 'Exact synthetic body' },
  calendar: { title: 'Synthetic review', description: 'Exact synthetic details', location: 'Synthetic room', localStart: '2026-11-02T12:00', timeZone: 'UTC', durationMinutes: 30, attendees: ['recipient@example.test'], sendUpdates: 'none' },
};
const sheets = 'https://sheets.googleapis.com/v4/spreadsheets';
const events = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const metadataUrl = `${sheets}/${bookId}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title))`;
const valuesUrl = `${sheets}/${bookId}/values/${encodeURIComponent("'People'!A1:Z101")}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
const peopleUrl = 'https://people.googleapis.com/v1/people/me/connections?personFields=names%2CemailAddresses&sources=READ_SOURCE_TYPE_CONTACT&pageSize=100&sortOrder=FIRST_NAME_ASCENDING';
const syntheticToken = 'synthetic-access-token';

// No transport implementation is imported. Each actual HTTP request gets an
// ordered, finite plan derived from its existing encrypted local session/preview.
// A provider write independently checks the durable SQL claim/checkpoint before
// returning its synthetic receipt. Inputs never choose an upstream destination.
export function providerFixture(db, state, context) {
  const remoteEvents = new Map(), remoteExports = new Map();
  const queryOne = async (sql, args) => (await db.query(sql, args)).rows[0]?.value;
  async function session(ctx, purpose) {
    if (!ctx.owner || !purposes.includes(purpose)) return null;
    const handle = ctx.values.get(`moup_google_${purpose}`);
    if (!handle || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return null;
    const row = await queryOne('select to_jsonb(s) as value from google_connector_sessions s where id=$1 and user_id=$2 and purpose=$3', [hashHandle(handle), ctx.owner, purpose]);
    if (!row) return null;
    return { ...row, payload: unseal(row.encrypted_payload, googleConfig(purpose), row.id, ctx.owner) };
  }
  async function action(ctx, purpose, id) {
    if (!ctx.owner || !['gmail', 'calendar'].includes(purpose) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
    return queryOne('select to_jsonb(a) as value from google_confirmed_actions a where id=$1 and user_id=$2 and purpose=$3', [id, ctx.owner, purpose]);
  }
  const fault = target => {
    if (state.fault !== target) return false;
    state.fault = null; state.faultsConsumed++;
    return true;
  };
  async function plan(ctx, route, body) {
    const [purpose, operation = ''] = route.split('/');
    const s = await session(ctx, purpose), payload = s?.payload;
    const steps = [];
    const add = (label, method, url, response, inspect, target) => steps.push({ label, method, url, response, inspect, target });
    const ready = payload?.phase === 'ready';
    const bearer = async init => {
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${syntheticToken}`);
      const active = await session(ctx, purpose);
      assert.ok(active?.lease && active.locked_until && Date.parse(active.locked_until) > Date.now());
    };
    if (operation === 'callback' && ctx.syntheticCallback && s && ['oauth', 'authorizing'].includes(payload.phase)) {
      add('oauth-token', 'POST', 'https://oauth2.googleapis.com/token', { access_token: syntheticToken, token_type: 'Bearer', scope: googleConfig(purpose).scope, expires_in: 900 }, async init => {
        const input = new URLSearchParams(init.body);
        assert.deepEqual(Object.fromEntries(input), {
          client_id: 'synthetic-client-id', client_secret: 'synthetic-client-secret', redirect_uri: googleConfig(purpose).redirectUri,
          code: 'synthetic-code', code_verifier: payload.verifier, grant_type: 'authorization_code',
        });
        // The callback must consume its one-use state before exchanging a code.
        assert.deepEqual((await session(ctx, purpose)).payload, { phase: 'exchanging' });
      });
      if (purpose === 'sheets-export') add('export-account', 'GET', 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { user: { emailAddress: 'destination@example.test' } }, bearer);
    } else if (purpose === 'contacts' && operation === 'preview' && ready && !payload.pages) {
      add('contacts-read', 'GET', peopleUrl, { connections: [
        { names: [{ displayName: 'Existing Alice' }], emailAddresses: [{ value: 'ALICE.CONTACT@example.test' }] },
        { names: [{ displayName: 'New Person' }], emailAddresses: [{ value: 'new@example.test' }] },
        { names: [{ displayName: 'Another Person' }], emailAddresses: [{ value: 'another@example.test' }] },
      ] }, bearer);
    } else if (purpose === 'sheets-import' && operation === 'source' && ready && body?.spreadsheetId === bookId) {
      add('sheet-metadata', 'GET', metadataUrl, { spreadsheetId: bookId, properties: { title: 'Synthetic contacts' }, sheets: [{ properties: { sheetId: 0, title: 'People' } }] }, bearer);
      if (body.sheetId === 0) add('sheet-values', 'GET', valuesUrl, { values: [
        ['Name', 'Email', 'Notes'], ['Existing Alice', 'alice.contact@example.test', 'skip'],
        ['Sheet Person', 'sheet@example.test', 'Explicit synthetic note'], ['Second Sheet Person', 'sheet2@example.test', '=literal synthetic text'],
      ] }, bearer);
    } else if (purpose === 'sheets-export' && operation === 'confirm' && ready && payload.exportPreview) {
      const preview = payload.exportPreview, previous = payload.exportRun;
      if (body?.checkOnly === true && previous?.spreadsheetId && previous.state !== 'complete') {
        add('export-read', 'GET', `${sheets}/${exportId}/values/${encodeURIComponent(preview.range)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`, () => ({ values: remoteExports.get(`${ctx.owner}:${exportId}`)?.values || [] }), bearer);
      } else if (body?.previewId === preview.id && previous?.previewId !== preview.id && (!previous || previous.state === 'complete')) {
        add('export-create', 'POST', sheets, { spreadsheetId: exportId }, async init => {
          await bearer(init);
          const active = await session(ctx, purpose);
          assert.equal(active.protected_action, true); assert.equal(active.payload.exportRun.state, 'creating');
          assert.deepEqual(JSON.parse(init.body), { properties: { title: preview.title }, sheets: [{ properties: { title: 'Contacts', gridProperties: { rowCount: 101, columnCount: 5 } } }] });
          remoteExports.set(`${ctx.owner}:${exportId}`, { values: [] });
        }, 'sheets-create');
        add('export-write', 'PUT', `${sheets}/${exportId}/values/${encodeURIComponent(preview.range)}?valueInputOption=RAW`, {
          spreadsheetId: exportId, updatedRange: preview.range, updatedRows: preview.values.length,
          updatedColumns: preview.fields.length, updatedCells: preview.values.length * preview.fields.length,
        }, async init => {
          await bearer(init);
          const active = await session(ctx, purpose);
          assert.equal(active.protected_action, true); assert.equal(active.payload.exportRun.state, 'writing');
          assert.equal(active.payload.exportRun.spreadsheetId, exportId);
          assert.deepEqual(JSON.parse(init.body), { range: preview.range, majorDimension: 'ROWS', values: preview.values });
          remoteExports.set(`${ctx.owner}:${exportId}`, { values: structuredClone(preview.values) });
        }, 'sheets-write');
      }
    } else if (['gmail', 'calendar'].includes(purpose) && !operation && ready) {
      const row = await action(ctx, purpose, body?.id);
      if (row && body.operation === 'confirm' && row.state === 'preview' && row.preview_hash === body.previewHash && row.session_id === s.id) {
        const preview = unseal(row.encrypted_preview, googleConfig(purpose), row.id, ctx.owner);
        const gmail = purpose === 'gmail';
        add(gmail ? 'gmail-send' : 'calendar-insert', 'POST', gmail ? 'https://gmail.googleapis.com/gmail/v1/users/sender%40example.test/messages/send' : `${events}?sendUpdates=${preview.sendUpdates}`, { id: gmail ? 'synthetic_message_0001' : calendarEventId(row.id) }, async init => {
          await bearer(init);
          const current = await action(ctx, purpose, row.id);
          assert.equal(current.state, 'claimed'); assert.equal(current.preview_hash, row.preview_hash);
          if (gmail) {
            assert.equal(preview.from, 'sender@example.test');
            assert.deepEqual(preview.to, ['recipient@example.test']);
            assert.deepEqual(JSON.parse(init.body), { raw: gmailRaw(preview, new Date(row.created_at)) });
          } else {
            assert.ok(preview.attendees.every(email => email === 'recipient@example.test'));
            const expected = calendarBody(preview, row.id, row.preview_hash);
            assert.deepEqual(JSON.parse(init.body), expected);
            remoteEvents.set(`${ctx.owner}:${row.id}`, expected);
          }
        }, purpose);
      } else if (purpose === 'calendar' && body?.operation === 'reconcile' && row && ['claimed', 'uncertain'].includes(row.state)) {
        add('calendar-read', 'GET', `${events}/${calendarEventId(row.id)}`, () => remoteEvents.get(`${ctx.owner}:${row.id}`) || {}, bearer);
      }
    }
    return steps;
  }
  async function send(url, init = {}) {
    const ctx = context(), expected = ctx?.steps.shift();
    if (!expected || String(url) !== expected.url || (init.method || 'GET') !== expected.method) {
      state.blocked++; throw new Error('Unmatched provider transport forbidden');
    }
    try {
      assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      await expected.inspect?.(init);
    } catch {
      state.blocked++; throw new Error('Provider request or durable SQL checkpoint mismatch');
    }
    state.calls.push(expected.label);
    if (state.calls.length > 2000) { state.blocked++; throw new Error('Provider fixture request limit exceeded'); }
    if (expected.target && fault(expected.target)) {
      ctx.steps = []; // A lost create response must prevent the later values PUT.
      throw new Error('Synthetic provider response lost after one recorded write');
    }
    return new Response(JSON.stringify(typeof expected.response === 'function' ? expected.response() : expected.response), { status: 200 });
  }
  return { plan, send, session, reset() { remoteEvents.clear(); remoteExports.clear(); } };
}
