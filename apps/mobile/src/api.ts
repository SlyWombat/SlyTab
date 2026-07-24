/**
 * SlyTab API client for the mobile app. The session token is held in
 * memory for now (sign in per launch); swapping in expo-secure-store is a
 * one-function change here when persistence lands.
 */

const BASE = 'https://electricrv.ca/slytab/api/v1';

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
  defaultCurrency: string;
  paymentHandles: { interacEmail?: string; paypalMe?: string; venmo?: string };
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
  byPayer: { userId: string; minor: number }[];
  byShare: { userId: string; minor: number }[];
  byMonth: { month: string; minor: number }[];
}
export interface SplitwiseGroup {
  id: number; name: string; members: { id: number; name: string }[];
}
export interface ImportResult {
  imported: { expenses: number; settlements: number; skipped: number };
  invited?: string[];
  errors: string[];
}
export interface Session {
  id: string; deviceLabel: string; createdAt: string; lastSeenAt: string; current: boolean;
}
export interface HomeBalances {
  items: { group: Group; netMinor: number; currency: string }[];
  pendingSettlements: Settlement[];
  total: { minor: number; currency: string; approximate: boolean; excluded: string[] };
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
    throw new ApiFailure(
      (json as { error?: ApiError }).error ?? { code: 'NETWORK', message: 'request failed' },
      res.status,
    );
  }
  return json as T;
}

export interface ReceiptItem { name: string; quantity: number; totalMinor: number }
export interface ParsedReceipt {
  merchant: string | null; date: string | null; currency: string | null;
  items: ReceiptItem[]; subtotalMinor: number | null; taxMinor: number | null;
  tipMinor: number | null; totalMinor: number | null;
  confidence: 'high' | 'medium' | 'low';
}
export interface ReceiptResult {
  id: string; groupId: string; parsed: ParsedReceipt | null; parseError?: string;
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

export const api = {
  register: (email: string, password: string, displayName: string) =>
    req<{ token: string; user: User }>('POST', '/auth/register', {
      email, password, displayName, deviceLabel: 'mobile',
    }),
  login: (email: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/auth/login', {
      email, password, deviceLabel: 'mobile',
    }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
  me: () => req<User>('GET', '/me'),
  patchMe: (data: object) => req<User>('PATCH', '/me', data),
  homeBalances: () => req<HomeBalances>('GET', '/me/balances'),
  group: (id: string) => req<Group>('GET', `/groups/${id}`),
  createGroup: (name: string, emoji: string, homeCurrency: string, currencies: string[] = []) =>
    req<Group>('POST', '/groups', { name, emoji, homeCurrency, currencies }),
  updateGroup: (id: string, data: { name?: string; emoji?: string; currencies?: string[] }) =>
    req<Group>('PATCH', `/groups/${id}`, data),
  createInvite: (groupId: string, email?: string) =>
    req<{ token: string; path: string; emailed: boolean }>(
      'POST', `/groups/${groupId}/invites`, email ? { email } : {}),
  resendVerification: () => req<{ ok: true }>('POST', '/me/verify-request'),
  join: (inviteToken: string) => req<Group>('POST', `/join/${inviteToken}`),
  expenses: (groupId: string) =>
    req<{ items: Expense[]; nextCursor: string | null }>('GET', `/groups/${groupId}/expenses`),
  addExpense: (groupId: string, data: object) =>
    req<Expense>('POST', `/groups/${groupId}/expenses`, data),
  updateExpense: (id: string, data: object) => req<Expense>('PATCH', `/expenses/${id}`, data),
  deleteExpense: (id: string) => req<{ ok: true }>('DELETE', `/expenses/${id}`),
  restoreExpense: (id: string) => req<Expense>('POST', `/expenses/${id}/restore`),
  groupTotals: (groupId: string) => req<GroupTotals>('GET', `/groups/${groupId}/totals`),
  deleteAccount: (confirmEmail: string) => req<{ ok: true }>('DELETE', '/me', { confirmEmail }),
  splitwiseApiGroups: (groupId: string, apiKey: string) =>
    req<{ groups: SplitwiseGroup[] }>('POST', `/groups/${groupId}/import/splitwise-api`, { apiKey }),
  splitwiseApiImport: (groupId: string, apiKey: string, swGroupId: number,
    mapping: Record<string, string | { email: string; name: string }>) =>
    req<ImportResult>('POST', `/groups/${groupId}/import/splitwise-api`, { apiKey, swGroupId, mapping }),
  receiptEta: () => req<{ samples: number; typicalMs: number; slowMs: number }>('GET', '/receipts/eta'),
  listSessions: () => req<{ items: Session[] }>('GET', '/me/sessions'),
  revokeSession: (id: string) => req<{ ok: true }>('DELETE', `/me/sessions/${id}`),
  balances: (groupId: string) => req<Balances>('GET', `/groups/${groupId}/balances`),
  settle: (groupId: string, toUserId: string, amountMinor: number, method: string) =>
    req<Settlement>('POST', `/groups/${groupId}/settlements`, { toUserId, amountMinor, method }),
  confirmSettlement: (id: string) => req<Settlement>('POST', `/settlements/${id}/confirm`),
};
