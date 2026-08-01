/**
 * Client-side timing (#111).
 *
 * Two testers called the app laggy and we had no measurement of either, so the
 * first diagnosis was made by reading code and was wrong. This makes the next
 * one evidence.
 *
 * Three rules it follows:
 *
 *  - **Never slow down the thing being measured.** Timings are buffered and
 *    flushed on a timer, never per request.
 *  - **Never surface an error.** A failed flush drops the batch. Diagnostics
 *    that can interrupt someone splitting a dinner bill are not worth having.
 *  - **Never send anything identifying.** The server reduces paths to
 *    templates, and nothing here carries a group id, a description or an
 *    amount. There is no third-party analytics in this app and this is not one.
 */

export type Timing = {
  kind: 'api' | 'screen';
  name: string;
  ms: number;
  status?: number;
};

const FLUSH_MS = 20_000;
/** Flush early once a burst has built up, so a slow session is not lost on close. */
const FLUSH_AT = 25;
/** Beyond this something is wrong with the flush, and memory matters more than the data. */
const MAX_BUFFER = 200;

let buffer: Timing[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let send: ((batch: Timing[]) => Promise<unknown>) | null = null;

/**
 * Wire up the sender. Done from api.ts rather than imported the other way
 * round: this module must not depend on the client it measures, or the first
 * request would drag the whole API surface in with it.
 */
export function setTimingSender(fn: (batch: Timing[]) => Promise<unknown>): void {
  send = fn;
}

export function record(t: Timing): void {
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push(t);
  if (buffer.length >= FLUSH_AT) { void flush(); return; }
  timer ??= setTimeout(() => { void flush(); }, FLUSH_MS);
}

export async function flush(): Promise<void> {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (buffer.length === 0 || send === null) return;
  const batch = buffer;
  buffer = [];
  // Dropped on failure, deliberately: retrying diagnostics competes with real
  // requests for a connection, on the exact link that is already struggling.
  await send(batch).catch(() => {});
}

/**
 * Time an async operation and record it.
 *
 * `status` is 0 when the call threw before a response — which is itself worth
 * seeing, because "slow" and "failed after a long wait" look the same to
 * whoever is holding the phone.
 */
export async function timed<T>(
  kind: Timing['kind'],
  name: string,
  run: () => Promise<T>,
  statusOf: (result: unknown, error: unknown) => number = () => 0,
): Promise<T> {
  const started = Date.now();
  try {
    const out = await run();
    record({ kind, name, ms: Date.now() - started, status: statusOf(out, null) });
    return out;
  } catch (e) {
    record({ kind, name, ms: Date.now() - started, status: statusOf(null, e) });
    throw e;
  }
}

/** Send what is buffered before the tab goes away. */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}
