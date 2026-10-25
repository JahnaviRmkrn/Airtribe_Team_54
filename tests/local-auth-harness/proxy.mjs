// Test-only response guard for the hydrated auth fixture. Never imported by app
// code. A single fixed loopback upstream, not a general-purpose forwarding proxy.
import { readdir } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';

export const PUBLIC_PORT = 4320;
export const INTERNAL_PORT = 4321;
export const AUTH_ORIGIN = 'http://127.0.0.1:4318';
export const MAX_REQUEST_BYTES = 8192;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const GUARD_CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline'", "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:",
  `connect-src 'self' ${AUTH_ORIGIN}`, "frame-src 'none'", "child-src 'none'",
  "media-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'self'",
  "base-uri 'self'", "frame-ancestors 'none'", "manifest-src 'none'",
].join('; ');
const PERMISSIONS = ['accelerometer', 'autoplay', 'camera', 'display-capture', 'fullscreen',
  'geolocation', 'gyroscope', 'hid', 'magnetometer', 'microphone', 'midi', 'payment',
  'publickey-credentials-create', 'publickey-credentials-get', 'serial', 'usb',
  'screen-wake-lock', 'web-share', 'xr-spatial-tracking'].map((name) => `${name}=()`).join(', ');
const navigation = new Map([
  ['/', ['_rsc']], ['/login', ['next', 'mode', 'error', 'error_description', 'error_code', '_rsc']],
  ['/reset-password', ['next', '_rsc']],
  ['/auth/callback', ['code', 'next', 'error', 'error_description', 'error_code', 'sb_flow_id']],
]);
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
const rejected = (status, code, category = 'blockedRequests') => Object.assign(new Error(code), { status, code, category });

// Enumerate exact built asset names, not a blanket /_next/* forwarding rule.
// Names only are read; source maps and symlinks are never exposed.
export async function builtStaticPaths(directory) {
  const paths = [];
  const walk = async (path, relative = []) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const parts = [...relative, entry.name];
      if (entry.isDirectory()) await walk(join(path, entry.name), parts);
      else if (entry.isFile() && /\.(js|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico)$/.test(entry.name)) {
        paths.push('/_next/static/' + parts.map(encodeURIComponent).join('/'));
      }
    }
  };
  await walk(directory);
  if (!paths.length) throw new Error('AUTH_PROXY_NO_BUILT_ASSETS');
  return paths;
}

function stripHop(headers) {
  const connection = headers.connection;
  const named = new Set(String(Array.isArray(connection) ? connection.join(',') : connection || '').toLowerCase().split(',').map((s) => s.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hop.has(name) && !named.has(name)));
}

