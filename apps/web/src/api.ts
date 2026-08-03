/**
 * Thin fetch client for the SlyTab API. The base URL is derived from
 * Vite's BASE_URL so the same build works in dev (proxy) and under
 * electricrv.ca/slytab/. Errors are always the server envelope.
 */

const BASE = `${import.meta.env.BASE_URL}api/v1`;
const TOKEN_KEY = 'slytab.token';

export interface ApiError {
  code: string;
  message: string;
}

export class ApiFailure extends Error {
  constructor(public readonly error: ApiError, public readonly status: number) {
    super(error.message);
  }
}

import type { CategoryOverride } from '@slytab/core';
import { record, setTimingSender } from './timing';

export interface User {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  displayName: string;
  notifyLevel?: 'all' | 'important' | 'none';
  avatar: string;
  hasAvatar?: boolean;
  /** Changes whenever the photo does, so a replaced one is a new URL (#112). */
  avatarVersion?: string | null;
  defaultCurrency: string;
  paymentHandles: { interacEmail?: string; paypalMe?: string; venmo?: string };
  /** null until the first-run welcome flow is completed (issue #36). */
  onboardedAt?: string | null;
  /** 'apple' | 'google' — how they sign in, for offering the right app build. */
  signInProviders?: string[];
}

export interface Member {
  id: string;
  displayName: string;
  avatar: string;
  /** #112: whether to fetch a photo for this person, rather than the photo itself. */
  hasAvatar?: boolean;
  /** Changes whenever the photo does, so a replaced one is a new URL (#112). */
  avatarVersion?: string | null;
  paymentHandles: User['paymentHandles'];
}

export interface Group {
  id: string;
  name: string;
  emoji: string;
  homeCurrency: string;
  currencies: string[];
  isDirect: boolean;
  archivedAt: string | null;
  members: Member[];
}

export interface Participant {
  userId: string;
  amountMinor: number;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amountMinor: number;
  currency: string;
  fxRate: number | null;
  expenseDate: string;
  category: string;
  /** Only present from /me/expenses (#101) — a cross-group list needs the label. */
  groupName?: string;
  groupEmoji?: string;
  createdBy: string;
  splitMethod: string;
  /** Per-member form inputs for shares/percent/adjustment splits, so editing restores them. */
  splitInput?: Record<string, number> | null;
  payers: Participant[];
  shares: Participant[];
  receiptId: string | null;
  /** All linked receipts (bill + card slip …), primary first. */
  receiptIds: string[];
}

export interface Transfer {
  from: string;
  to: string;
  amountMinor: number;
}

export interface Balances {
  net: Record<string, number>;
  plan: Transfer[];
  pairwise: Transfer[];
  /**
   * #106: the same balances kept in the currency each expense was spent in,
   * unconverted. Present only when the group has spent in more than one —
   * otherwise it says nothing the converted net does not.
   */
  byCurrency?: Record<string, Record<string, number>>;
}

export interface Settlement {
  id: string;
  groupId: string;
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  currency: string;
  method: string;
  status: 'pending' | 'confirmed';
}

export interface GroupTotals {
  totalMinor: number;
  byCategory: { category: string; minor: number }[];
  /** Subcategories rolled up under their heading (#18). */
  byHeading: { category: string; minor: number }[];
  byPayer: { userId: string; minor: number }[];
  byShare: { userId: string; minor: number }[];
  byMonth: { month: string; minor: number }[];
}
export interface SplitwiseGroup {
  id: number; name: string; members: { id: number; name: string }[];
}
export interface ImportResult {
  imported: { expenses: number; settlements: number; skipped: number; duplicates?: number };
  invited?: string[];
  errors: string[];
}
export interface ActivityItem {
  id: string; userId: string; verb: string; entityType: string; entityId: string;
  diff: Record<string, unknown> | null; createdAt: string;
}
export interface Comment { id: string; userId: string; body: string; createdAt: string }
export interface ExpenseFilters { q?: string; category?: string; member?: string; from?: string; to?: string }
export interface Session {
  id: string; deviceLabel: string; createdAt: string; lastSeenAt: string; current: boolean;
}
export interface HomeBalances {
  items: {
    group: Group;
    netMinor: number;
    currency: string;
    /** Per-person balances vs me in this group (group home currency), biggest first. Positive = they owe me. */
    myPairs: { userId: string; amountMinor: number }[];
  }[];
  pendingSettlements: Settlement[];
  total: {
    minor: number;
    /** What others owe me / what I owe, both in my home currency. */
    owedMinor: number;
    oweMinor: number;
    currency: string;
    approximate: boolean;
    excluded: string[];
  };
}

