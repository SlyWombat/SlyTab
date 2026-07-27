/**
 * SlyTab API client for the mobile app. The session token is held in
 * memory for now (sign in per launch); swapping in expo-secure-store is a
 * one-function change here when persistence lands.
 */

import { Platform } from 'react-native';

import type { CategoryOverride } from '@slytab/core';

const BASE = 'https://electricrv.ca/slytab/api/v1';

/**
 * Debug breadcrumbs for in-app bug reports: being inside the app, we can
 * attach diagnostics the user would otherwise have to screenshot — app
 * version/build, OS, and the last few failed API calls ride along with
 * every report automatically.
 */
const recentErrors: string[] = [];
function noteApiError(method: string, path: string, status: number, code: string): void {
  const t = new Date().toISOString().slice(11, 19);
  recentErrors.push(`${method} ${path} → ${status}/${code} @${t}Z`);
  if (recentErrors.length > 5) recentErrors.shift();
}

/**
 * This app's marketing version and build number.
 *
 * Read from versions.json, NOT app.json: the 2026-07-25 per-platform split
 * moved the numbers there and app.config.js injects them at build time, so
 * app.json no longer carries `version`, `ios.buildNumber` or
 * `android.versionCode` at all. Reading the old location silently produced
 * "v?(?)" on every bug report from both platforms (issue #45).
 */
export function appVersion(): { version: string; build: string } {
  try {
    // Metro bundles the JSON; keeps us dependency-free (no expo-constants).
    const versions = require('../versions.json') as {
      ios: { version: string; buildNumber: string };
      android: { version: string; versionCode: number };
    };
    return Platform.OS === 'ios'
      ? { version: versions.ios.version, build: versions.ios.buildNumber }
      : { version: versions.android.version, build: String(versions.android.versionCode) };
  } catch {
    return { version: '?', build: '?' };
  }
}

export function debugContext(): string {
  const { version, build } = appVersion();
  const errs = recentErrors.length > 0 ? ` | recent API errors: ${recentErrors.join('; ')}` : '';
  return `mobile ${Platform.OS} ${Platform.Version} app v${version}(${build})${errs}`.slice(0, 500);
}

let token: string | null = null;
export function setToken(t: string | null): void {
  token = t;
}

export interface ApiError { code: string; message: string }
export class ApiFailure extends Error {
  constructor(public readonly error: ApiError, public readonly status: number) {
    super(error.message);
  }
}

export interface User {
  id: string; email: string; emailVerifiedAt: string | null;
  displayName: string; avatar: string;
  notifyLevel?: 'all' | 'important' | 'none';
  defaultCurrency: string;
  paymentHandles: { interacEmail?: string; paypalMe?: string; venmo?: string };
  /** null until the first-run welcome flow is completed (issue #36). */
  onboardedAt?: string | null;
}
export interface Member {
  id: string; displayName: string; avatar: string;
  paymentHandles: User['paymentHandles'];
}
export interface Group {
  id: string; name: string; emoji: string; homeCurrency: string; currencies: string[];
  isDirect: boolean; archivedAt: string | null; members: Member[];
}
export interface Participant { userId: string; amountMinor: number }
export interface Expense {
  id: string; groupId: string; description: string; amountMinor: number;
  currency: string; fxRate: number | null; expenseDate: string;
  category: string; payers: Participant[]; shares: Participant[];
  splitMethod: string;
  /** Per-member form inputs for shares/percent/adjustment splits, so editing restores them. */
  splitInput?: Record<string, number> | null;
  receiptId: string | null;
  /** All linked receipts (bill + card slip …), primary first. */
  receiptIds: string[];
}
export interface Transfer { from: string; to: string; amountMinor: number }
export interface Balances {
  net: Record<string, number>; plan: Transfer[]; pairwise: Transfer[];
}
export interface Settlement {
  id: string; groupId: string; fromUserId: string; toUserId: string;
  amountMinor: number; currency: string; status: 'pending' | 'confirmed';
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
export interface ExpenseFilters { q?: string; category?: string }
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

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json as { error?: ApiError }).error ?? { code: 'NETWORK', message: 'request failed' };
    noteApiError(method, path.split('?')[0] ?? path, res.status, err.code);
    throw new ApiFailure(err, res.status);
  }
  return json as T;
}

