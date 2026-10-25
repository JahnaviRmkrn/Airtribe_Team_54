import { HttpError } from './http';

// Per-request safety envelope, not a Supabase/PostgREST setting. Successful
// legacy payloads remain complete; hitting any budget is an explicit 503.
// Dashboard collections share this envelope rather than multiplying it.
export const COMPLETE_READ_LIMITS = Object.freeze({
  pageRows: 100,
  rows: 10_000,
  requests: 128,
  bytes: 4 * 1024 * 1024,
  milliseconds: 10_000,
});

type Limits = { [K in keyof typeof COMPLETE_READ_LIMITS]: number };
type Page<T> = { data: T[] | null; error: { message: string; code?: string } | null; count?: number | null };
type LoadPage<T> = (after: string | null, signal: AbortSignal, pageRows: number, verifyEmpty: boolean) => PromiseLike<Page<T>>;
export type CompleteReader = <T>(load: LoadPage<T>, key: (row: T) => string, compare?: (a: string, b: string) => number) => Promise<T[]>;
const compareKeys = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const incomplete = (reason: string, retry = true) => new HttpError(503, `Complete data could not be loaded: ${reason}.${retry ? ' Please retry.' : ''}`);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// PostgreSQL timestamptz JSON can preserve six fractional digits. Date.parse
// normalizes offsets but drops the last three; retain them as the tie-breaker.
export function compareReadTimestamps(a: string, b: string): number {
  const left = Date.parse(a), right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw incomplete('a database date was invalid');
  const micros = (value: string) => Number((value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
  return left - right || micros(a) - micros(b);
}

// Keyset scans avoid offset drift, not concurrent snapshots. In particular,
// inserts behind an already-read key and edits during a scan need a refresh.
// Every page must use the same authenticated RLS client and immutable key.
export async function withCompleteReads<T>(
  req: Request,
  work: (read: CompleteReader) => Promise<T>,
  limits: Limits = COMPLETE_READ_LIMITS,
): Promise<T> {
  const controller = new AbortController();
  const started = performance.now();
  const expired = () => performance.now() - started >= limits.milliseconds;
  const failure = () => incomplete(req.signal.aborted ? 'the request was cancelled' : 'the time limit was reached');
  const cancel = () => controller.abort();
  req.signal.addEventListener('abort', cancel, { once: true });
  if (req.signal.aborted) cancel();
  const timer = setTimeout(cancel, limits.milliseconds);
  let requests = 0, rows = 0, collectedBytes = 0;

  const read: CompleteReader = async <Row>(load: LoadPage<Row>, key: (row: Row) => string, compare: (a: string, b: string) => number = compareKeys) => {
    const result: Row[] = [];
    let after: string | null = null;
    let verifyEmpty = false;
    for (;;) {
      if (controller.signal.aborted || expired()) throw failure();
      if (++requests > limits.requests) throw incomplete('the read request limit was reached', false);
      // Abort the actual Supabase fetch, and bound waiting even if a transport
      // ignores cancellation. Remove each race listener after that page settles.
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(failure()); });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      let page: Page<Row>;
      try {
        page = await Promise.race([Promise.resolve(load(after, controller.signal, limits.pageRows, verifyEmpty)), aborted]);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw incomplete('a database page was unavailable');
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
      if (controller.signal.aborted || expired()) throw failure();
      if (page.error) throw incomplete('a database page was unavailable');
      if (verifyEmpty) {
        // A zero-row server cap (even one changed mid-scan) looks like an empty
        // table to a plain SELECT. One exact HEAD count, scoped to the same
        // filters/cursor, must independently establish zero remaining rows.
        if (page.count !== 0 || (page.data !== null && (!Array.isArray(page.data) || page.data.length))) {
          throw incomplete('the end of the result could not be verified');
        }
        return result;
      }
      if (!Array.isArray(page.data) || page.data.length > limits.pageRows) throw incomplete('a database page was invalid');
      // PostgREST may cap below our requested size. Only an empty probe proves
      // a candidate end, including an exactly full last page. Verify it by HEAD.
      if (!page.data.length) { verifyEmpty = true; continue; }
      rows += page.data.length;
      collectedBytes += bytes(page.data);
      if (rows > limits.rows) throw incomplete('the number of records exceeds this response limit', false);
      if (collectedBytes > limits.bytes) throw incomplete('the record size exceeds this response limit', false);
      for (const row of page.data) {
        let next: string;
        try { next = key(row); } catch { throw incomplete('the database page order was invalid'); }
        if (typeof next !== 'string' || !next || (after !== null && !(compare(next, after) > 0))) {
          throw incomplete('the database page order was invalid');
        }
        after = next;
        result.push(row);
      }
    }
  };

  try {
    const result = await work(read);
    if (controller.signal.aborted || expired()) throw failure();
    // A dashboard repeats contacts in several collections. Bound its actual
    // response too, not only the unique rows fetched from the database.
    if (bytes(result) > limits.bytes) throw incomplete('the response size exceeds this response limit', false);
    if (controller.signal.aborted || expired()) throw failure();
    return result;
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}
