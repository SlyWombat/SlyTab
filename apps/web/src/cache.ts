/**
 * Stale-while-revalidate: paint the last known answer immediately, then let
 * the network correct it.
 *
 * The problem this solves is latency, not bandwidth. A group screen costs five
 * parallel round trips; from Santiago each is a few hundred milliseconds, so
 * the screen spends that time empty even though we already know what it looked
 * like a minute ago. Showing the previous answer first makes the trips
 * invisible rather than making them faster.
 *
 * Deliberately NOT a delta sync. Balances are derived server-side, so a delta
 * of expenses does not give a delta of balances without reimplementing the
 * netting maths client-side — a second copy of the one thing least allowed to
 * be wrong.
 */

const PREFIX = 'slytab.cache.';
// Bumped when a cached shape changes, so an old entry is ignored rather than
// deserialised into something the UI no longer understands.
const VERSION = 1;

type Entry<T> = { v: number; at: number; data: T };

/** Namespaced per user: a shared browser must never paint one account's data into another's. */
export function cacheKey(userId: string, name: string): string {
  return `${PREFIX}${userId}.${name}`;
}

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    return entry?.v === VERSION ? entry.data : null;
  } catch {
    return null; // corrupt or unavailable storage is a cache miss, never an error
  }
}

export function cacheSet(key: string, data: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: VERSION, at: Date.now(), data }));
  } catch {
    // Quota exceeded or private mode. A cache that cannot write is still a
    // working app, so this is silent by design.
  }
}

/** Drop every cached entry. Called on sign-out — cached balances outliving a session is a leak. */
export function cacheClear(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* nothing sensible to do */
  }
}

/**
 * Apply the cached value now (if any), then the fetched one.
 *
 * Rejections propagate, so existing error handling at the call site is
 * unchanged: the primary fetch still owns the error, the secondary ones stay
 * best-effort. When a fetch fails the cached value is what stays on screen,
 * which is the right answer offline.
 */
export function swr<T>(key: string, apply: (v: T) => void, fetcher: () => Promise<T>): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== null) apply(cached);
  return fetcher().then((fresh) => {
    apply(fresh);
    cacheSet(key, fresh);
    return fresh;
  });
}