async function readRequest(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw rejected(413, 'AUTH_PROXY_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createAuthProxy({ port = PUBLIC_PORT, testUpstreamPort, staticPaths = [] } = {}) {
  if (port !== PUBLIC_PORT && port !== 0) throw new Error('Only fixed public port or ephemeral test port is allowed.');
  if (testUpstreamPort !== undefined && (port !== 0 || !Number.isInteger(testUpstreamPort) || testUpstreamPort < 1 || testUpstreamPort > 65535)) {
    throw new Error('An ephemeral upstream override is only allowed in an ephemeral smoke test.');
  }
  const assets = new Set(staticPaths);
  if ([...assets].some((path) => !path.startsWith('/_next/static/') || /[?#\\]/.test(path) || path.split('/').includes('..'))) throw new Error('Invalid exact static asset allowlist.');
  const upstreamPort = testUpstreamPort ?? INTERNAL_PORT;
  const counts = { forwarded: 0, blockedRequests: 0, blockedRoutes: 0, blockedRedirects: 0, upstreamErrors: 0 };
  let origin;
  const server = createServer({ maxHeaderSize: 32 * 1024 }, async (req, res) => {
    let timer;
    const fail = (error) => {
      const category = error.category || 'upstreamErrors';
      counts[category]++;
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(error.status || 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Content-Security-Policy': GUARD_CSP, 'Permissions-Policy': PERMISSIONS,
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
        'X-Auth-Fixture-Error': error.code || 'AUTH_PROXY_UPSTREAM_ERROR' });
      res.end(JSON.stringify({ error: error.code || 'AUTH_PROXY_UPSTREAM_ERROR',
        ...(category === 'blockedRedirects' ? { acceptance_failed: true, blocked_redirects: counts.blockedRedirects } : {}) }));
    };
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) throw rejected(403, 'AUTH_PROXY_HOST_BLOCKED');
      if (req.headers.origin && req.headers.origin !== origin) throw rejected(403, 'AUTH_PROXY_ORIGIN_BLOCKED');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw rejected(403, 'AUTH_PROXY_CROSS_SITE_BLOCKED');
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('#') || req.url.length > 8192) throw rejected(400, 'AUTH_PROXY_TARGET_BLOCKED');
      const url = new URL(req.url, origin);
      if (url.pathname !== req.url.split('?')[0]) throw rejected(400, 'AUTH_PROXY_TARGET_BLOCKED');
      let allowedQuery;
      if (navigation.has(url.pathname)) {
        if (!['GET', 'HEAD'].includes(req.method)) throw rejected(405, 'AUTH_PROXY_METHOD_BLOCKED');
        allowedQuery = navigation.get(url.pathname);
      } else if (assets.has(url.pathname)) {
        if (!['GET', 'HEAD'].includes(req.method)) throw rejected(405, 'AUTH_PROXY_METHOD_BLOCKED');
        allowedQuery = ['dpl'];
      } else if (url.pathname === '/api/me/password') {
        if (req.method !== 'POST') throw rejected(405, 'AUTH_PROXY_METHOD_BLOCKED');
        if (req.headers.origin !== origin) throw rejected(403, 'AUTH_PROXY_ORIGIN_REQUIRED');
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw rejected(415, 'AUTH_PROXY_JSON_REQUIRED');
        allowedQuery = [];
      } else throw rejected(404, 'AUTH_PROXY_ROUTE_BLOCKED', 'blockedRoutes');
      const query = [...url.searchParams.keys()];
      if (new Set(query).size !== query.length || query.some((key) => !allowedQuery.includes(key))) throw rejected(400, 'AUTH_PROXY_QUERY_BLOCKED');
      const length = Number(req.headers['content-length'] || 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REQUEST_BYTES) throw rejected(413, 'AUTH_PROXY_REQUEST_TOO_LARGE');
      if (req.method !== 'POST' && (length || req.headers['transfer-encoding'])) throw rejected(400, 'AUTH_PROXY_BODY_BLOCKED');
      // Bound the whole incoming body, including a stalled/chunked sender.
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => reject(rejected(408, 'AUTH_PROXY_REQUEST_TIMEOUT')), 5000);
      });
      const body = await Promise.race([readRequest(req), timedOut]);
      clearTimeout(timer);
      const headers = stripHop(req.headers);
      for (const name of Object.keys(headers)) if (name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name];
      headers.host = new URL(origin).host; // Preserve the browser/public Host.
      // Next can reconstruct req.url from its internal port. Supply only our
      // fixed listener's trusted origin after removing every caller override.
      headers['x-forwarded-host'] = new URL(origin).host;
      headers['x-forwarded-proto'] = 'http';
      delete headers['content-length'];
      if (req.method === 'POST') headers['content-length'] = String(body.length);
      const result = await new Promise((resolve, reject) => {
        const upstream = request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url,
          method: req.method, headers, agent: false }, (incoming) => {
          const locations = incoming.headersDistinct.location || [];
          if (locations.length) {
            let target;
            try { target = new URL(locations[0], origin); } catch { /* rejected below */ }
            if (locations.length !== 1 || !target || ![origin, AUTH_ORIGIN].includes(target.origin) || target.username || target.password) {
              incoming.destroy();
              reject(rejected(502, 'AUTH_PROXY_BLOCKED_REDIRECT', 'blockedRedirects'));
              return;
            }
          }
          const parts = [];
          let size = 0;
          incoming.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              incoming.destroy(); reject(rejected(502, 'AUTH_PROXY_RESPONSE_TOO_LARGE', 'upstreamErrors'));
            } else parts.push(chunk);
          });
          incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headersDistinct, body: Buffer.concat(parts) }));
          incoming.on('error', () => reject(rejected(502, 'AUTH_PROXY_UPSTREAM_ERROR', 'upstreamErrors')));
        });
        const deadline = setTimeout(() => upstream.destroy(), 5000);
        upstream.once('close', () => clearTimeout(deadline));
        upstream.setTimeout(5000, () => upstream.destroy());
        upstream.on('error', () => reject(rejected(502, 'AUTH_PROXY_UPSTREAM_ERROR', 'upstreamErrors')));
        upstream.end(body);
      });
      counts.forwarded++;
      const outgoing = stripHop(result.headers);
      // Multiple policies are intersected by the browser. Preserve every original
      // CSP, then append ours; never replace/relax the production policy.
      outgoing['content-security-policy'] = [...(result.headers['content-security-policy'] || []), GUARD_CSP];
      outgoing['permissions-policy'] = [PERMISSIONS];
      outgoing['referrer-policy'] = ['no-referrer'];
      outgoing['x-content-type-options'] = ['nosniff'];
      outgoing['cache-control'] = ['no-store'];
      for (const [name, values] of Object.entries(outgoing)) res.setHeader(name, values);
      res.statusCode = result.status;
      res.end(req.method === 'HEAD' ? undefined : result.body);
    } catch (error) {
      clearTimeout(timer);
      fail(error);
    }
  });
  server.requestTimeout = 6000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  return {
    snapshot: () => ({ ...counts, acceptance_failed: counts.blockedRedirects > 0 }),
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
