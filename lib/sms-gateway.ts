import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { HttpError } from './http';

// Sends SMS through the organiser's own Android phone running the open-source
// "SMS Gateway for Android" app (sms-gate.app). Two modes:
//   cloud  muop calls the public cloud API with the username/password the app shows
//   local  muop calls the phone's own server (LAN / Tailscale URL) with the same creds
// Credentials are stored sealed (lib/secretbox.mjs) and never sent back to the browser.

export type GatewayCreds = { mode: 'cloud' | 'local'; url?: string; username: string; password: string };

export const smsLinkBody = z
  .object({
    accept: z.literal(true, { error: 'Accept the notice to link SMS' }),
    mode: z.enum(['cloud', 'local']),
    url: z.string().trim().max(200).optional(),
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(128),
  })
  .refine((b) => b.mode === 'cloud' || !!b.url, { message: 'url: the phone address is required in local mode', path: ['url'] });

export const smsTestBody = z.object({ to: z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, 'Enter your number in international format, e.g. +919876543210') });

export const SMS_MAX_TEXT = 1000;
export const smsCloudUrl = () => process.env.SMS_GATE_CLOUD_URL || 'https://api.sms-gate.app';
export const smsLocalEnabled = () => process.env.SMS_LOCAL_MODE !== 'off';

// --- SSRF guard for local mode ---------------------------------------------
// The organiser supplies this URL and the server will call it. It may point at
// a phone on the LAN or tailnet, but never at this machine itself, link-local
// or metadata addresses.

function ipv4Parts(ip: string): number[] | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}

/** True for addresses the server must never call on a user's behalf. */
export function isForbiddenAddress(ip: string, own: string[] = ownAddresses()): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];
  if (own.includes(ip.toLowerCase())) return true;
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224; // unspecified, loopback, link-local/metadata, multicast+
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fe80') || v6.startsWith('ff') || v6.startsWith('fd00:ec2');
}

function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((i) => i.address.toLowerCase()));
}

/** Parses and vets a local-mode URL; returns it without trailing slash. Throws HttpError(400). */
export function checkLocalUrl(raw: string): URL {
  if (!smsLocalEnabled()) throw new HttpError(400, 'Local mode is disabled on this server. Use cloud mode.');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'url: not a valid address, e.g. http://192.168.1.20:8080');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'url: must start with http:// or https://');
  if (u.username || u.password) throw new HttpError(400, 'url: put the username and password in their own fields');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isForbiddenAddress(host))) {
    throw new HttpError(400, 'url: that address is not allowed. Use the phone\'s LAN or Tailscale address.');
  }
  return u;
}

// DNS lookup that re-checks the resolved address at connect time, so a name
// that later resolves to a forbidden address (rebinding) is refused.
const safeLookup: typeof dnsLookup = ((hostname: string, options: unknown, cb: unknown) => {
  const callback = (typeof options === 'function' ? options : cb) as (e: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;
  const opts = (typeof options === 'object' && options ? options : {}) as { all?: boolean };
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return callback(err);
    const ok = (addrs as { address: string; family: number }[]).filter((a) => !isForbiddenAddress(a.address));
    if (!ok.length) return callback(new Error('forbidden address'));
    if (opts.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}) as typeof dnsLookup;

export type GatewayResponse = { status: number };
export type Transport = (req: { url: URL; username: string; password: string; body: string; guard: boolean }) => Promise<GatewayResponse>;

/** Real HTTP transport: no redirects, 10 s timeout, response body discarded. */
export const httpTransport: Transport = ({ url, username, password, body, guard }) =>
  new Promise((resolve, reject) => {
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = doRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
        },
        timeout: 10_000,
        ...(guard ? { lookup: safeLookup } : {}),
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });

/** Sends one SMS through the organiser's phone. Throws HttpError with a safe message. */
export async function sendSms(creds: GatewayCreds, to: string, text: string, transport: Transport = httpTransport): Promise<void> {
  const local = creds.mode === 'local';
  const url = local ? checkLocalUrl(creds.url ?? '') : new URL(smsCloudUrl());
  const target = new URL((local ? url.origin + url.pathname.replace(/\/+$/, '') + '/message' : url.origin + '/3rdparty/v1/message'));
  let res: GatewayResponse;
  try {
    res = await transport({
      url: target,
      username: creds.username,
      password: creds.password,
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to] }),
      guard: local,
    });
  } catch {
    throw new HttpError(502, local ? 'Could not reach your phone. Is the SMS Gateway app running and reachable from this server?' : 'Could not reach the SMS gateway cloud');
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The SMS gateway rejected the username or password. Link SMS again.');
  if (res.status < 200 || res.status >= 300) throw new HttpError(502, 'The SMS gateway could not take the message');
}
