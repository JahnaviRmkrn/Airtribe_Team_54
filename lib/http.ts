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

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
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
  if (error.message.includes('room_closed')) throw new HttpError(410, 'This meetup room is closed');
  if (error.message.includes('venue_confirmed')) throw new HttpError(409, 'The organiser has already confirmed a venue');
  if (error.code === 'PGRST116') throw new HttpError(404, 'Not found');
  if (error.code === '23505') throw new HttpError(409, 'Already exists');
  throw new HttpError(400, error.message);
}
