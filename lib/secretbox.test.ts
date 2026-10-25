import { describe, expect, it } from 'vitest';
import { open, openString, parseKey, seal, sealString } from './secretbox.mjs';

const key = parseKey('ab'.repeat(32));

describe('secretbox', () => {
  it('round-trips and never stores plaintext', () => {
    const blob = seal('hello session', key, 'wa-auth:u1');
    expect(blob.includes(Buffer.from('hello'))).toBe(false);
    expect(open(blob, key, 'wa-auth:u1').toString()).toBe('hello session');
  });

  it('uses a fresh iv every time', () => {
    expect(seal('x', key, 'c').equals(seal('x', key, 'c'))).toBe(false);
  });

  it('rejects another context (another user or purpose)', () => {
    const blob = seal('x', key, 'wa-auth:u1');
    expect(() => open(blob, key, 'wa-auth:u2')).toThrow();
  });

  it('rejects the wrong key, tampering and truncation', () => {
    const blob = seal('secret', key, 'c');
    expect(() => open(blob, parseKey('cd'.repeat(32)), 'c')).toThrow();
    const bad = Buffer.from(blob);
    bad[bad.length - 1] ^= 1;
    expect(() => open(bad, key, 'c')).toThrow();
    expect(() => open(blob.subarray(0, 20), key, 'c')).toThrow();
    expect(() => open(Buffer.from([2, ...blob.subarray(1)]), key, 'c')).toThrow();
  });

  it('string variants round-trip', () => {
    expect(openString(sealString('{"a":1}', key, 'sms:u1'), key, 'sms:u1')).toBe('{"a":1}');
  });

  it('parses hex and base64 keys, rejects weak ones', () => {
    expect(parseKey(Buffer.alloc(32, 7).toString('base64')).length).toBe(32);
    expect(() => parseKey('')).toThrow();
    expect(() => parseKey(undefined)).toThrow();
    expect(() => parseKey('short')).toThrow();
    expect(() => parseKey('zz'.repeat(32))).toThrow();
  });
});
