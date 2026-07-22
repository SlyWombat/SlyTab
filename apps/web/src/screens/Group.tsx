import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { computeSplit } from '@slytab/core';
import {
  api, ApiFailure,
  type Balances, type Expense, type Group, type Member, type User,
} from '../api';
import { Amount, Badge, Sheet } from '../ui';

const CATEGORIES = ['food', 'home', 'travel', 'fun', 'utilities', 'other'] as const;

export function GroupScreen({ groupId, user, onBack }: {
  groupId: string;
  user: User;
  onBack: () => void;
}) {
  const [group, setGroup] = useState<Group | null>(null);
  const [tab, setTab] = useState<'expenses' | 'balances'>('expenses');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [settling, setSettling] = useState<{ to: Member; suggested: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.group(groupId).then(setGroup).catch((e) => setError(e.message));
    api.expenses(groupId).then((r) => setExpenses(r.items)).catch(() => {});
    api.balances(groupId).then(setBalances).catch(() => {});
  }, [groupId]);
  useEffect(reload, [reload]);

  const memberById = useMemo(
    () => new Map((group?.members ?? []).map((m) => [m.id, m])),
    [group],
  );
  const nameOf = (id: string) => memberById.get(id)?.displayName ?? 'Former member';
  const myNet = balances?.net[user.id] ?? 0;

  if (group === null) {
    return <div className="shell"><div className="header"><button className="btn sm" onClick={onBack}>‹ Back</button></div>{error && <div className="error">{error}</div>}<p className="muted">Loading…</p></div>;
  }

  return (
    <div className="shell">
      <div className="header">
        <button className="btn sm" onClick={onBack}>‹</button>
        <span style={{ fontSize: 24 }} aria-hidden>{group.emoji || '👥'}</span>
        <div>
          <h1 style={{ fontSize: 19 }}>{group.name}</h1>
          <div className="muted">{group.members.length} members · {group.homeCurrency}</div>
        </div>
        <div className="spacer" />
        <div style={{ textAlign: 'right' }}>
          {myNet === 0 ? <span className="muted">settled ✓</span> : <Amount minor={myNet} currency={group.homeCurrency} signed size={16} />}
          <div className="muted" style={{ fontSize: 10.5 }}>your net</div>
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'expenses'} className={tab === 'expenses' ? 'on' : ''} onClick={() => setTab('expenses')}>Expenses</button>
        <button role="tab" aria-selected={tab === 'balances'} className={tab === 'balances' ? 'on' : ''} onClick={() => setTab('balances')}>Balances</button>
      </div>

      {tab === 'expenses' && (
        <>
          {expenses.length === 0 && <p className="muted" style={{ padding: 8 }}>No expenses yet — add the first one.</p>}
          {expenses.map((e) => {
            const paid = e.payers.filter((p) => p.userId === user.id).reduce((a, p) => a + p.amountMinor, 0);
            const owed = e.shares.filter((s) => s.userId === user.id).reduce((a, s) => a + s.amountMinor, 0);
            const effect = paid - owed;
            return (
              <div className="row" key={e.id}>
                <div className="grow">
                  <div className="name">{e.description}</div>
                  <div className="meta">
                    {e.payers.map((p) => nameOf(p.userId)).join(' + ')} paid · {e.expenseDate} · {e.category}
                    {e.fxRate !== null && ` · ${e.currency}@${e.fxRate.toFixed(4)}`}
                  </div>
                </div>
                <div className="right">
                  {effect === 0
                    ? <span className="muted">not involved</span>
                    : <>
                        <Amount minor={effect} currency={e.currency} signed />
                        <span className="dir">{effect > 0 ? 'you lent' : 'you borrowed'}</span>
                      </>}
                </div>
              </div>
            );
          })}
        </>
      )}

      {tab === 'balances' && balances !== null && (
        <>
          {group.members.map((m) => (
            <div className="row" key={m.id}>
              <Badge id={m.id} name={m.displayName} />
              <div className="grow"><div className="name">{m.id === user.id ? 'You' : m.displayName}</div></div>
              <div className="right">
                {(balances.net[m.id] ?? 0) === 0
                  ? <span className="muted">settled ✓</span>
                  : <Amount minor={balances.net[m.id] ?? 0} currency={group.homeCurrency} signed />}
              </div>
            </div>
          ))}
          <div className="sect">Suggested settlements · {balances.plan.length} transfer{balances.plan.length === 1 ? '' : 's'}</div>
          {balances.plan.length === 0 && <p className="muted" style={{ padding: 8 }}>Everyone is settled up ✓</p>}
          {balances.plan.map((tr, i) => (
            <div className="row" key={i}>
              <Badge id={tr.from} name={nameOf(tr.from)} sm />
              <div className="grow" style={{ fontSize: 13.5 }}>
                {tr.from === user.id ? 'You' : nameOf(tr.from)} → {tr.to === user.id ? 'you' : nameOf(tr.to)}{' '}
                <b><Amount minor={tr.amountMinor} currency={group.homeCurrency} /></b>
              </div>
              {tr.from === user.id && memberById.get(tr.to) && (
                <button className="btn primary sm" onClick={() => setSettling({ to: memberById.get(tr.to)!, suggested: tr.amountMinor })}>
                  Settle
                </button>
              )}
            </div>
          ))}
        </>
      )}

      <div style={{ display: 'flex', gap: 8, padding: '16px 0 90px' }}>
        <button className="btn sm" onClick={() => setInviting(true)}>Invite</button>
        <a className="btn sm" style={{ textDecoration: 'none', lineHeight: '32px' }}
          href={`${import.meta.env.BASE_URL}api/v1/groups/${group.id}/export.csv`}>Export CSV</a>
      </div>

      {group.archivedAt === null && (
        <button className="fab" aria-label="Add expense" onClick={() => setAdding(true)}>+</button>
      )}
      {adding && (
        <AddExpenseSheet group={group} user={user} onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); reload(); }} />
      )}
      {inviting && <InviteSheet groupId={group.id} onClose={() => setInviting(false)} />}
      {settling && (
        <SettleSheet group={group} to={settling.to} suggested={settling.suggested}
          onClose={() => setSettling(null)} onDone={() => { setSettling(null); reload(); }} />
      )}
    </div>
  );
}

