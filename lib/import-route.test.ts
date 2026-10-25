import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ existing: [] as unknown[], rpc: vi.fn(), limitUser: vi.fn(), signedIn: true }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/http', () => {
  class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
  return {
    HttpError,
    ok: (body: unknown, status = 200) => ({ status, body }),
    dbError: (e: { message: string } | null) => { if (e) throw new HttpError(400, e.message); },
    handle: (fn: (...a: never[]) => Promise<unknown>) => async (...a: never[]) => {
      try { return await fn(...a); } catch (e) { if (e instanceof HttpError) return { status: e.status, body: { error: e.message } }; throw e; }
    },
    requireUser: async () => {
      if (!mocks.signedIn) throw new HttpError(401, 'Not signed in');
      const q: Record<string, unknown> = {};
      q.select = () => q; q.order = () => q;
      q.range = async (from: number) => ({ data: from === 0 ? mocks.existing : [], error: null });
      return { supabase: { from: () => q, rpc: mocks.rpc }, user: { id: 'u1' } };
    },
  };
});
vi.mock('@/lib/ratelimit', () => ({ limitUser: mocks.limitUser }));

const preview = (await import('../app/api/me/contacts/import/preview/route')).POST as (r: Request) => Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
const confirm = (await import('../app/api/me/contacts/import/route')).POST as typeof preview;

const post = (body: unknown) => new Request('https://app/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const row = (i: number, extra = {}) => ({ name: `Person ${i}`, email: null, phone: null, source_ref: null, company: null, position: null, notes: null, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existing = [];
  mocks.signedIn = true;
  mocks.rpc.mockImplementation(async (_fn: string, a: { p_rows: unknown[] }) => ({ data: { inserted: a.p_rows.length, updated: 0 }, error: null }));
});

describe('POST /api/me/contacts/import/preview', () => {
  it('requires sign-in and rate limits per user', async () => {
    mocks.signedIn = false;
    expect((await preview(post({ source: 'linkedin', content: 'x' }))).status).toBe(401);
    mocks.signedIn = true;
    await preview(post({ source: 'linkedin', content: 'x' }));
    expect(mocks.limitUser).toHaveBeenCalledWith('import', 'u1');
  });
  it('rejects bad JSON, unknown sources and empty content', async () => {
    expect((await preview(post('{nope'))).status).toBe(400);
    expect((await preview(post({ source: 'myspace', content: 'x' }))).status).toBe(400);
    expect((await preview(post({ source: 'linkedin', content: '' }))).status).toBe(400);
  });
  it('rejects oversized bodies and files (5 MB; 15 MB for .vcf)', async () => {
    expect((await preview(post({ source: 'linkedin', content: 'x'.repeat(5 * 1024 * 1024 + 1) }))).status).toBe(413);
    expect((await preview(post({ source: 'vcard', content: 'x'.repeat(16 * 1024 * 1024 + 2) }))).status).toBe(413);
  });
  it('returns a readable 400 for a wrong file and never writes', async () => {
    const r = await preview(post({ source: 'linkedin', content: 'a,b\n1,2' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Connections\.csv/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('parses and flags duplicates against existing contacts', async () => {
    mocks.existing = [{ name: 'Priya Raman', email: 'priya@example.com', phone: null, source: null, source_ref: null }];
    const r = await preview(post({ source: 'linkedin', content: 'First Name,Last Name,Email Address\nPriya,Raman,priya@example.com\nNew,Person,\n' }));
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: { verdict: string }) => x.verdict)).toEqual(['duplicate', 'new']);
  });
  it('accepts Android picker results', async () => {
    const r = await preview(post({ source: 'android', picks: [{ name: ['A B'], email: ['a@b.co'], tel: ['9876543210'] }] }));
    expect(r.body.rows[0]).toMatchObject({ name: 'A B', phone: '+919876543210', verdict: 'new' });
  });
});

describe('POST /api/me/contacts/import', () => {
  const body = (contacts: unknown[], extra = {}) => ({ source: 'linkedin', category: 'professional', contacts, ...extra });
  it('validates category, source and row shape', async () => {
    expect((await confirm(post(body([row(1)], { category: 'work' })))).status).toBe(400);
    expect((await confirm(post(body([row(1)], { source: 'tinder' })))).status).toBe(400);
    expect((await confirm(post(body([row(1, { email: 'nope' })])))).status).toBe(400);
    expect((await confirm(post(body([row(1, { phone: '12345' })])))).status).toBe(400);
    expect((await confirm(post(body([])))).status).toBe(400);
    expect((await confirm(post(body(Array.from({ length: 5001 }, (_, i) => row(i)))))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('inserts in batches of 500', async () => {
    const r = await confirm(post(body(Array.from({ length: 1200 }, (_, i) => row(i)))));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ inserted: 1200, updated: 0, skipped: 0 });
    expect(mocks.rpc.mock.calls.map((c) => c[1].p_rows.length)).toEqual([500, 500, 200]);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_source: 'linkedin', p_category: 'professional' });
  });
  it('re-checks duplicates server-side so a replayed confirm cannot double-insert', async () => {
    mocks.existing = [{ name: 'Person 1', email: null, phone: null, source: null, source_ref: null }];
    const r = await confirm(post(body([row(1), row(2)])));
    expect(r.body).toEqual({ inserted: 1, updated: 0, skipped: 1 });
    expect(mocks.rpc.mock.calls[0][1].p_rows).toEqual([row(2)]);
  });
  it('surfaces database errors', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect((await confirm(post(body([row(1)])))).status).toBe(400);
  });
});
