/**
 * Which server this app is talking to (#113).
 *
 * SlyTab is meant to be self-hostable, and until now the app could only ever
 * reach one place: the base URL was read once at startup and baked into the
 * build. A family running their own copy had no way to point the App Store
 * build at it.
 *
 * The list is a list, not a setting, because the interesting case is having
 * more than one — the family server and the one a friend runs — and switching
 * between them without signing out of either. That makes token isolation the
 * whole design constraint: each server's session is stored under its own key
 * and is never in scope while another is active. A token is a bearer
 * credential, so handing one server's to another would be handing over the
 * account.
 */

import * as SecureStore from 'expo-secure-store';

import { hostOf, normaliseBase } from '@slytab/core';

// Re-exported so callers have one place to reach for anything about servers.
export { hostOf, normaliseBase };

export interface Backend {
  /** API base with no trailing slash, e.g. https://example.org/slytab/api/v1 */
  base: string;
  /** What it is called in the list. The host, unless someone renames it. */
  label: string;
}

/** Where the app points with nothing configured: the one this build shipped with. */
export const DEFAULT_BASE = 'https://electricrv.ca/slytab/api/v1';

export const DEFAULT_BACKEND: Backend = { base: DEFAULT_BASE, label: 'SlyTab' };

const LIST_KEY = 'slytab.backends';
const ACTIVE_KEY = 'slytab.backend.active';

/**
 * Where a server's session token is kept.
 *
 * The default server keeps the original key, so upgrading does not sign
 * everybody out. Everything else is keyed by the base URL, which is what makes
 * the isolation real rather than a convention — there is no single "the token"
 * for the wrong one to be read from.
 */
export function tokenKeyFor(base: string): string {
  if (base === DEFAULT_BASE) return 'slytab.session';
  // SecureStore keys allow alphanumerics, dot, dash and underscore only. The
  // slug alone can collide (https://a.org/x and https://a.org:1/x slug alike),
  // so a hash of the full URL rides along to keep them distinct.
  const slug = base.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 40);
  let h = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `slytab.session.${slug}.${h.toString(36)}`;
}

/**
 * Check something is actually a SlyTab API before adding it.
 *
 * Without this, a typo becomes a server in the list that fails on every screen
 * with no clue why. `/health` needs no session, so this asks nothing of an
 * account that does not exist yet.
 */
export async function probe(base: string): Promise<void> {
  let res: Response;
  // With a deadline, because the common wrong answer here is an address on the
  // local network that nothing is listening on — which does not refuse, it
  // hangs. Untimed, a typo leaves the button saying "Checking…" indefinitely
  // with no way to tell that from a slow server.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 10_000);
  try {
    res = await fetch(`${base}/health`, { method: 'GET', signal: stop.signal });
  } catch {
    throw new Error(`could not reach ${hostOf(base)} — check the address and that you are online`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`${hostOf(base)} answered ${res.status}, so it is not a SlyTab server`);
  const j = await res.json().catch(() => null) as
    { status?: string; service?: string; schemaVersion?: number } | null;
  // The service name, not just a 200: plenty of things answer 200, and a
  // captive portal or someone else's app would otherwise land in the list and
  // fail mysteriously on every screen afterwards.
  if (j === null || j.service !== 'slytab-api') {
    throw new Error(`${hostOf(base)} answered, but not like a SlyTab server`);
  }
}

/** Every server this app knows, the shipped one first. */
export async function loadBackends(): Promise<Backend[]> {
  const raw = await SecureStore.getItemAsync(LIST_KEY).catch(() => null);
  let added: Backend[] = [];
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        added = parsed.filter(
          (b): b is Backend =>
            typeof (b as Backend)?.base === 'string' && typeof (b as Backend)?.label === 'string'
            && (b as Backend).base !== DEFAULT_BASE,
        );
      }
    } catch {
      // Unreadable list: fall back to the shipped server rather than refusing
      // to start. Losing the list is recoverable; not opening is not.
    }
  }
  return [DEFAULT_BACKEND, ...added];
}

async function saveAdded(list: Backend[]): Promise<void> {
  const added = list.filter((b) => b.base !== DEFAULT_BASE);
  await SecureStore.setItemAsync(LIST_KEY, JSON.stringify(added));
}

/** The server in use, and its session — always fetched together. */
export async function loadActive(): Promise<{ base: string; token: string | null }> {
  const stored = await SecureStore.getItemAsync(ACTIVE_KEY).catch(() => null);
  const known = await loadBackends();
  // A base that is no longer in the list must not stay active — that is how a
  // removed server would keep being talked to.
  const base = known.some((b) => b.base === stored) && stored !== null ? stored : DEFAULT_BASE;
  const token = await SecureStore.getItemAsync(tokenKeyFor(base)).catch(() => null);
  return { base, token };
}

export async function setActive(base: string): Promise<string | null> {
  await SecureStore.setItemAsync(ACTIVE_KEY, base);
  return SecureStore.getItemAsync(tokenKeyFor(base)).catch(() => null);
}

export async function rememberToken(base: string, token: string | null): Promise<void> {
  const key = tokenKeyFor(base);
  if (token === null) await SecureStore.deleteItemAsync(key).catch(() => {});
  else await SecureStore.setItemAsync(key, token).catch(() => {});
}

/**
 * Add a server after checking it is one. Returns the whole list, since the
 * caller wants to redraw it either way.
 */
export async function addBackend(input: string, label?: string): Promise<Backend[]> {
  const base = normaliseBase(input);
  const list = await loadBackends();
  if (list.some((b) => b.base === base)) throw new Error(`${hostOf(base)} is already in the list`);
  await probe(base);
  const next = [...list, { base, label: label?.trim() || hostOf(base) }];
  await saveAdded(next);
  return next;
}

/**
 * Forget a server, and its session with it.
 *
 * Dropping the token is the point: leaving it behind would mean removing a
 * server from the list without removing the credential it holds, which is the
 * opposite of what removing it means.
 */
export async function removeBackend(base: string): Promise<Backend[]> {
  if (base === DEFAULT_BASE) throw new Error('the SlyTab server cannot be removed');
  const next = (await loadBackends()).filter((b) => b.base !== base);
  await saveAdded(next);
  await SecureStore.deleteItemAsync(tokenKeyFor(base)).catch(() => {});
  const active = await SecureStore.getItemAsync(ACTIVE_KEY).catch(() => null);
  if (active === base) await SecureStore.setItemAsync(ACTIVE_KEY, DEFAULT_BASE);
  return next;
}