// ---- Add expense (ui_requirements §2.5, split math from @slytab/core) ----

function AddExpenseSheet({ group, user, onClose, onSaved }: {
  group: Group; user: User; onClose: () => void; onSaved: () => void;
}) {
  const [description, setDescription] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [currency, setCurrency] = useState(group.homeCurrency);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<string>('food');
  const [payerId, setPayerId] = useState(user.id);
  const [mode, setMode] = useState<'equal' | 'unequal'>('equal');
  const [included, setIncluded] = useState<Set<string>>(new Set(group.members.map((m) => m.id)));
  const [exact, setExact] = useState<Record<string, string>>({});
  const [fxOverride, setFxOverride] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsRate, setNeedsRate] = useState(false);

  const amountMinor = Math.round((parseFloat(amountStr) || 0) * 100);

  const shares = useMemo(() => {
    try {
      if (mode === 'equal') {
        const members = group.members.filter((m) => included.has(m.id)).map((m) => ({ id: m.id }));
        if (members.length === 0 || amountMinor <= 0) return null;
        return computeSplit('equal', amountMinor, members);
      }
      const out: Record<string, number> = {};
      for (const m of group.members) {
        const v = Math.round((parseFloat(exact[m.id] ?? '') || 0) * 100);
        if (v > 0) out[m.id] = v;
      }
      return out;
    } catch {
      return null;
    }
  }, [mode, group.members, included, exact, amountMinor]);

  const sharesSum = Object.values(shares ?? {}).reduce((a, b) => a + b, 0);
  const remaining = amountMinor - sharesSum;
  const valid = amountMinor > 0 && description.trim() !== '' && shares !== null
    && Object.keys(shares).length > 0 && remaining === 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || shares === null) return;
    setError(null);
    try {
      await api.addExpense(group.id, {
        description: description.trim(),
        amountMinor,
        currency: currency.toUpperCase(),
        expenseDate: date,
        category,
        splitMethod: mode === 'equal' ? 'equal' : 'exact',
        payers: [{ userId: payerId, amountMinor }],
        shares: Object.entries(shares).map(([userId, v]) => ({ userId, amountMinor: v })),
        ...(fxOverride !== '' ? { fxRateOverride: parseFloat(fxOverride) } : {}),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'FX_RATE_UNAVAILABLE') {
        setNeedsRate(true);
      }
      setError((err as Error).message);
    }
  }

  return (
    <Sheet title="New expense" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="error" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="field" style={{ flex: 2 }}><span>Amount</span>
            <input className="amt" inputMode="decimal" value={amountStr} placeholder="0.00"
              onChange={(e) => setAmountStr(e.target.value)} required />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Currency</span>
            <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
          </label>
        </div>
        {(needsRate || (currency.toUpperCase() !== group.homeCurrency && fxOverride !== '')) && (
          <label className="field"><span>Exchange rate to {group.homeCurrency} (1 {currency.toUpperCase()} = ?)</span>
            <input className="amt" inputMode="decimal" value={fxOverride} onChange={(e) => setFxOverride(e.target.value)} />
          </label>
        )}
        <label className="field"><span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={200} placeholder="Groceries" />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="field" style={{ flex: 1 }}><span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Paid by</span>
          <select value={payerId} onChange={(e) => setPayerId(e.target.value)}>
            {group.members.map((m) => (
              <option key={m.id} value={m.id}>{m.id === user.id ? 'You' : m.displayName}</option>
            ))}
          </select>
        </label>

        <div className="tabs">
          <button type="button" className={mode === 'equal' ? 'on' : ''} onClick={() => setMode('equal')}>Equal</button>
          <button type="button" className={mode === 'unequal' ? 'on' : ''} onClick={() => setMode('unequal')}>Unequal</button>
        </div>

        {group.members.map((m) => (
          <div className="checkrow" key={m.id}>
            {mode === 'equal' && (
              <input type="checkbox" checked={included.has(m.id)}
                onChange={(e) => {
                  const next = new Set(included);
                  e.target.checked ? next.add(m.id) : next.delete(m.id);
                  setIncluded(next);
                }} />
            )}
            <Badge id={m.id} name={m.displayName} sm />
            {m.id === user.id ? 'You' : m.displayName}
            {mode === 'equal'
              ? <span className="amount muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
                  {shares?.[m.id] !== undefined ? (shares[m.id]! / 100).toFixed(2) : '—'}
                </span>
              : <label className="field amt-in" style={{ margin: 0 }}>
                  <input className="amt" inputMode="decimal" placeholder="0.00"
                    value={exact[m.id] ?? ''} onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })} />
                </label>}
          </div>
        ))}
        {mode === 'unequal' && (
          <p className="muted" style={{ padding: '4px 2px', color: remaining === 0 ? 'var(--ss-owed)' : 'var(--ss-owe)' }}>
            remaining: {(remaining / 100).toFixed(2)}
          </p>
        )}
        <button className="btn primary block" disabled={!valid} style={{ marginTop: 8 }}>Save expense</button>
      </form>
    </Sheet>
  );
}

