import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from './http';
import { importRowSchema } from './schemas';
import { parseGoogleCsv } from './import-google';
import { parseFacebookFriends } from './import-facebook';
import { parseLinkedInCsv } from './import-linkedin';
import { parseVcard } from './import-vcard';
import { MAX_ROWS, type Existing, type ImportRow, type ImportSource, type ParseResult } from './import';

export const STAGE_TTL_DAYS = 7;

// Text parsers by source. Parser errors carry a user-facing message -> 400.
export function parseUpload(source: ImportSource, content: string): ParseResult {
  try {
    switch (source) {
      case 'linkedin': return parseLinkedInCsv(content);
      case 'facebook': return parseFacebookFriends(content);
      case 'vcard': return parseVcard(content);
      case 'google': return /^\s*BEGIN:VCARD/i.test(content.replace(/^﻿/, '')) ? parseVcard(content) : parseGoogleCsv(content);
      default: throw new Error(`Uploading a file is not supported for ${source}.`);
    }
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'Could not read this file');
  }
}

// All of the user's contacts as dedupe keys. PostgREST returns <= 1000 rows per
// request, so page through (RLS already limits this to the caller's rows).
export async function loadExisting(supabase: SupabaseClient): Promise<Existing[]> {
  const out: Existing[] = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await supabase.from('contacts').select('name,email,phone,source,source_ref').order('id').range(from, from + 999);
    if (error) throw new HttpError(400, error.message);
    out.push(...(data as Existing[]));
    if (data.length < 1000) break;
  }
  return out;
}

export async function loadStaged(supabase: SupabaseClient, source: 'facebook' | 'google'): Promise<ParseResult | null> {
  const since = new Date(Date.now() - STAGE_TTL_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('contact_import_stage').select('rows').eq('source', source).gte('created_at', since).maybeSingle();
  if (error) throw new HttpError(400, error.message);
  // The table is user-writable, so re-validate instead of trusting the cast.
  const rows = Array.isArray(data?.rows) ? (data.rows.slice(0, MAX_ROWS).map((r: unknown) => importRowSchema.safeParse(r)).filter((r) => r.success).map((r) => r.data) as ImportRow[]) : [];
  return rows.length ? { rows: rows.slice(0, MAX_ROWS), truncated: false } : null;
}
