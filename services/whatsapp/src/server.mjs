// Loopback HTTP API used only by the Next.js server. Every route requires the
// shared secret header; the listener itself is bound to 127.0.0.1.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError } from './session.mjs';
import { UID_RE } from './store.mjs';

const MAX_BODY = 16 * 1024;

function secretOk(header, secret) {
  const a = Buffer.from(String(header ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BridgeError(413, 'too_large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw new BridgeError(400, 'bad_json');
  }
}

/** Builds the request handler. Exported separately so tests can call it without a socket. */
export function createHandler({ manager, secret }) {
  return async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!secretOk(req.headers['x-wa-bridge-secret'], secret)) throw new BridgeError(401, 'unauthorized');
      const url = new URL(req.url ?? '/', 'http://bridge.local');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      const m = url.pathname.match(/^\/sessions\/([^/]+)(?:\/([a-z]+))?$/);
      if (!m || !UID_RE.test(m[1])) throw new BridgeError(404, 'not_found');
      const [, uid, action] = m;

      if (!action && req.method === 'DELETE') {
        await manager.unlink(uid);
        return send(200, { ok: true });
      }
      if (action === 'status' && req.method === 'GET') return send(200, manager.status(uid));
      if (action === 'start' && req.method === 'POST') {
        const body = await readJson(req);
        const phone = typeof body.phone === 'string' && /^[0-9]{8,15}$/.test(body.phone) ? body.phone : undefined;
        return send(200, await manager.start(uid, { phone }));
      }
      if (action === 'contacts' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return send(200, manager.contacts(uid, { q: q.slice(0, 80), limit, offset }));
      }
      if (action === 'lookup' && req.method === 'POST') {
        const body = await readJson(req);
        const jids = Array.isArray(body.jids) ? body.jids.filter((j) => typeof j === 'string').slice(0, 200) : [];
        return send(200, { contacts: manager.lookup(uid, jids) });
      }
      if (action === 'groups' && req.method === 'GET') return send(200, { groups: manager.groups(uid) });
      if (action === 'send' && req.method === 'POST') {
        const body = await readJson(req);
        return send(200, await manager.send(uid, body.jid, body.text, { viaContact: body.via_contact === true }));
      }
      throw new BridgeError(404, 'not_found');
    } catch (e) {
      if (e instanceof BridgeError) return send(e.status, { error: e.code });
      console.error('bridge handler error', e?.name);
      return send(500, { error: 'internal' });
    }
  };
}

export function startServer({ manager, secret, port, host = '127.0.0.1' }) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('The bridge must only listen on loopback');
  const server = createServer(createHandler({ manager, secret }));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