/**
 * Issue #26: sessions labeled just "web" were indistinguishable in the
 * profile's device list — name the browser and OS so "logged in twice"
 * reads as what it is.
 */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux' : 'web';
  return `${browser} on ${os}`;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

/**
 * GETs already in flight, keyed by path. See the mobile client for the
 * measurements that prompted this: identical requests issued together queue
 * behind each other, and the wait shows up in every one of them. The second
 * caller of an in-flight GET gets the same promise rather than a second round
 * trip.
 *
 * Not a cache — entries live only while the request is outstanding, so nothing
 * already resolved is ever handed back.
 */
const inFlight = new Map<string, Promise<unknown>>();

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (method === 'GET') {
    const running = inFlight.get(path) as Promise<T> | undefined;
    if (running) return running;
    const p = timedReq<T>(method, path, body).finally(() => { inFlight.delete(path); });
    inFlight.set(path, p);
    return p;
  }
  return timedReq<T>(method, path, body);
}

async function timedReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const started = Date.now();
  let status = 0;
  try {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    status = res.status;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiFailure(
        (json as { error?: ApiError }).error ?? { code: 'NETWORK', message: 'request failed' },
        res.status,
      );
    }
    return json as T;
  } finally {
    // #111: measure everything except the measurements themselves, or a slow
    // link turns one dropped batch into an endless conversation with itself.
    // status 0 means it never got a response, which is worth seeing: "slow"
    // and "failed after a long wait" feel identical to whoever is waiting.
    if (path !== '/timings') {
      record({ kind: 'api', name: `${method} ${path}`, ms: Date.now() - started, status });
    }
  }
}

// Wired here rather than imported the other way round, so the timing module
// does not drag the whole API surface in behind it.
setTimingSender((items) =>
  req('POST', '/timings', {
    items,
    platform: 'web',
    appVersion: import.meta.env.VITE_APP_VERSION ?? '',
  }),
);

export interface ReceiptItem {
  name: string;
  quantity: number;
  totalMinor: number;
}

export interface ParsedReceipt {
  merchant: string | null;
  date: string | null;
  currency: string | null;
  /** Minor-unit scale of the *Minor fields; older parses omit it. */
  scale?: number | null;
  items: ReceiptItem[];
  subtotalMinor: number | null;
  taxMinor: number | null;
  tipMinor: number | null;
  totalMinor: number | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface ReceiptResult {
  id: string;
  groupId: string;
  parsed: ParsedReceipt | null;
  parseError?: string;
}

async function upload<T>(path: string, field: string, file: File, extra: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  fd.append(field, file);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiFailure(
      (json as { error?: ApiError }).error ?? { code: 'NETWORK', message: 'upload failed' },
      res.status,
    );
  }
  return json as T;
}

/** Progress/cancel hooks for long uploads on slow connections (issue #9). */
export interface UploadHooks {
  onUploadProgress?: (fraction: number) => void;
  onUploaded?: () => void;
  signal?: AbortSignal;
}

/**
 * XHR-based upload: fetch() cannot report upload progress. Rejects with
 * code CANCELED on abort and NETWORK on connection failure.
 */
function uploadWithProgress<T>(path: string, field: string, blob: Blob, filename: string, hooks: UploadHooks,
  extra: Record<string, string> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fd = new FormData();
    fd.append(field, blob, filename);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && hooks.onUploadProgress) hooks.onUploadProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => hooks.onUploaded?.();
    xhr.onload = () => {
      let json: unknown = {};
      try { json = JSON.parse(xhr.responseText); } catch { /* non-JSON error body */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(json as T);
      } else {
        reject(new ApiFailure(
          (json as { error?: ApiError }).error ?? { code: 'NETWORK', message: 'upload failed' },
          xhr.status,
        ));
      }
    };
    xhr.onerror = () => reject(new ApiFailure(
      { code: 'NETWORK', message: "the upload didn't reach the server — check your connection and try again" }, 0));
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => reject(new ApiFailure({ code: 'CANCELED', message: 'upload canceled' }, 0));
    hooks.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(fd);
  });
}

