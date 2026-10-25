// muop WhatsApp bridge entry point. Env:
//   WA_BRIDGE_SECRET  shared secret the Next server sends in x-wa-bridge-secret (>= 32 chars)
//   WA_SESSION_KEY    32-byte key (64 hex or base64) that seals sessions at rest
//   WA_SESSION_DIR    where sessions live (outside the repo), default ~/.local/state/muop-whatsapp
//   WA_BRIDGE_PORT    default 3010 (always bound to 127.0.0.1)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { parseKey } from '../../../lib/secretbox.mjs';
import { createSocket } from './socket.mjs';
import { SessionManager } from './session.mjs';
import { startServer } from './server.mjs';

export function loadConfig(env = process.env) {
  const secret = env.WA_BRIDGE_SECRET ?? '';
  if (secret.length < 32) throw new Error('WA_BRIDGE_SECRET must be at least 32 characters (generate: openssl rand -hex 32)');
  const port = Number(env.WA_BRIDGE_PORT ?? 3010);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WA_BRIDGE_PORT must be a port number');
  return {
    secret,
    key: parseKey(env.WA_SESSION_KEY),
    port,
    root: env.WA_SESSION_DIR || join(homedir(), '.local', 'state', 'muop-whatsapp'),
  };
}

export async function main(env = process.env) {
  const cfg = loadConfig(env);
  await mkdir(cfg.root, { recursive: true, mode: 0o700 });
  const log = (...a) => console.log('[wa-bridge]', ...a);
  const manager = new SessionManager({ root: cfg.root, key: cfg.key, makeSocket: createSocket, log });
  const server = await startServer({ manager, secret: cfg.secret, port: cfg.port });
  log('listening on 127.0.0.1:' + cfg.port);
  await manager.restoreAll();
  const stop = async () => {
    server.close();
    await manager.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return { manager, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[wa-bridge] fatal:', e.message);
    process.exit(1);
  });
}
