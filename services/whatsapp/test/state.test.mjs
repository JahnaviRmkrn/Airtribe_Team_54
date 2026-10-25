import { describe, expect, it } from 'vitest';
import { backoffMs, CLOSE, initialState, MAX_ATTEMPTS, onClose, reduce } from '../src/state.mjs';

describe('reduce', () => {
  it('walks unlinked -> connecting -> waiting_qr -> connected', () => {
    let s = initialState();
    expect(s.state).toBe('unlinked');
    s = reduce(s, { type: 'start' });
    expect(s.state).toBe('connecting');
    s = reduce(s, { type: 'qr', qr: 'qr-1' });
    expect(s).toMatchObject({ state: 'waiting_qr', qr: 'qr-1' });
    s = reduce(s, { type: 'qr', qr: 'qr-2' });
    expect(s.qr).toBe('qr-2');
    s = reduce(s, { type: 'open', jid: '919999999999@s.whatsapp.net' });
    expect(s).toMatchObject({ state: 'connected', qr: null, jid: '919999999999@s.whatsapp.net' });
  });

  it('shows a pairing code instead of a QR', () => {
    const s = reduce(reduce(initialState(), { type: 'start' }), { type: 'pairing_code', code: 'ABCD1234' });
    expect(s).toMatchObject({ state: 'waiting_qr', qr: null, pairingCode: 'ABCD1234' });
  });

  it('keeps the linked number across a transient reconnect', () => {
    let s = reduce(initialState(), { type: 'open', jid: 'j' });
    s = reduce(s, { type: 'reconnecting' });
    expect(s).toMatchObject({ state: 'connecting', jid: 'j' });
  });

  it('logged_out and unlink clear the account', () => {
    const open = reduce(initialState(), { type: 'open', jid: 'j' });
    expect(reduce(open, { type: 'logged_out' })).toMatchObject({ state: 'logged_out', jid: null });
    expect(reduce(open, { type: 'unlink' })).toEqual(initialState());
  });

  it('fail records the reason and drops any QR', () => {
    const s = reduce(reduce(initialState(), { type: 'qr', qr: 'q' }), { type: 'fail', error: 'restricted' });
    expect(s).toMatchObject({ state: 'error', error: 'restricted', qr: null });
  });
});

describe('onClose', () => {
  const paired = { paired: true, attempts: 0 };
  it('wipes on 401 whether paired or not', () => {
    expect(onClose(CLOSE.loggedOut, paired)).toEqual({ action: 'wipe', event: 'logged_out' });
    expect(onClose(CLOSE.loggedOut, { paired: false, attempts: 0 })).toEqual({ action: 'wipe', event: 'logged_out' });
  });

  it('restarts immediately after pairing (515)', () => {
    expect(onClose(CLOSE.restartRequired, { paired: true, attempts: 0 })).toEqual({ action: 'reconnect', delayMs: 0 });
    expect(onClose(CLOSE.restartRequired, { paired: false, attempts: 0 })).toEqual({ action: 'reconnect', delayMs: 0 });
  });

  it('drops an unpaired session on any other close (QR timeout)', () => {
    expect(onClose(CLOSE.connectionLost, { paired: false, attempts: 0 })).toEqual({ action: 'wipe', event: 'unlink' });
  });

  it('does not retry when replaced or restricted', () => {
    expect(onClose(CLOSE.connectionReplaced, paired)).toEqual({ action: 'stop', error: 'replaced' });
    expect(onClose(CLOSE.forbidden, paired)).toEqual({ action: 'stop', error: 'restricted' });
  });

  it('backs off on network drops, then gives up', () => {
    const first = onClose(CLOSE.connectionClosed, paired, () => 0);
    expect(first).toMatchObject({ action: 'reconnect' });
    expect(first.delayMs).toBeGreaterThan(0);
    expect(onClose(CLOSE.connectionClosed, { paired: true, attempts: MAX_ATTEMPTS })).toEqual({ action: 'stop', error: 'connection_failed' });
  });
});

describe('backoffMs', () => {
  it('grows exponentially, jitters within [base/2, base] and caps at 60 s', () => {
    expect(backoffMs(1, () => 1)).toBe(1000);
    expect(backoffMs(1, () => 0)).toBe(500);
    expect(backoffMs(3, () => 1)).toBe(4000);
    expect(backoffMs(20, () => 1)).toBe(60_000);
  });
});
