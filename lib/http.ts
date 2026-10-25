import { NextResponse } from 'next/server';
import type { ZodType } from 'zod';
import { userClient } from './supabase/server';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const ok = (data: unknown, status = 200) => NextResponse.json(data, { status });

export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      console.error(e);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
  };
}

// Reads a request body but gives up (413) once it passes `max` bytes, even for
// chunked uploads that send no Content-Length.
export async function readBodyLimited(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) throw new HttpError(413, 'Request is too large');
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'Request is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export const DEFAULT_BODY_MAX = 64_000;

export async function parseBody<T>(req: Request, schema: ZodType<T>, maxBytes = DEFAULT_BODY_MAX): Promise<T> {
  let raw: unknown;
  const bytes = await readBodyLimited(req, maxBytes);
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

export async function requireUser(req: Request) {
  const supabase = await userClient(req);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'Not signed in');
  return { supabase, user: data.user };
}

export function dbError(error: { message: string; code?: string } | null) {
  if (!error) return;
  if (error.code === 'PGRST116') throw new HttpError(404, 'Not found');
  if (error.code === '23505') throw new HttpError(409, 'Already exists');
  throw new HttpError(400, error.message);
}
