// Test-only GoTrue-shaped HTTP fixture. No database, upstream fetch, JWT,
// provider, email, service key, or production authentication implementation.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const APP_ORIGIN = 'http://127.0.0.1:4320';
export const AUTH_PORT = 4318;
export const FIXTURE_KEY = 'synthetic-auth-fixture-anon-key';
export const PASSWORD = 'fixture-password-123';
export const NEW_PASSWORD = 'fixture-new-password-123';
const emails = ['alice@auth-fixture.test', 'bob@auth-fixture.test', 'new-user@auth-fixture.test'];
const allowedHeaders = ['apikey', 'authorization', 'content-type', 'x-client-info', 'x-supabase-api-version'];
const methods = new Map([
  ['/auth/v1/settings', ['GET']], ['/auth/v1/token', ['POST']],
  ['/auth/v1/signup', ['POST']], ['/auth/v1/otp', ['POST']], ['/auth/v1/recover', ['POST']],
  ['/auth/v1/user', ['GET', 'PUT']], ['/auth/v1/logout', ['POST']], ['/auth/v1/authorize', ['GET']],
  ['/__fixture/', ['GET']], ['/__fixture/state', ['GET']],
  ['/__fixture/reset', ['POST']], ['/__fixture/expire', ['POST']],
]);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const challenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