export interface ReceiptItem { name: string; quantity: number; totalMinor: number }
export interface ParsedReceipt {
  merchant: string | null; date: string | null; currency: string | null;
  /** Minor-unit scale of the *Minor fields; older parses omit it. */
  scale?: number | null;
  items: ReceiptItem[]; subtotalMinor: number | null; taxMinor: number | null;
  tipMinor: number | null; totalMinor: number | null;
  confidence: 'high' | 'medium' | 'low';
}
export interface ReceiptResult {
  id: string; groupId: string; parsed: ParsedReceipt | null; parseError?: string;
}

/** Receipt image needs the Bearer token — RN <Image> supports headers. */
export function receiptImageSource(receiptId: string): { uri: string; headers: Record<string, string> } {
  return {
    uri: `${BASE}/receipts/${receiptId}/image`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

/** Progress/cancel hooks for long uploads on slow connections (issue #9). */
export interface UploadHooks {
  onUploadProgress?: (fraction: number) => void;
  onUploaded?: () => void;
}

export interface UploadHandle {
  promise: Promise<ReceiptResult>;
  cancel: () => void;
}

/**
 * Receipt upload with progress + cancel via expo-file-system's upload
 * task (RN fetch cannot report upload progress). The caller shrinks the
 * image first — see shrinkPhoto in App.tsx.
 */
export function uploadReceipt(groupId: string, uri: string, mime: string, hooks: UploadHooks = {}, currencyHint?: string): UploadHandle {
  const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let uploadDone = false;
  const task = FileSystem.createUploadTask(
    `${BASE}/groups/${groupId}/receipts`,
    uri,
    {
      httpMethod: 'POST',
      headers,
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'image',
      mimeType: mime,
      parameters: currencyHint ? { currencyHint } : {},
    },
    ({ totalBytesSent, totalBytesExpectedToSend }) => {
      if (totalBytesExpectedToSend > 0) {
        const fraction = totalBytesSent / totalBytesExpectedToSend;
        hooks.onUploadProgress?.(fraction);
        if (fraction >= 1 && !uploadDone) {
          uploadDone = true;
          hooks.onUploaded?.();
        }
      }
    },
  );
  const promise = task.uploadAsync().then((res) => {
    if (res == null) {
      throw new ApiFailure({ code: 'CANCELED', message: 'upload canceled' }, 0);
    }
    let json: unknown = {};
    try { json = JSON.parse(res.body); } catch { /* non-JSON body */ }
    if (res.status < 200 || res.status >= 300) {
      throw new ApiFailure(
        (json as { error?: ApiError }).error
          ?? { code: 'NETWORK', message: "the upload didn't reach the server — check your connection and try again" },
        res.status,
      );
    }
    return json as ReceiptResult;
  }, (e) => {
    throw e instanceof ApiFailure ? e : new ApiFailure(
      { code: 'NETWORK', message: "the upload didn't reach the server — check your connection and try again" }, 0);
  });
  return { promise, cancel: () => { void task.cancelAsync(); } };
}

/**
 * What "Where you're signed in" shows for this session. Every mobile
 * session used to be labelled 'mobile' and rendered as "Android app", so an
 * iPhone user was told they had signed in from an Android (issue #49).
 */
const DEVICE_LABEL = Platform.OS === 'ios' ? 'ios' : 'android';

export const api = {
  register: (email: string, password: string, displayName: string) =>
    req<{ token: string; user: User }>('POST', '/auth/register', {
      email, password, displayName, deviceLabel: DEVICE_LABEL,
    }),
  login: (email: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/auth/login', {
      email, password, deviceLabel: DEVICE_LABEL,
    }),
  googleConfig: () => req<{ enabled: boolean }>('GET', '/auth/google/config'),
  /**
   * "Sign in with Google" via browser handoff (issue #39): start returns a
   * public state (goes in the browser URL) and a secret verifier (never
   * leaves the app); claim polls until the browser side has signed in.
   */
  handoffStart: () =>
    req<{ state: string; verifier: string; expiresIn: number }>(
      'POST', '/auth/handoff/start', { deviceLabel: DEVICE_LABEL }),
  handoffClaim: (state: string, verifier: string) =>
    req<{ pending?: boolean; token?: string; user?: User }>(
      'POST', '/auth/handoff/claim', { state, verifier }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
  me: () => req<User>('GET', '/me'),
  patchMe: (data: object) => req<User>('PATCH', '/me', data),
  homeBalances: () => req<HomeBalances>('GET', '/me/balances'),
  group: (id: string) => req<Group>('GET', `/groups/${id}`),
  /** Add someone you already share a group with (issue #24). */
  addKnownMember: (groupId: string, userId: string) =>
    req<Group>('POST', `/groups/${groupId}/members`, { userId }),
  archiveGroup: (groupId: string) => req<{ ok: true }>('POST', `/groups/${groupId}/archive`),
  createGroup: (name: string, emoji: string, homeCurrency: string, currencies: string[] = []) =>
    req<Group>('POST', '/groups', { name, emoji, homeCurrency, currencies }),
  updateGroup: (id: string, data: { name?: string; emoji?: string; currencies?: string[] }) =>
    req<Group>('PATCH', `/groups/${id}`, data),
  createInvite: (groupId: string, email?: string) =>
    req<{ token: string; path: string; emailed: boolean }>(
      'POST', `/groups/${groupId}/invites`, email ? { email } : {}),
  resendVerification: () => req<{ ok: true }>('POST', '/me/verify-request'),
  join: (inviteToken: string) => req<Group>('POST', `/join/${inviteToken}`),
  expenses: (groupId: string, filters: ExpenseFilters = {}, cursor?: string) => {
    const parts: string[] = [];
    if (filters.q) parts.push(`q=${encodeURIComponent(filters.q)}`);
    if (filters.category) parts.push(`category=${encodeURIComponent(filters.category)}`);
    if (cursor) parts.push(`cursor=${cursor}`);
    return req<{ items: Expense[]; nextCursor: string | null }>(
      'GET', `/groups/${groupId}/expenses${parts.length > 0 ? `?${parts.join('&')}` : ''}`);
  },
  addExpense: (groupId: string, data: object) =>
    req<Expense>('POST', `/groups/${groupId}/expenses`, data),
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
    mapping: Record<string, string | { email: string; name: string }>) =>
    req<ImportResult>('POST', `/groups/${groupId}/import/splitwise-api`, { apiKey, swGroupId, mapping }),
  activity: (groupId: string, cursor?: string) =>
    req<{ items: ActivityItem[]; nextCursor: string | null }>(
      'GET', `/groups/${groupId}/activity${cursor ? `?cursor=${cursor}` : ''}`),
  comments: (expenseId: string) => req<{ items: Comment[] }>('GET', `/expenses/${expenseId}/comments`),
  addComment: (expenseId: string, body: string) =>
    req<Comment>('POST', `/expenses/${expenseId}/comments`, { body }),
  addFriend: (email: string) => req<Group>('POST', '/friends', { email }),
  registerPushToken: (token: string) => req<{ ok: true }>('POST', '/me/push-tokens', { token }),
  receiptEta: () => req<{ samples: number; typicalMs: number; slowMs: number }>('GET', '/receipts/eta'),
  /** Report a bug from the profile page: comment + optional screenshot. */
  reportBug: async (message: string, image?: { uri: string; mime: string } | null): Promise<{ id: string; status: string; tracking?: string }> => {
    const fd = new FormData();
    fd.append('message', message);
    fd.append('context', debugContext());
    if (image) {
      // React Native FormData file part: { uri, name, type }.
      fd.append('image', {
        uri: image.uri,
        name: `screenshot.${image.mime === 'image/png' ? 'png' : 'jpg'}`,
        type: image.mime,
      } as unknown as Blob);
    }
    const headers: Record<string, string> = {};
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
  fxRate: (base: string, quote: string) =>
    req<{ date: string; base: string; quote: string; rate: number }>(
      'GET', `/rates?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}`),
  listSessions: () => req<{ items: Session[] }>('GET', '/me/sessions'),
  revokeSession: (id: string) => req<{ ok: true }>('DELETE', `/me/sessions/${id}`),
  balances: (groupId: string) => req<Balances>('GET', `/groups/${groupId}/balances`),
  settle: (groupId: string, toUserId: string, amountMinor: number, method: string) =>
    req<Settlement>('POST', `/groups/${groupId}/settlements`, { toUserId, amountMinor, method }),
  confirmSettlement: (id: string) => req<Settlement>('POST', `/settlements/${id}/confirm`),
};
