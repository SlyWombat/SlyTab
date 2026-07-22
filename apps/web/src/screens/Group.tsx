import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { computeSplit } from '@slytab/core';
import {
  api, ApiFailure,
  type Balances, type Expense, type Group, type Member, type ParsedReceipt, type User,
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
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [assigning, setAssigning] = useState<ParsedReceipt | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const amountMinor = Math.round((parseFloat(amountStr) || 0) * 100);

  async function onScanFile(file: File) {
    setScanBusy(true);
    setError(null);
    try {
      const r = await api.uploadReceipt(group.id, file);
      setReceiptId(r.id);
      if (r.parsed === null) {
        setError(r.parseError ?? 'could not read this receipt — enter it manually (photo attached)');
      } else {
        setAssigning(r.parsed);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanBusy(false);
    }
  }

  function applyAssignment(result: {
    totalMinor: number; currency: string | null; merchant: string | null;
    date: string | null; shares: Record<string, number>;
  }) {
    setAssigning(null);
    setAmountStr((result.totalMinor / 100).toFixed(2));
    if (result.currency && /^[A-Z]{3}$/.test(result.currency)) setCurrency(result.currency);
    if (result.merchant) setDescription(result.merchant);
    if (result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date)) setDate(result.date);
    setMode('unequal');
    const next: Record<string, string> = {};
    for (const [uid, v] of Object.entries(result.shares)) next[uid] = (v / 100).toFixed(2);
    setExact(next);
  }

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
        ...(receiptId !== null ? { receiptId } : {}),
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
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" className="btn" style={{ flex: 1 }} disabled={scanBusy}
            onClick={() => fileInput.current?.click()}>
            {scanBusy ? 'Reading your receipt…' : receiptId ? 'Receipt attached ✓ — rescan' : '📷 Scan receipt'}
          </button>
          <button className="btn primary" style={{ flex: 2 }} disabled={!valid}>Save expense</button>
        </div>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onScanFile(f); e.target.value = ''; }} />
      </form>
      {assigning !== null && (
        <AssignItemsSheet parsed={assigning} members={group.members} user={user}
          onCancel={() => setAssigning(null)} onDone={applyAssignment} />
      )}
    </Sheet>
  );
}

// ---- Receipt item assignment (ui_requirements §2.6 step 4) ----

function AssignItemsSheet({ parsed, members, user, onCancel, onDone }: {
  parsed: ParsedReceipt;
  members: Member[];
  user: User;
  onCancel: () => void;
  onDone: (r: {
    totalMinor: number; currency: string | null; merchant: string | null;
    date: string | null; shares: Record<string, number>;
  }) => void;
}) {
  const [assign, setAssign] = useState<Record<number, Set<string>>>({});

  const itemsSum = parsed.items.reduce((a, i) => a + i.totalMinor, 0);
  const totalMinor = parsed.totalMinor
    ?? itemsSum + (parsed.taxMinor ?? 0) + (parsed.tipMinor ?? 0);
  const extra = totalMinor - itemsSum; // tax + tip + any unparsed delta
  const allAssigned = parsed.items.every((_, i) => (assign[i]?.size ?? 0) > 0);

  function toggle(itemIndex: number, memberId: string) {
    setAssign((prev) => {
      const next = { ...prev };
      const set = new Set(next[itemIndex] ?? []);
      set.has(memberId) ? set.delete(memberId) : set.add(memberId);
      next[itemIndex] = set;
      return next;
    });
  }

  function splitRestEqually() {
    setAssign((prev) => {
      const next = { ...prev };
      parsed.items.forEach((_, i) => {
        if ((next[i]?.size ?? 0) === 0) next[i] = new Set(members.map((m) => m.id));
      });
      return next;
    });
  }

  /** Per-member totals: assigned items split equally per item, then the
   *  tax/tip remainder prorated by item subtotal (largest-remainder). */
  const perMember = useMemo(() => {
    const out: Record<string, number> = {};
    parsed.items.forEach((item, i) => {
      const who = [...(assign[i] ?? [])].sort();
      if (who.length === 0) return;
      const split = computeSplit('equal', item.totalMinor, who.map((id) => ({ id })));
      for (const [id, v] of Object.entries(split)) out[id] = (out[id] ?? 0) + v;
    });
    if (extra !== 0 && Object.keys(out).length > 0) {
      const weights = Object.entries(out)
        .filter(([, v]) => v > 0)
        .map(([id, v]) => ({ id, shares: v }));
      if (weights.length > 0) {
        const prorated = computeSplit('shares', Math.abs(extra), weights);
        for (const [id, v] of Object.entries(prorated)) {
          out[id] = (out[id] ?? 0) + (extra > 0 ? v : -v);
        }
      }
    }
    return out;
  }, [assign, parsed.items, extra]);

  return (
    <Sheet title="Assign items" onClose={onCancel}>
      {parsed.confidence === 'low' && (
        <div className="error" style={{ borderColor: 'var(--ss-owe)' }}>
          The numbers on this receipt don't quite add up — double-check before saving.
        </div>
      )}
      <p className="muted" style={{ paddingBottom: 8 }}>
        {parsed.merchant ?? 'Receipt'}{parsed.date ? ` · ${parsed.date}` : ''} ·
        total {(totalMinor / 100).toFixed(2)}{parsed.currency ? ` ${parsed.currency}` : ''}
        {extra !== 0 && ` (incl. ${(extra / 100).toFixed(2)} tax/tip, prorated)`}
      </p>
      {parsed.items.map((item, i) => (
        <div className="row" key={i} style={{ flexWrap: 'wrap' }}>
          <div className="grow">
            <div className="name">{item.name}</div>
            <div className="meta">{item.quantity !== 1 ? `${item.quantity} × ` : ''}{(item.totalMinor / 100).toFixed(2)}</div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {members.map((m) => {
              const on = assign[i]?.has(m.id) ?? false;
              return (
                <button key={m.id} type="button" onClick={() => toggle(i, m.id)}
                  aria-pressed={on}
                  style={{ background: 'none', border: 'none', padding: 2, opacity: on ? 1 : 0.35,
                    outline: on ? '2px solid var(--ss-brand)' : 'none', borderRadius: '50%' }}>
                  <Badge id={m.id} name={m.displayName} sm />
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!allAssigned && (
        <button type="button" className="btn block" onClick={splitRestEqually}>
          Split the rest equally
        </button>
      )}
      <p className="muted" style={{ padding: '10px 2px' }}>
        {members
          .filter((m) => (perMember[m.id] ?? 0) !== 0)
          .map((m) => `${m.id === user.id ? 'You' : m.displayName} ${((perMember[m.id] ?? 0) / 100).toFixed(2)}`)
          .join(' · ') || 'Tap items, then people.'}
      </p>
      <button type="button" className="btn primary block" disabled={!allAssigned}
        onClick={() => onDone({
          totalMinor, currency: parsed.currency, merchant: parsed.merchant,
          date: parsed.date, shares: perMember,
        })}>
        Continue
      </button>
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