export function createAuthFixture({ port = AUTH_PORT } = {}) {
  if (port !== AUTH_PORT && port !== 0) throw new Error('Only the fixed fixture port or an ephemeral smoke-test port is allowed.');
  let origin;
  const accounts = new Map(), sessions = new Map(), flows = new Map(), requests = [];
  const reset = () => {
    accounts.clear(); sessions.clear(); flows.clear(); requests.length = 0;
    emails.forEach((email, index) => accounts.set(email, {
      user: { id: `00000000-0000-4000-8000-00000000000${index + 1}`, email,
        created_at: '2020-01-01T00:00:00.000Z', app_metadata: {}, user_metadata: {},
        identities: [{ id: `fixture-identity-${index + 1}`, provider: 'email' }] },
      password: PASSWORD, confirmed: index < 2, exists: index < 2,
    }));
  };
  reset();
  const snapshot = () => ({
    warning: 'Synthetic local fixture only. No real authentication or email delivery.',
    requests: [...requests],
    flows: [...flows.values()].map(({ code, kind, email, callback, expires, used }) => ({
      code, kind, email, callback, state: used ? 'used' : expires <= Date.now() ? 'expired' : 'pending',
    })),
  });
  const accountFor = (email) => {
    const account = accounts.get(email);
    if (!account) throw failure('Use only the documented synthetic fixture accounts.');
    return account;
  };
  const callbackFor = (raw) => {
    let target;
    try { target = new URL(raw); } catch { throw failure('A fixture callback URL is required.'); }
    if (target.origin !== APP_ORIGIN || target.pathname !== '/auth/callback' || target.username || target.password || target.hash) {
      throw failure('Only the fixed loopback app auth callback is allowed.');
    }
    if ([...target.searchParams.keys()].some((key) => !['next', 'sb_flow_id'].includes(key))) throw failure('Unsupported callback query.');
    return target;
  };
  const makeFlow = (kind, email, data, redirect) => {
    const callback = callbackFor(redirect);
    if (data.code_challenge_method !== 's256' || typeof data.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.code_challenge)) {
      throw failure('A synthetic PKCE S256 challenge is required.');
    }
    const code = 'fixture-code-' + randomUUID();
    callback.searchParams.set('code', code);
    const flow = { code, kind, email, challenge: data.code_challenge, callback: callback.href, expires: Date.now() + 600_000, used: false };
    flows.set(code, flow);
    return flow;
  };
  const sessionFor = (account) => {
    // Deliberately opaque strings, not JWTs or signed claims. Only this in-memory
    // map recognizes them; they grant no access anywhere outside this fixture.
    const access_token = 'fixture-access-' + randomUUID();
    const response = { access_token, refresh_token: 'fixture-refresh-' + randomUUID(), token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: account.user };
    sessions.set(access_token, { email: account.user.email, expires: response.expires_at * 1000 });
    return response;
  };
  const signedIn = (req) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const session = sessions.get(token);
    if (!session || session.expires <= Date.now()) throw failure('Synthetic session missing or expired.', 401);
    return { account: accountFor(session.email), token };
  };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw failure('JSON required.', 415);
    let content = '';
    for await (const chunk of req) {
      content += chunk;
      if (Buffer.byteLength(content) > 8192) throw failure('Fixture request too large.', 413);
    }
    let value;
    try { value = JSON.parse(content); } catch { throw failure('Invalid JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('JSON object required.');
    return value;
  }
  const server = createServer(async (req, res) => {
    const send = (status, value) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    };
    const redirect = (target) => { res.writeHead(303, { Location: target }); res.end(); };
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) throw failure('Loopback fixture host required.', 403);
      const requestOrigin = req.headers.origin;
      if (requestOrigin && requestOrigin !== APP_ORIGIN && requestOrigin !== origin) throw failure('Origin not allowed.', 403);
      if (requestOrigin) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
        res.setHeader('Vary', 'Origin');
      }
      const url = new URL(req.url, origin);
      if (url.origin !== origin || url.username || url.password) throw failure('Request target not allowed.', 403);
      const allowedMethods = methods.get(url.pathname);
      if (!allowedMethods) throw failure('Endpoint disabled in this synthetic auth-only fixture.', 404);
      if (req.method === 'OPTIONS') {
        const method = req.headers['access-control-request-method'];
        const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
        if (!requestOrigin || !allowedMethods.includes(method) || headers.some((h) => !allowedHeaders.includes(h))) throw failure('Preflight not allowed.', 403);
        res.writeHead(204, { 'Access-Control-Allow-Methods': allowedMethods.join(', '), 'Access-Control-Allow-Headers': allowedHeaders.join(', ') });
        return res.end();
      }
      if (!allowedMethods.includes(req.method)) throw failure('Method not allowed.', 405);
      if (url.pathname.startsWith('/__fixture/')) {
        if (url.search) throw failure('Control query not allowed.');
        if (req.method === 'POST') {
          if (requestOrigin !== origin) throw failure('Use the fixture control page for mutations.', 403);
          if (url.pathname === '/__fixture/reset') reset();
          else for (const flow of flows.values()) flow.expires = 0;
          return redirect(origin + '/__fixture/');
        }
        if (url.pathname === '/__fixture/state') return send(200, snapshot());
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        return res.end(`<!doctype html><meta charset="utf-8"><title>Synthetic auth fixture</title><style>body{max-width:850px;margin:3rem auto;font:17px system-ui;padding:1rem}li{margin:1rem 0}button{padding:.6rem}</style><h1>Synthetic auth fixture</h1><p>No real authentication, email, provider, database, or JWT verification. Use synthetic data only.</p><p>App: <a href="${APP_ORIGIN}/login">${APP_ORIGIN}/login</a>. Reload this page after requesting a link.</p><form method="post" action="/__fixture/expire"><button>Expire pending links</button></form><form method="post" action="/__fixture/reset"><button>Reset all synthetic users and sessions</button></form><ul>${snapshot().flows.map((flow) => `<li>${escape(flow.kind)} for ${escape(flow.email)} (${flow.state}): <a href="${escape(flow.callback)}">Open synthetic callback</a></li>`).join('')}</ul><p>Recorded request kinds: ${escape(requests.join(', '))}</p>`);
      }
      const keys = [...url.searchParams.keys()];
      const allowedQuery = {
        '/auth/v1/token': ['grant_type'], '/auth/v1/signup': ['redirect_to'], '/auth/v1/otp': ['redirect_to'],
        '/auth/v1/recover': ['redirect_to'], '/auth/v1/logout': ['scope'],
        '/auth/v1/authorize': ['provider', 'redirect_to', 'code_challenge', 'code_challenge_method'],
      }[url.pathname] || [];
      if (new Set(keys).size !== keys.length || keys.some((key) => !allowedQuery.includes(key))) throw failure('Query not allowed.');
      if (url.pathname === '/auth/v1/authorize') {
        if (url.searchParams.get('provider') !== 'google') throw failure('Provider disabled.');
        const target = callbackFor(url.searchParams.get('redirect_to'));
        target.searchParams.set('error', 'access_denied');
        target.searchParams.set('error_description', 'Synthetic fixture does not authenticate with providers.');
        requests.push('oauth-denied');
        return redirect(target.href);
      }
      if (req.headers.apikey !== FIXTURE_KEY) throw failure('Synthetic fixture API key required.', 401);
      if (url.pathname === '/auth/v1/settings') return send(200, { external: { google: true, facebook: false, linkedin_oidc: false, 'custom:instagram': false }, disable_signup: false });
      if (url.pathname === '/auth/v1/user') {
        const { account } = signedIn(req);
        if (req.method === 'PUT') {
          const data = await body(req);
          if (Object.keys(data).some((key) => !['password', 'data', 'code_challenge', 'code_challenge_method'].includes(key)) || data.password !== NEW_PASSWORD) throw failure('Use the documented synthetic new password only.');
          account.password = data.password;
          requests.push('password-updated:' + account.user.email);
        }
        return send(200, account.user);
      }
      if (url.pathname === '/auth/v1/logout') {
        const { account, token } = signedIn(req);
        const scope = url.searchParams.get('scope') || 'global';
        if (!['global', 'local'].includes(scope)) throw failure('Logout scope disabled.');
        for (const [key, session] of sessions) if (scope === 'global' ? session.email === account.user.email : key === token) sessions.delete(key);
        requests.push('logout');
        return send(200, {});
      }
      const data = await body(req);
      if (url.pathname === '/auth/v1/token') {
        const grant = url.searchParams.get('grant_type');
        if (grant === 'password') {
          const account = accountFor(data.email);
          if (!account.exists || !account.confirmed || data.password !== account.password) throw failure('Invalid synthetic credentials.', 400);
          requests.push('password-signin');
          return send(200, sessionFor(account));
        }
        if (grant !== 'pkce') throw failure('Refresh and other grants are intentionally disabled.');
        const flow = flows.get(data.auth_code);
        if (!flow || flow.used || flow.expires <= Date.now()) throw failure('Synthetic link is invalid or expired.');
        if (typeof data.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(data.code_verifier) || challenge(data.code_verifier) !== flow.challenge) throw failure('Synthetic PKCE verifier mismatch.');
        flow.used = true;
        const account = accountFor(flow.email);
        account.confirmed = true;
        requests.push('pkce-exchanged:' + flow.kind);
        return send(200, sessionFor(account));
      }
      const account = accountFor(data.email);
      if (url.pathname === '/auth/v1/signup') {
        if (data.password !== PASSWORD) throw failure('Use the documented synthetic signup password only.');
        makeFlow('signup', data.email, data, url.searchParams.get('redirect_to'));
        account.exists = true;
        account.user.created_at = new Date().toISOString();
        requests.push('signup');
        return send(200, account.user);
      }
      if (url.pathname === '/auth/v1/otp') {
        if (!account.exists && data.create_user === false) throw failure('Synthetic account does not exist. Choose Create account.');
        makeFlow('magic-link', data.email, data, url.searchParams.get('redirect_to'));
        account.exists = true;
        requests.push('magic-link:' + String(data.create_user !== false));
        return send(200, {});
      }
      if (!account.exists) throw failure('Synthetic account does not exist.');
      makeFlow('recovery', data.email, data, url.searchParams.get('redirect_to'));
      requests.push('recovery');
      return send(200, {});
    } catch (error) {
      return send(error.status || 500, { code: 'synthetic_fixture_error', msg: error.status ? error.message : 'Synthetic fixture failed closed.' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return {
    snapshot,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
