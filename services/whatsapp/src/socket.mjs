// The only module that talks to Baileys' socket constructor.
import makeWASocket, { Browsers, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pino from 'pino';

// Baileys' logger can include JIDs and push names. Keep it off; the bridge
// logs ids, states and close codes itself.
const logger = pino({ level: 'silent' });

let version;
async function waVersion() {
  if (version) return version;
  try {
    const r = await Promise.race([fetchLatestBaileysVersion(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    if (r?.version) version = r.version;
  } catch {
    // fall back to the version bundled with Baileys
  }
  return version;
}

/** makeSocket(auth) for SessionManager. `auth` comes from UserStore.authState(). */
export async function createSocket(auth) {
  return makeWASocket({
    version: await waVersion(),
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
    logger,
    // Desktop identity: WhatsApp pushes the contact app-state to companion devices.
    browser: Browsers.macOS('Desktop'),
    // syncFullHistory:true makes WhatsApp drop the pairing handshake (verified
    // against 6.7.24), so contacts come from the app-state sync + recent history.
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    printQRInTerminal: false,
    getMessage: async () => undefined,
  });
}
