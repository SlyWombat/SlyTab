import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { computeSplit, CURRENCIES } from '@slytab/core';
import {
  api, ApiFailure,
  type Balances, type Expense, type Group, type GroupTotals, type Member,
  type ParsedReceipt, type SplitwiseGroup, type User,
} from '../api';
import { Amount, Badge, Sheet } from '../ui';

const CATEGORIES = ['food', 'home', 'travel', 'fun', 'utilities', 'other'] as const;

export function GroupScreen({ groupId, user, onBack }: {
  groupId: string;
  user: User;
  onBack: () => void;
}) {
  const [group, setGroup] = useState<Group | null>(null);
  const [tab, setTab] = useState<'expenses' | 'balances' | 'totals'>('expenses');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [totals, setTotals] = useState<GroupTotals | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [lastDeleted, setLastDeleted] = useState<Expense | null>(null);
  const [inviting, setInviting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [settling, setSettling] = useState<{ to: Member; suggested: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.group(groupId).then(setGroup).catch((e) => setError(e.message));
    api.expenses(groupId).then((r) => setExpenses(r.items)).catch(() => {});
    api.balances(groupId).then(setBalances).catch(() => {});
    api.groupTotals(groupId).then(setTotals).catch(() => {});
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
        <button role="tab" aria-selected={tab === 'totals'} className={tab === 'totals' ? 'on' : ''} onClick={() => setTab('totals')}>Totals</button>
      </div>

      {tab === 'expenses' && (
        <>
          {lastDeleted !== null && (
            <div className="row" style={{ borderColor: 'var(--ss-owe)' }}>
              <div className="grow" style={{ fontSize: 13 }}>Deleted "{lastDeleted.description}"</div>
              <button className="btn sm" onClick={() => {
                api.restoreExpense(lastDeleted.id).then(() => { setLastDeleted(null); reload(); })
                  .catch((err) => setError(err.message));
              }}>Undo</button>
            </div>
          )}
          {expenses.length === 0 && <p className="muted" style={{ padding: 8 }}>No expenses yet — add the first one.</p>}
          {expenses.map((e) => {
            const paid = e.payers.filter((p) => p.userId === user.id).reduce((a, p) => a + p.amountMinor, 0);
            const owed = e.shares.filter((s) => s.userId === user.id).reduce((a, s) => a + s.amountMinor, 0);
            const effect = paid - owed;
            return (
              <button className="row" key={e.id} onClick={() => setEditing(e)}
                title="Edit expense" style={{ textAlign: 'left' }}>
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
              </button>
            );
          })}
        </>
      )}

      {tab === 'totals' && totals !== null && (
        <>
          <div className="hero">
            <div className="cap">Group spending</div>
            <div className="big"><Amount minor={totals.totalMinor} currency={group.homeCurrency} size={28} /></div>
            <div className="sub">All expenses, in {group.homeCurrency}</div>
          </div>
          {totals.byMonth.length > 1 && (
            <>
              <div className="sect">By month</div>
              {totals.byMonth.map((m) => (
                <div className="row" key={m.month}>
                  <div className="grow" style={{ fontSize: 13.5 }}>{m.month}</div>
                  <Amount minor={m.minor} currency={group.homeCurrency} />
                </div>
              ))}
            </>
          )}
          <div className="sect">By category</div>
          {totals.byCategory.map((cat) => (
            <div className="row" key={cat.category}>
              <div className="grow" style={{ fontSize: 13.5 }}>{cat.category}</div>
              <Amount minor={cat.minor} currency={group.homeCurrency} />
            </div>
          ))}
          <div className="sect">Who paid</div>
          {totals.byPayer.map((pr) => (
            <div className="row" key={pr.userId}>
              <Badge id={pr.userId} name={nameOf(pr.userId)} sm />
              <div className="grow" style={{ fontSize: 13.5 }}>{pr.userId === user.id ? 'You' : nameOf(pr.userId)}</div>
              <Amount minor={pr.minor} currency={group.homeCurrency} />
            </div>
          ))}
          <div className="sect">Who consumed</div>
          {totals.byShare.map((sh) => (
            <div className="row" key={sh.userId}>
              <Badge id={sh.userId} name={nameOf(sh.userId)} sm />
              <div className="grow" style={{ fontSize: 13.5 }}>{sh.userId === user.id ? 'You' : nameOf(sh.userId)}</div>
              <Amount minor={sh.minor} currency={group.homeCurrency} />
            </div>
          ))}
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
        {group.archivedAt === null && (
          <button className="btn sm" onClick={() => setImporting(true)}>Import from Splitwise</button>
        )}
      </div>

      {group.archivedAt === null && (
        <button className="fab" aria-label="Add expense" onClick={() => setAdding(true)}>+</button>
      )}
      {adding && (
        <AddExpenseSheet group={group} user={user} onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); reload(); }} />
      )}
      {editing !== null && (
        <AddExpenseSheet group={group} user={user} editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onDeleted={() => { setLastDeleted(editing); setEditing(null); reload(); }} />
      )}
      {inviting && <InviteSheet groupId={group.id} onClose={() => setInviting(false)} />}
      {importing && (
        <ImportSheet group={group} onClose={() => setImporting(false)}
          onDone={() => { setImporting(false); reload(); }} />
      )}
      {settling && (
        <SettleSheet group={group} to={settling.to} suggested={settling.suggested}
          onClose={() => setSettling(null)} onDone={() => { setSettling(null); reload(); }} />
      )}
    </div>
  );
}

