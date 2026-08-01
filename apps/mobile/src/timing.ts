/**
 * Client-side timing (#111), phone edition.
 *
 * The web client got this first, which was the wrong way round: the lag was
 * reported on iOS and on Android, by two people, and the web instrumentation
 * could never have seen either. This is the half that measures where the
 * problem actually was.
 *
 * Three rules, same as web:
 *
 *  - **Never slow down the thing being measured.** Timings are buffered and
 *    flushed on a timer, never per request — an extra round trip on a slow
 *    link is exactly what we are trying to find.
 *  - **Never surface an error.** A failed flush drops the batch. Diagnostics
 *    that can interrupt someone splitting a dinner bill are not worth having.
 *  - **Never send anything identifying.** The server reduces paths to
 *    templates before storage; nothing here carries a group id, a description
 *    or an amount. There is no third-party analytics in this app.
 */
import { AppState } from 'react-native';

export type Timing = {
  kind: 'api' | 'screen';
  name: string;
  ms: number;
  status?: number;
};

const FLUSH_MS = 20_000;
/** Flush early once a burst has built up, so a busy session is not lost. */
const FLUSH_AT = 25;
/** Beyond this something is wrong with the flush, and memory matters more. */
const MAX_BUFFER = 200;

let buffer: Timing[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let send: ((batch: Timing[]) => Promise<unknown>) | null = null;

/**
 * Wire up the sender. Done from api.ts rather than imported the other way
 * round: this module must not depend on the client it measures.
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
  // Dropped on failure, deliberately: retrying diagnostics competes for a
  // connection on the exact link that is already struggling.
  await send(batch).catch(() => {});
}

/**
 * Send what is buffered before the app goes to the background — on a phone
 * that is the normal end of a session, and without this the last and often
 * most interesting stretch would never arrive.
 */
AppState.addEventListener('change', (state) => {
  if (state !== 'active') void flush();
});
