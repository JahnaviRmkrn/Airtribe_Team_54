// Local smoke test: boots the bridge on a random loopback port with throwaway
// secrets and a temp session dir, asks it to start a link for a random user id,
// and waits for a QR string from WhatsApp's servers. It never scans or links
// anything, never prints the QR, and deletes everything it created.
//   pnpm --filter muop-whatsapp-bridge smoke
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/index.mjs';

const secret = randomBytes(32).toString('hex');
const root = await mkdtemp(join(tmpdir(), 'muop-wa-smoke-'));
const port = 3000 + Math.floor(Math.random() * 5000) + 11;
const uid = randomUUID();
const call = (path, init = {}, withSecret = true) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(withSecret ? { 'x-wa-bridge-secret': secret } : {}) } });

let failed = false;
const { manager, server } = await main({ WA_BRIDGE_SECRET: secret, WA_SESSION_KEY: randomBytes(32).toString('hex'), WA_SESSION_DIR: root, WA_BRIDGE_PORT: String(port) });
try {
  console.log('no secret ->', (await call('/health', {}, false)).status, '(expect 401)');
  console.log('health    ->', (await call('/health')).status, '(expect 200)');
  console.log('start     ->', (await call(`/sessions/${uid}/start`, { method: 'POST', body: '{}' })).status);
  let qr = null;
  for (let i = 0; i < 40 && !qr; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await (await call(`/sessions/${uid}/status`)).json();
    if (i % 5 === 0) console.log('state     ->', st.state);
    if (st.state === 'waiting_qr' && st.qr) qr = st.qr;
  }
  if (qr) console.log(`got a QR string (${qr.length} chars, not printed). Bridge works.`);
  else {
    failed = true;
    console.error('no QR within 40s (is web.whatsapp.com reachable from this machine?)');
  }
} finally {
  await call(`/sessions/${uid}`, { method: 'DELETE' }).catch(() => {});
  server.close();
  await manager.shutdown();
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
