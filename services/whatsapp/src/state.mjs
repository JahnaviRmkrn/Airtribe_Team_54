// Pure session state machine. No I/O, so it is unit-tested without Baileys.
//
//   unlinked -> connecting -> waiting_qr -> connected
//   connected -> connecting (transient drop, auto-reconnect) -> connected
//   any -> logged_out (phone removed the device: session wiped)
//   any -> error (gave up reconnecting, or the account was blocked/replaced)

// Baileys DisconnectReason values (stable WhatsApp Web close codes).
export const CLOSE = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
};

export const MAX_ATTEMPTS = 8;

export const initialState = () => ({ state: 'unlinked', qr: null, pairingCode: null, jid: null, error: null });

/** Reducer for socket events. Unknown events leave the state unchanged. */
export function reduce(s, ev) {
  switch (ev.type) {
    case 'start':
      return { ...initialState(), state: 'connecting' };
    case 'qr':
      return { ...s, state: 'waiting_qr', qr: ev.qr, error: null };
    case 'pairing_code':
      return { ...s, state: 'waiting_qr', qr: null, pairingCode: ev.code, error: null };
    case 'open':
      return { state: 'connected', qr: null, pairingCode: null, jid: ev.jid ?? s.jid, error: null };
    case 'reconnecting':
      return { ...s, state: 'connecting', qr: null, pairingCode: null };
    case 'logged_out':
      return { ...initialState(), state: 'logged_out', error: 'logged_out' };
    case 'unlink':
      return initialState();
    case 'fail':
      return { ...s, state: 'error', qr: null, pairingCode: null, error: ev.error };
    default:
      return s;
  }
}

/** Exponential backoff with jitter, capped at one minute. */
export function backoffMs(attempts, rand = Math.random) {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base / 2 + rand() * (base / 2));
}

/**
 * What to do when the socket closes.
 *  - paired:   the account was linked (creds.me exists) before this close
 *  - attempts: consecutive failed reconnects since the last successful open
 * Returns { action: 'reconnect', delayMs } | { action: 'wipe', event } | { action: 'stop', error }.
 */
export function onClose(code, { paired, attempts }, rand = Math.random) {
  if (code === CLOSE.loggedOut) return { action: 'wipe', event: 'logged_out' };
  if (!paired) {
    // Pairing finishes with a 515 restart on the SAME creds; every other close
    // before a scan means the QR timed out or the network dropped: start over.
    if (code === CLOSE.restartRequired) return { action: 'reconnect', delayMs: 0 };
    return { action: 'wipe', event: 'unlink' };
  }
  if (code === CLOSE.restartRequired) return { action: 'reconnect', delayMs: 0 };
  // Do not fight another client or retry a blocked account: needs a human.
  if (code === CLOSE.connectionReplaced) return { action: 'stop', error: 'replaced' };
  if (code === CLOSE.forbidden) return { action: 'stop', error: 'restricted' };
  if (code === CLOSE.multideviceMismatch) return { action: 'stop', error: 'multidevice_mismatch' };
  const next = attempts + 1;
  if (next > MAX_ATTEMPTS) return { action: 'stop', error: 'connection_failed' };
  return { action: 'reconnect', delayMs: backoffMs(next, rand) };
}
