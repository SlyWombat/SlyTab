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
  id: string; email: string; displayName: string; avatar: string;
  defaultCurrency: string;
  paymentHandles: { interacEmail?: string; paypalMe?: string; venmo?: string };
}
export interface Member {
  id: string; displayName: string; avatar: string;
  paymentHandles: User['paymentHandles'];
}
export interface Group {
  id: string; name: string; emoji: string; homeCurrency: string;
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
export interface HomeBalances {
  items: { group: Group; netMinor: number; currency: string }[];
  pendingSettlements: Settlement[];
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
  homeBalances: () => req<HomeBalances>('GET', '/me/balances'),
  group: (id: string) => req<Group>('GET', `/groups/${id}`),
  createGroup: (name: string, emoji: string, homeCurrency: string) =>
    req<Group>('POST', '/groups', { name, emoji, homeCurrency }),
  createInvite: (groupId: string) =>
    req<{ token: string; path: string }>('POST', `/groups/${groupId}/invites`),
  join: (inviteToken: string) => req<Group>('POST', `/join/${inviteToken}`),
  expenses: (groupId: string) =>
    req<{ items: Expense[]; nextCursor: string | null }>('GET', `/groups/${groupId}/expenses`),
  addExpense: (groupId: string, data: object) =>
    req<Expense>('POST', `/groups/${groupId}/expenses`, data),
  balances: (groupId: string) => req<Balances>('GET', `/groups/${groupId}/balances`),
  settle: (groupId: string, toUserId: string, amountMinor: number, method: string) =>
    req<Settlement>('POST', `/groups/${groupId}/settlements`, { toUserId, amountMinor, method }),
  confirmSettlement: (id: string) => req<Settlement>('POST', `/settlements/${id}/confirm`),
};
