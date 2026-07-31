/**
 * "My expenses" — every expense your money is in, across all groups (#101).
 *
 * Every other list in SlyTab is scoped to one group, so answering "what have
 * I been spending?" meant opening each group and adding it up by hand.
 *
 * Two scopes, both about money rather than authorship. "I paid" is what left
 * your pocket; "I'm in" is everything you hold a share of, whoever entered
 * it. The owner was explicit that "I paid" means their money being used, not
 * who typed it in — you can enter an expense someone else paid for.
 */

import { useCallback, useEffect, useState } from 'react';
import { formatMinor } from '@slytab/core';
import { api, type Expense } from '../api';
import { Amount, SkeletonRows } from '../ui';
import { Icon } from '../Icon';

type Scope = 'involved' | 'paid';
type Sort = 'newest' | 'oldest' | 'largest' | 'smallest';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
];

interface Summary {
  count: number; totalMinor: number; currency: string; approximate: boolean;
}

export function MyExpenses({ onBack, onOpenGroup, embedded = false }: {
  /** Omitted when embedded — the shell's nav is the way back. */
  onBack?: () => void;
  onOpenGroup: (groupId: string) => void;
  /** Rendered inside the Activity destination rather than as its own screen. */
  embedded?: boolean;
}) {
  const [scope, setScope] = useState<Scope>('involved');
  const [sort, setSort] = useState<Sort>('newest');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Expense[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((append = false, from: string | null = null) => {
    if (!append) setItems(null);
    setError(null);
    api.myExpenses({ scope, sort, q: q.trim() || undefined, cursor: from ?? undefined })
      .then((r) => {
        setItems((prev) => (append && prev ? [...prev, ...r.items] : r.items));
        setSummary(r.summary);
        setCursor(r.nextCursor);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoadingMore(false));
  }, [scope, sort, q]);

  // Debounced so typing in the search box does not fire a request per keypress.
  useEffect(() => {
    const t = setTimeout(() => load(false, null), q === '' ? 0 : 300);
    return () => clearTimeout(t);
  }, [load, q]);

  const body = (
    <>

      {/* Scope: the two readings of "my expenses". Chips rather than a
          dropdown — there are exactly two and both should be one tap away. */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} role="group" aria-label="Which expenses">
        {([['involved', "I'm in"], ['paid', 'I paid']] as const).map(([v, label]) => (
          <button
            key={v}
            className={`btn sm${scope === v ? ' primary' : ''}`}
            aria-pressed={scope === v}
            onClick={() => setScope(v)}
          >
            {label}
          </button>
        ))}
        <span className="grow" />
        <label className="field" style={{ margin: 0, minWidth: 190 }}>
          <span className="sr-only">Search expenses</span>
          <input
            type="search"
            value={q}
            placeholder="Search…"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="field" style={{ margin: 0 }}>
          <span className="sr-only">Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>

      {/* The total is for the whole filtered set, not this page — one that
          changed as you scrolled would be worse than none. */}
      {summary && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted">
            {summary.count === 1 ? '1 expense' : `${summary.count} expenses`}
            {scope === 'paid' ? ' you paid for' : " you're part of"}
          </span>
          <span>
            <b>{formatMinor(summary.totalMinor, summary.currency)}</b>
            {summary.approximate && (
              <span className="muted" title="Converted from more than one currency at the day's rate">
                {' '}≈
              </span>
            )}
          </span>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {items === null ? (
        <SkeletonRows count={5} />
      ) : items.length === 0 ? (
        <div className="row">
          <span className="muted">
            {q.trim() !== ''
              ? `Nothing matches “${q.trim()}”.`
              : scope === 'paid'
                ? "You haven't paid for anything yet."
                : "You're not part of any expenses yet."}
          </span>
        </div>
      ) : (
        <>
          {items.map((e) => (
            <button
              key={e.id}
              className="row rowbtn"
              onClick={() => onOpenGroup(e.groupId)}
              style={{ width: '100%', textAlign: 'left' }}
            >
              <Icon name="receipt" size={18} style={{ opacity: 0.7 }} />
              <div className="grow">
                <div className="name">{e.description}</div>
                <div className="meta">
                  {e.expenseDate}
                  {e.groupName ? ` · ${e.groupName}` : ''}
                </div>
              </div>
              <Amount minor={e.amountMinor} currency={e.currency} />
            </button>
          ))}
          {cursor !== null && (
            <button
              className="btn block"
              disabled={loadingMore}
              onClick={() => { setLoadingMore(true); load(true, cursor); }}
            >
              {loadingMore ? 'Loading…' : 'Show more'}
            </button>
          )}
        </>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <div className="shell">
      <div className="header">
        <button className="btn sm" onClick={onBack} aria-label="Back">
          <Icon name="back" size={16} />
        </button>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="wallet" size={22} /> My expenses
        </h1>
      </div>
      {body}
    </div>
  );
}