// ---- Add expense (ui_requirements §2.5, split math from @slytab/core) ----

function AddExpenseSheet({ group, user, onClose, onSaved, editing = null, onDeleted }: {
  group: Group; user: User; onClose: () => void; onSaved: () => void;
  editing?: Expense | null; onDeleted?: () => void;
}) {
  const [description, setDescription] = useState(editing?.description ?? '');
  const [amountStr, setAmountStr] = useState(editing ? (editing.amountMinor / 100).toFixed(2) : '');
  const [currency, setCurrency] = useState(editing?.currency ?? group.homeCurrency);
  const [date, setDate] = useState(editing?.expenseDate ?? new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<string>(editing?.category ?? 'food');
  const [payerId, setPayerId] = useState(editing?.payers[0]?.userId ?? user.id);
  const [mode, setMode] = useState<'equal' | 'unequal'>(editing ? 'unequal' : 'equal');
  const [included, setIncluded] = useState<Set<string>>(new Set(group.members.map((m) => m.id)));
  const [exact, setExact] = useState<Record<string, string>>(() => {
    if (!editing) return {};
    const out: Record<string, string> = {};
    for (const sh of editing.shares) out[sh.userId] = (sh.amountMinor / 100).toFixed(2);
    return out;
  });
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
      const payload = {
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
      };
      await (editing ? api.updateExpense(editing.id, payload) : api.addExpense(group.id, payload));
      onSaved();
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'FX_RATE_UNAVAILABLE') {
        setNeedsRate(true);
      }
      setError((err as Error).message);
    }
  }

  return (
    <Sheet title={editing ? 'Edit expense' : 'New expense'} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="error" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="field" style={{ flex: 2 }}><span>Amount</span>
            <input className="amt" inputMode="decimal" value={amountStr} placeholder="0.00"
              onChange={(e) => setAmountStr(e.target.value)} required />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
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
          <button className="btn primary" style={{ flex: 2 }} disabled={!valid}>
            {editing ? 'Save changes' : 'Save expense'}
          </button>
        </div>
        {editing && onDeleted && (
          <button type="button" className="btn block" style={{ marginTop: 8, color: 'var(--ss-owe)' }}
            onClick={() => {
              api.deleteExpense(editing.id).then(onDeleted).catch((err) => setError(err.message));
            }}>
            Delete this expense
          </button>
        )}
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
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.createInvite(groupId).then((i) => {
      setLink(`${location.origin}${import.meta.env.BASE_URL}join/${i.token}`);
    });
  }, [groupId]);

  async function sendEmail(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createInvite(groupId, email);
      setSent(email);
      setEmail('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Sheet title="Invite to group" onClose={onClose}>
      {error && <div className="error" role="alert">{error}</div>}
      {sent && <p className="muted" style={{ paddingBottom: 8 }}>Invitation emailed to {sent} ✓</p>}
      <form onSubmit={sendEmail} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, marginBottom: 8 }}><span>Invite by email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="them@example.com" required />
        </label>
        <button className="btn primary" style={{ marginBottom: 8 }}>Send</button>
      </form>
      <div className="sect" style={{ paddingLeft: 0 }}>Or share the link</div>
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

// ---- Splitwise import: pick CSV → map members → import ----