/**
 * Downscale a photo in the browser before upload: slow cellular links
 * choke on 10-20 MB phone photos, and the server only needs ~1600px.
 * Falls back to the original file if decoding fails.
 */
export async function shrinkImage(file: File, maxDim = 1600): Promise<{ blob: Blob; name: string }> {
  if (file.size < 500 * 1024) return { blob: file, name: file.name };
  try {
    // from-image keeps EXIF rotation — iPhone photos are portrait-tagged.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      .catch(() => createImageBitmap(file));
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (blob === null || blob.size >= file.size) return { blob: file, name: file.name };
    return { blob, name: file.name.replace(/\.[a-z]+$/i, '') + '.jpg' };
  } catch {
    return { blob: file, name: file.name };
  }
}

export const api = {
  register: (email: string, password: string, displayName: string) =>
    req<{ token: string; user: User }>('POST', '/auth/register', {
      email, password, displayName, deviceLabel: deviceLabel(),
    }),
  login: (email: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/auth/login', { email, password, deviceLabel: deviceLabel() }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
  resetRequest: (email: string) => req<{ ok: true }>('POST', '/auth/reset-request', { email }),
  resetPassword: (token: string, password: string) =>
    req<{ ok: true }>('POST', '/auth/reset', { token, password }),
  me: () => req<User>('GET', '/me'),
  /**
   * Every expense your money is in, across all groups (#101). `paid` follows
   * the money (you were a payer), `involved` follows your share.
   */
  myExpenses: (opts: {
    scope?: 'paid' | 'involved'; sort?: string; q?: string; cursor?: string;
  } = {}) => {
    const p = new URLSearchParams();
    if (opts.scope) p.set('scope', opts.scope);
    if (opts.sort) p.set('sort', opts.sort);
    if (opts.q) p.set('q', opts.q);
    if (opts.cursor) p.set('cursor', opts.cursor);
    const qs = p.toString();
    return req<{
      items: Expense[];
      nextCursor: string | null;
      summary: { count: number; totalMinor: number; currency: string; approximate: boolean };
    }>('GET', `/me/expenses${qs ? `?${qs}` : ''}`);
  },
  /** Leave a group (#84) — refuses while your balance is non-zero. */
  leaveGroup: (groupId: string) =>
    req<{ ok: true }>('POST', `/groups/${groupId}/leave`),
  patchMe: (data: Partial<Pick<User, 'displayName' | 'avatar' | 'defaultCurrency' | 'paymentHandles' | 'notifyLevel'>> & { onboarded?: boolean }) =>
    req<User>('PATCH', '/me', data),
  uploadReceipt: async (groupId: string, file: File, hooks: UploadHooks = {}, currencyHint?: string) => {
    const { blob, name } = await shrinkImage(file);
    return uploadWithProgress<ReceiptResult>(`/groups/${groupId}/receipts`, 'image', blob, name, hooks,
      currencyHint ? { currencyHint } : {});
  },
  /** #112. Multipart, because it is a file; the response only says it worked. */
  setAvatar: (blob: Blob, name = 'avatar.jpg') =>
    uploadWithProgress<{ avatarPath: string }>('/me/avatar', 'image', blob, name, {}),
  clearAvatar: () => req<{ ok: true }>('DELETE', '/me/avatar'),
  receiptEta: () => req<{ samples: number; typicalMs: number; slowMs: number }>('GET', '/receipts/eta'),
  /** Report a bug from the profile page: comment + optional screenshot. */
  archiveGroup: (groupId: string) => req<{ ok: true }>('POST', `/groups/${groupId}/archive`),
  // Only for a group that never held money — the server refuses with
  // GROUP_NOT_EMPTY otherwise, and archiving stays the answer for the rest.
  deleteGroup: (groupId: string) => req<{ ok: true }>('DELETE', `/groups/${groupId}`),
  reportBug: async (message: string, image?: File | null): Promise<{ id: string; status: string; tracking?: string }> => {
    const fd = new FormData();
    fd.append('message', message);
    fd.append('context', `web ${navigator.userAgent}`.slice(0, 500));
    if (image) fd.append('image', image);
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}/bugs`, { method: 'POST', headers, body: fd });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiFailure(
        (json as { error?: ApiError }).error ?? { code: 'NETWORK', message: 'could not send the report' },
        res.status,
      );
    }
    return json as { id: string; status: string; tracking?: string };
  },
  /** Re-run the parser on the stored photo — no re-photographing. */
  rescanReceipt: (receiptId: string, currencyHint?: string) =>
    req<ReceiptResult>('POST', `/receipts/${receiptId}/rescan`,
      currencyHint ? { currencyHint } : {}),
  /**
   * A person's photo as an object URL, or null if they have none (#112).
   *
   * Cached per user for the life of the page: a badge is drawn dozens of times
   * on a busy group screen, and each one is the same handful of bytes. The
   * cache holds the PROMISE, so twenty badges rendering at once share a single
   * request rather than racing.
   */
  avatarUrl: (() => {
    const cache = new Map<string, Promise<string | null>>();
    return (userId: string, version?: string | null): Promise<string | null> => {
      // Keyed by person AND version. Keyed by person alone — which is how this
      // was written — the first fetch was memoised forever, so uploading a new
      // photo changed nothing on screen no matter where you navigated. That is
      // the bug the owner hit on 2026-08-03, and the HTTP cache header was only
      // the second reason it stuck.
      const key = `${userId}:${version ?? ''}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const headers: Record<string, string> = {};
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const v = version ? `?v=${encodeURIComponent(version)}` : '';
      const p = fetch(`${BASE}/users/${userId}/avatar${v}`, { headers })
        .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
        // A missing or forbidden photo is not an error worth surfacing — the
        // initials badge is a perfectly good answer.
        .catch(() => null);
      cache.set(key, p);
      return p;
    };
  })(),
  receiptImageUrl: async (receiptId: string): Promise<string> => {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}/receipts/${receiptId}/image`, { headers });
    if (!res.ok) throw new ApiFailure({ code: 'NOT_FOUND', message: 'could not load the receipt photo' }, res.status);
    return URL.createObjectURL(await res.blob());
  },
  fxRate: (base: string, quote: string) =>
    req<{ date: string; base: string; quote: string; rate: number }>(
      'GET', `/rates?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}`),
  inspectSplitwise: (groupId: string, file: File) =>
    upload<{
      members: string[]; expenseRows: number; paymentRows: number;
      currencies: string[]; dateRange: { from: string; to: string } | null;
    }>(`/groups/${groupId}/import/splitwise`, 'csv', file, { dryRun: '1' }),
  importSplitwise: (groupId: string, file: File, mapping: Record<string, string>) =>
    upload<{
      imported: { expenses: number; settlements: number; skipped: number; duplicates?: number };
      errors: string[];
    }>(`/groups/${groupId}/import/splitwise`, 'csv', file, { mapping: JSON.stringify(mapping) }),
  homeBalances: () => req<HomeBalances>('GET', '/me/balances'),
  /** Add someone you already share a group with (issue #24). */
  addKnownMember: (groupId: string, userId: string) =>
    req<Group>('POST', `/groups/${groupId}/members`, { userId }),

  groups: () => req<{ items: Group[] }>('GET', '/groups'),
  group: (id: string) => req<Group>('GET', `/groups/${id}`),
  createGroup: (name: string, emoji: string, homeCurrency: string, currencies: string[] = []) =>
    req<Group>('POST', '/groups', { name, emoji, homeCurrency, currencies }),
  updateGroup: (id: string, data: { name?: string; emoji?: string; currencies?: string[] }) =>
    req<Group>('PATCH', `/groups/${id}`, data),
  createInvite: (groupId: string, email?: string) =>
    req<{ token: string; expiresAt: string; path: string; emailed: boolean }>(
      'POST', `/groups/${groupId}/invites`, email ? { email } : {}),
  verifyEmail: (token: string) => req<{ ok: true }>('POST', `/auth/verify/${token}`),
  googleConfig: () => req<{ enabled: boolean; clientId: string }>('GET', '/auth/google/config'),
  googleSignIn: (idToken: string) =>
    req<{ token: string; user: User }>('POST', '/auth/google', { idToken, deviceLabel: deviceLabel() }),
  /** Browser half of the mobile sign-in handoff (issue #39): hand Google's proof to the app's pending session. */
  handoffGoogle: (state: string, idToken: string) =>
    req<{ ok: true }>('POST', `/auth/handoff/${state}/google`, { idToken }),
  appleConfig: () => req<{ enabled: boolean; clientId: string }>('GET', '/auth/apple/config'),
  appleSignIn: (idToken: string, displayName?: string) =>
    req<{ token: string; user: User }>('POST', '/auth/apple', {
      idToken, deviceLabel: deviceLabel(), ...(displayName ? { displayName } : {}),
    }),
  resendVerification: () => req<{ ok: true }>('POST', '/me/verify-request'),
  join: (token: string) => req<Group>('POST', `/join/${token}`),

  expenses: (groupId: string, filters: ExpenseFilters = {}, cursor?: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    if (cursor) qs.set('cursor', cursor);
    const q = qs.toString();
    return req<{ items: Expense[]; nextCursor: string | null }>(
      'GET', `/groups/${groupId}/expenses${q ? `?${q}` : ''}`);
  },
  addExpense: (groupId: string, data: object) => req<Expense>('POST', `/groups/${groupId}/expenses`, data),
  updateExpense: (id: string, data: object) => req<Expense>('PATCH', `/expenses/${id}`, data),
  deleteExpense: (id: string) => req<{ ok: true }>('DELETE', `/expenses/${id}`),
  restoreExpense: (id: string) => req<Expense>('POST', `/expenses/${id}/restore`),
  groupTotals: (groupId: string) => req<GroupTotals>('GET', `/groups/${groupId}/totals`),
  groupCategories: (groupId: string) =>
    req<{ overrides: Record<string, CategoryOverride> }>('GET', `/groups/${groupId}/categories`),
  saveGroupCategories: (groupId: string, overrides: Record<string, CategoryOverride>) =>
    req<{ overrides: Record<string, CategoryOverride> }>('PUT', `/groups/${groupId}/categories`, { overrides }),
  deleteAccount: (confirmEmail: string) => req<{ ok: true }>('DELETE', '/me', { confirmEmail }),
  splitwiseApiGroups: (groupId: string, apiKey: string) =>
    req<{ groups: SplitwiseGroup[] }>('POST', `/groups/${groupId}/import/splitwise-api`, { apiKey }),
  splitwiseApiImport: (groupId: string, apiKey: string, swGroupId: number,
    mapping: Record<string, string | { email: string; name: string } | { userId: string }>) =>
    req<ImportResult>('POST', `/groups/${groupId}/import/splitwise-api`, { apiKey, swGroupId, mapping }),
  activity: (groupId: string, cursor?: string) =>
    req<{ items: ActivityItem[]; nextCursor: string | null }>(
      'GET', `/groups/${groupId}/activity${cursor ? `?cursor=${cursor}` : ''}`),
  comments: (expenseId: string) => req<{ items: Comment[] }>('GET', `/expenses/${expenseId}/comments`),
  addComment: (expenseId: string, body: string) =>
    req<Comment>('POST', `/expenses/${expenseId}/comments`, { body }),
  addFriend: (email: string) => req<Group>('POST', '/friends', { email }),
  listSessions: () => req<{ items: Session[] }>('GET', '/me/sessions'),
  revokeSession: (id: string) => req<{ ok: true }>('DELETE', `/me/sessions/${id}`),

  balances: (groupId: string) => req<Balances>('GET', `/groups/${groupId}/balances`),
  settle: (groupId: string, toUserId: string, amountMinor: number, method: string) =>
    req<Settlement>('POST', `/groups/${groupId}/settlements`, { toUserId, amountMinor, method }),
  confirmSettlement: (id: string) => req<Settlement>('POST', `/settlements/${id}/confirm`),
  declineSettlement: (id: string) => req<{ ok: true }>('DELETE', `/settlements/${id}`),
};
