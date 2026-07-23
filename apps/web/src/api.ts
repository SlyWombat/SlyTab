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

export interface User {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  displayName: string;
  avatar: string;
  defaultCurrency: string;
  paymentHandles: { interacEmail?: string; paypalMe?: string; venmo?: string };
}

export interface Member {
  id: string;
  displayName: string;
  avatar: string;
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
  createdBy: string;
  splitMethod: string;
  payers: Participant[];
  shares: Participant[];
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

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
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

export interface ReceiptItem {
  name: string;
  quantity: number;
  totalMinor: number;
}

export interface ParsedReceipt {
  merchant: string | null;
  date: string | null;
  currency: string | null;
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
function uploadWithProgress<T>(path: string, field: string, blob: Blob, filename: string, hooks: UploadHooks): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fd = new FormData();
    fd.append(field, blob, filename);
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
      email, password, displayName, deviceLabel: 'web',
    }),
  login: (email: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/auth/login', { email, password, deviceLabel: 'web' }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
  resetRequest: (email: string) => req<{ ok: true }>('POST', '/auth/reset-request', { email }),
  resetPassword: (token: string, password: string) =>
    req<{ ok: true }>('POST', '/auth/reset', { token, password }),
  me: () => req<User>('GET', '/me'),
  patchMe: (data: Partial<Pick<User, 'displayName' | 'avatar' | 'defaultCurrency' | 'paymentHandles'>>) =>
    req<User>('PATCH', '/me', data),
  uploadReceipt: async (groupId: string, file: File, hooks: UploadHooks = {}) => {
    const { blob, name } = await shrinkImage(file);
    return uploadWithProgress<ReceiptResult>(`/groups/${groupId}/receipts`, 'image', blob, name, hooks);
  },
  inspectSplitwise: (groupId: string, file: File) =>
    upload<{
      members: string[]; expenseRows: number; paymentRows: number;
      currencies: string[]; dateRange: { from: string; to: string } | null;
    }>(`/groups/${groupId}/import/splitwise`, 'csv', file, { dryRun: '1' }),
  importSplitwise: (groupId: string, file: File, mapping: Record<string, string>) =>
    upload<{
      imported: { expenses: number; settlements: number; skipped: number };
      errors: string[];
    }>(`/groups/${groupId}/import/splitwise`, 'csv', file, { mapping: JSON.stringify(mapping) }),
  homeBalances: () => req<HomeBalances>('GET', '/me/balances'),

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
    req<{ token: string; user: User }>('POST', '/auth/google', { idToken, deviceLabel: 'web' }),
  appleConfig: () => req<{ enabled: boolean; clientId: string }>('GET', '/auth/apple/config'),
  appleSignIn: (idToken: string, displayName?: string) =>
    req<{ token: string; user: User }>('POST', '/auth/apple', {
      idToken, deviceLabel: 'web', ...(displayName ? { displayName } : {}),
    }),
  resendVerification: () => req<{ ok: true }>('POST', '/me/verify-request'),
  join: (token: string) => req<Group>('POST', `/join/${token}`),

  expenses: (groupId: string, cursor?: string) =>
    req<{ items: Expense[]; nextCursor: string | null }>(
      'GET', `/groups/${groupId}/expenses${cursor ? `?cursor=${cursor}` : ''}`),
  addExpense: (groupId: string, data: object) => req<Expense>('POST', `/groups/${groupId}/expenses`, data),
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
  listSessions: () => req<{ items: Session[] }>('GET', '/me/sessions'),
  revokeSession: (id: string) => req<{ ok: true }>('DELETE', `/me/sessions/${id}`),

  balances: (groupId: string) => req<Balances>('GET', `/groups/${groupId}/balances`),
  settle: (groupId: string, toUserId: string, amountMinor: number, method: string) =>
    req<Settlement>('POST', `/groups/${groupId}/settlements`, { toUserId, amountMinor, method }),
  confirmSettlement: (id: string) => req<Settlement>('POST', `/settlements/${id}/confirm`),
  declineSettlement: (id: string) => req<{ ok: true }>('DELETE', `/settlements/${id}`),
};