function ImportSheet({ group, onClose, onDone }: {
  group: Group; onClose: () => void; onDone: () => void;
}) {
  const [source, setSource] = useState<'api' | 'csv'>('api');
  const [apiKey, setApiKey] = useState('');
  const [swGroups, setSwGroups] = useState<SplitwiseGroup[] | null>(null);
  const [swGroupId, setSwGroupId] = useState<number | null>(null);
  const [apiMapping, setApiMapping] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<Awaited<ReturnType<typeof api.inspectSplitwise>> | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.importSplitwise>> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function pick(f: File) {
    setBusy(true);
    setError(null);
    try {
      const info = await api.inspectSplitwise(group.id, f);
      setFile(f);
      setInspect(info);
      // Pre-map by name similarity where obvious.
      const auto: Record<string, string> = {};
      for (const name of info.members) {
        const hit = group.members.find((m) =>
          m.displayName.toLowerCase() === name.toLowerCase()
          || name.toLowerCase().startsWith(m.displayName.toLowerCase()));
        if (hit) auto[name] = hit.id;
      }
      setMapping(auto);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (file === null) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importSplitwise(group.id, file, mapping));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadSwGroups() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.splitwiseApiGroups(group.id, apiKey.trim());
      setSwGroups(r.groups);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const swGroup = swGroups?.find((g) => g.id === swGroupId) ?? null;

  async function runApi() {
    if (swGroupId === null) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.splitwiseApiImport(group.id, apiKey.trim(), swGroupId, apiMapping));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const apiComplete = swGroup !== null
    && swGroup.members.every((m) => (apiMapping[String(m.id)] ?? '') !== '')
    && new Set(Object.values(apiMapping)).size === swGroup.members.length;

  const complete = inspect !== null
    && inspect.members.every((m) => (mapping[m] ?? '') !== '')
    && new Set(Object.values(mapping)).size === inspect.members.length;

  return (
    <Sheet title="Import from Splitwise" onClose={onClose}>
      {error && <div className="error" role="alert">{error}</div>}

      {result !== null ? (
        <>
          <p style={{ fontSize: 14, paddingBottom: 8 }}>
            Imported <b>{result.imported.expenses}</b> expenses and{' '}
            <b>{result.imported.settlements}</b> settlements
            {result.imported.skipped > 0 && <> · {result.imported.skipped} personal expenses skipped</>}.
          </p>
          {result.errors.length > 0 && (
            <div className="error">
              {result.errors.length} rows could not be imported:
              <ul style={{ paddingLeft: 18 }}>
                {result.errors.slice(0, 5).map((e, i) => <li key={i} style={{ fontSize: 12 }}>{e}</li>)}
              </ul>
            </div>
          )}
          <button className="btn primary block" onClick={onDone}>Done</button>
        </>
      ) : source === 'api' ? (
        <>
          <div className="tabs">
            <button type="button" className="on">Splitwise account</button>
            <button type="button" onClick={() => setSource('csv')}>CSV file</button>
          </div>
          {swGroups === null ? (
            <>
              <p className="muted" style={{ padding: '8px 0' }}>
                Connect with a Splitwise API key: sign in at{' '}
                <b>secure.splitwise.com/apps</b> → Register your application
                (any name) → copy the <b>API key</b>. It is used for this
                import only and never stored.
              </p>
              <label className="field"><span>Splitwise API key</span>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off" />
              </label>
              <button className="btn primary block" disabled={busy || apiKey.trim() === ''}
                onClick={() => void loadSwGroups()}>
                {busy ? 'Connecting…' : 'Load my Splitwise groups'}
              </button>
            </>
          ) : (
            <>
              <label className="field"><span>Splitwise group</span>
                <select value={swGroupId ?? ''} onChange={(e) => {
                  setSwGroupId(e.target.value === '' ? null : Number(e.target.value));
                  setApiMapping({});
                }}>
                  <option value="">— pick a group —</option>
                  {swGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
              {swGroup !== null && (
                <>
                  <div className="sect" style={{ paddingLeft: 0 }}>Who is who?</div>
                  {swGroup.members.map((m) => (
                    <label className="field" key={m.id}>
                      <span>Splitwise: "{m.name}"</span>
                      <select value={apiMapping[String(m.id)] ?? ''}
                        onChange={(e) => setApiMapping({ ...apiMapping, [String(m.id)]: e.target.value })}>
                        <option value="">— pick a member —</option>
                        {group.members.map((gm) => (
                          <option key={gm.id} value={gm.id}>{gm.displayName}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <button className="btn primary block" disabled={!apiComplete || busy} onClick={() => void runApi()}>
                    {busy ? 'Importing…' : 'Import everything'}
                  </button>
                  <p className="muted" style={{ textAlign: 'center', paddingTop: 8 }}>
                    Exact paid/owed shares come straight from Splitwise;
                    payments become confirmed settlements.
                  </p>
                </>
              )}
            </>
          )}
        </>
      ) : inspect === null ? (
        <>
          <div className="tabs">
            <button type="button" onClick={() => setSource('api')}>Splitwise account</button>
            <button type="button" className="on">CSV file</button>
          </div>
          <p className="muted" style={{ paddingBottom: 10 }}>
            In Splitwise: open the group → Settings → "Export as spreadsheet",
            then pick the CSV here. Everyone in the Splitwise group must
            already be a member of this SlyTab group.
          </p>
          <button className="btn primary block" disabled={busy}
            onClick={() => fileInput.current?.click()}>
            {busy ? 'Reading…' : 'Choose CSV file'}
          </button>
          <input ref={fileInput} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
        </>
      ) : (
        <>
          <p className="muted" style={{ paddingBottom: 8 }}>
            {inspect.expenseRows} expenses · {inspect.paymentRows} payments ·{' '}
            {inspect.currencies.join(', ')}
            {inspect.dateRange && <> · {inspect.dateRange.from} → {inspect.dateRange.to}</>}
          </p>
          <div className="sect" style={{ paddingLeft: 0 }}>Who is who?</div>
          {inspect.members.map((name) => (
            <label className="field" key={name}>
              <span>Splitwise: "{name}"</span>
              <select value={mapping[name] ?? ''}
                onChange={(e) => setMapping({ ...mapping, [name]: e.target.value })}>
                <option value="">— pick a member —</option>
                {group.members.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </select>
            </label>
          ))}
          <button className="btn primary block" disabled={!complete || busy} onClick={run}>
            {busy ? 'Importing…' : 'Import everything'}
          </button>
          <p className="muted" style={{ textAlign: 'center', paddingTop: 8 }}>
            Every row is imported balance-exactly; payments become confirmed
            settlements.
          </p>
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