// ---- Invite ----

function InviteSheet({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.createInvite(groupId).then((i) => {
      setLink(`${location.origin}${import.meta.env.BASE_URL}join/${i.token}`);
    });
  }, [groupId]);
  return (
    <Sheet title="Invite to group" onClose={onClose}>
      {link === null ? <p className="muted">Creating link…</p> : (
        <>
          <p style={{ fontSize: 13, wordBreak: 'break-all', background: 'var(--ss-surface-2)', padding: 12, borderRadius: 10 }}>{link}</p>
          <p className="muted" style={{ padding: '8px 0' }}>Anyone with this link can join for 7 days.</p>
          <button className="btn primary block" onClick={() => {
            navigator.clipboard.writeText(link).then(() => setCopied(true));
          }}>{copied ? 'Copied ✓' : 'Copy link'}</button>
        </>
      )}
    </Sheet>
  );
}

// ---- Settle up (FR-7.x — deep links, never holds money) ----

function SettleSheet({ group, to, suggested, onClose, onDone }: {
  group: Group; to: Member; suggested: number; onClose: () => void; onDone: () => void;
}) {
  const [amountStr, setAmountStr] = useState((suggested / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const amountMinor = Math.round((parseFloat(amountStr) || 0) * 100);
  const handles = to.paymentHandles;

  async function record(method: string) {
    setError(null);
    try {
      await api.settle(group.id, to.id, amountMinor, method);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const amountMajor = (amountMinor / 100).toFixed(2);
  return (
    <Sheet title={`You pay ${to.displayName}`} onClose={onClose}>
      {error && <div className="error" role="alert">{error}</div>}
      <label className="field"><span>Amount ({group.homeCurrency})</span>
        <input className="amt" inputMode="decimal" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
      </label>
      {handles.interacEmail && (
        <a className="btn primary block" style={{ textDecoration: 'none', marginBottom: 8 }}
          href={`mailto:${handles.interacEmail}?subject=${encodeURIComponent(`Interac e-Transfer: $${amountMajor}`)}&body=${encodeURIComponent(`Sending you $${amountMajor} for ${group.name} (via SlyTab)`)}`}
          onClick={() => record('interac')}>
          Interac e-Transfer
        </a>
      )}
      {handles.paypalMe && (
        <a className="btn block" style={{ textDecoration: 'none', marginBottom: 8 }}
          href={`https://paypal.me/${handles.paypalMe}/${amountMajor}${group.homeCurrency}`}
          target="_blank" rel="noreferrer" onClick={() => record('paypal')}>
          PayPal.Me
        </a>
      )}
      <button className="btn block" disabled={amountMinor <= 0} onClick={() => record('cash')}>
        Record cash or other
      </button>
      <p className="muted" style={{ textAlign: 'center', padding: '10px 8px 0' }}>
        SlyTab never holds your money — payments happen in your own apps.
        {' '}{to.displayName} confirms when it arrives.
      </p>
    </Sheet>
  );
}
