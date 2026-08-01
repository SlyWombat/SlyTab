/**
 * Stale-while-revalidate: paint the last known answer immediately, then let
 * the network correct it.
 *
 * A tester in Chile called the app laggy. Opening a group costs five parallel
 * round trips and each one is a few hundred milliseconds from Santiago, so the
 * screen sits empty for most of a second even when nothing has changed since
 * last time. This does not make the requests faster — it stops them being the
 * thing you wait for.
 *
 * Storage is expo-file-system, which the app already depends on for receipt
 * uploads. SecureStore would be wrong twice over: it is for secrets, and its
 * per-item size limit is far below a group's expense page.
 *
 * Deliberately NOT a delta sync. Balances are derived server-side, so a delta
 * of expenses does not yield a delta of balances without reimplementing the
 * netting maths here — a second copy of the one thing least allowed to be
 * wrong, in a second language.
 */

// The legacy API, matching how api.ts already uses this module.
const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');

const DIR = `${FileSystem.documentDirectory}slytab-cache/`;
// Bumped when a cached shape changes, so an old entry is ignored rather than
// deserialised into something the UI no longer understands.
const VERSION = 1;

type Entry<T> = { v: number; at: number; data: T };

let ready: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  ready ??= FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  return ready;
}

/** Namespaced per user, and reduced to something safe to use as a filename. */
export function cacheKey(userId: string, name: string): string {
  return `${userId}.${name}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

const pathFor = (key: string) => `${DIR}${key}.json`;

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    await ensureDir();
    const raw = await FileSystem.readAsStringAsync(pathFor(key));
    const entry = JSON.parse(raw) as Entry<T>;
    return entry?.v === VERSION ? entry.data : null;
  } catch {
    return null; // a missing or corrupt entry is a cache miss, never an error
  }
}

export async function cacheSet(key: string, data: unknown): Promise<void> {
  try {
    await ensureDir();
    await FileSystem.writeAsStringAsync(
      pathFor(key),
      JSON.stringify({ v: VERSION, at: Date.now(), data } satisfies Entry<unknown>),
    );
  } catch {
    // A cache that cannot write is still a working app.
  }
}

/** Drop everything. Called on sign-out — cached balances outliving a session is a leak. */
export async function cacheClear(): Promise<void> {
  try {
    await FileSystem.deleteAsync(DIR, { idempotent: true });
    ready = null;
  } catch {
    /* nothing sensible to do */
  }
}

/**
 * Apply the cached value now (if there is one), then the fetched one.
 *
 * The cached value is only applied if the network has not already answered —
 * on a fast connection the fetch can win, and painting stale data over fresh
 * data would be a bug that only shows up on good networks.
 *
 * Rejections propagate, so call sites keep their existing error handling: the
 * primary fetch still owns the error and the secondary ones stay best-effort.
 * When a fetch fails the cached value is what remains on screen, which is the
 * right answer offline.
 */
export function swr<T>(key: string, apply: (v: T) => void, fetcher: () => Promise<T>): Promise<T> {
  let landed = false;
  void cacheGet<T>(key).then((v) => {
    if (v !== null && !landed) apply(v);
  });
  return fetcher().then((fresh) => {
    landed = true;
    apply(fresh);
    void cacheSet(key, fresh);
    return fresh;
  });
}
