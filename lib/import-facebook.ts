import { blankRow, clean, MAX_ROWS, type ImportRow, type ParseResult } from './import';

// Meta's JSON exports write UTF-8 bytes as if each were a Latin-1 character
// ("JosÃ©" for "José"). Re-encode as Latin-1 and decode as UTF-8; leave the
// string alone when it is not valid that way (already-correct text).
export function fixMojibake(s: string): string {
  if (!/[Â-ô]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s;
    bytes[i] = c;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

function toRows(names: unknown[]): ParseResult {
  const rows: ImportRow[] = [];
  let truncated = false;
  for (const n of names) {
    const name = clean(typeof n === 'string' ? fixMojibake(n) : null, 120);
    if (!name) continue;
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    rows.push(blankRow(name));
  }
  return { rows, truncated };
}

// connections/friends/your_friends.json: { "friends_v2": [{ name, timestamp }] }
// (older exports: "friends"; a bare array is tolerated too). The export has no ids.
export function parseFacebookJson(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error('This is not valid JSON. Choose connections/friends/your_friends.json from your Facebook export.');
  }
  const obj = data as Record<string, unknown> | null;
  const list = Array.isArray(data) ? data : (obj?.friends_v2 ?? obj?.friends);
  if (!Array.isArray(list)) throw new Error('No friends list found. Expected a "friends_v2" array (your_friends.json).');
  return toRows(list.map((f) => (f as { name?: unknown } | null)?.name));
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// HTML variant (your_friends.html): each friend is a heading whose text is the
// name, e.g. <h2 class="_a6-h _a6-i">Name</h2>.
export function parseFacebookHtml(text: string): ParseResult {
  // Linear scan (no backtracking regex): hostile files full of unclosed tags stay fast.
  const names: string[] = [];
  const lower = text.toLowerCase();
  let at = lower.indexOf('<h2');
  while (at >= 0 && names.length < MAX_ROWS) {
    const open = lower.indexOf('>', at);
    if (open < 0) break;
    const close = lower.indexOf('</h2>', open);
    if (close < 0) break;
    const inner = text.slice(open + 1, close);
    if (inner.length >= 1 && inner.length <= 200 && !inner.includes('<') && open - at <= 300) names.push(decodeEntities(inner));
    at = lower.indexOf('<h2', close);
  }
  if (!names.length) throw new Error('No friends found in this HTML file. Use your_friends.json if you can.');
  return toRows(names);
}

// Picks JSON or HTML by content, not by file name.
export function parseFacebookFriends(text: string): ParseResult {
  return /^\s*[[{]/.test(text.replace(/^﻿/, '')) ? parseFacebookJson(text) : parseFacebookHtml(text);
}

// Graph API friends who also use this app (a Meta restriction: the full friend
// list is not available). Follows cursor paging; the Bearer header keeps the
// token out of URLs and logs. Returns what it has on any failure so sign-in
// never breaks.
export async function fetchGraphFriends(token: string, doFetch: typeof fetch = fetch): Promise<ParseResult> {
  const rows: ImportRow[] = [];
  if (!/^[\w|.-]{10,1000}$/.test(token)) return { rows, truncated: false };
  let after: string | null = null;
  let truncated = false;
  try {
    for (let page = 0; page < 20; page++) {
      const url = new URL('https://graph.facebook.com/v21.0/me/friends');
      url.searchParams.set('fields', 'id,name');
      url.searchParams.set('limit', '500');
      if (after) url.searchParams.set('after', after);
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!res.ok) break;
      const body = (await res.json()) as { data?: { id?: unknown; name?: unknown }[]; paging?: { cursors?: { after?: string }; next?: string } };
      for (const f of body.data ?? []) {
        const name = clean(typeof f.name === 'string' ? fixMojibake(f.name) : null, 120);
        if (!name) continue;
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push({ ...blankRow(name), source_ref: typeof f.id === 'string' && /^\d{1,30}$/.test(f.id) ? f.id : null });
      }
      after = body.paging?.next ? (body.paging.cursors?.after ?? null) : null;
      if (!after || truncated) break;
    }
  } catch {
    // network/timeout/bad JSON: keep what we have
  }
  return { rows, truncated };
}
