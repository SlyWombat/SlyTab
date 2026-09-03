import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../Icon';
import { allAssigned as allItemsAssigned, assignedShares, categoryLabel, CATEGORY_HEADINGS, computeSplit, convertAcrossMinor, CURRENCIES, CURRENCY_NAMES, currencyForLocation, formatMinor, gpsFromJpeg, GROUP_EMOJI, minorToAmountString, normalizeParsedReceipt, parseAmount, receiptBill, rescaleAmountFields, rescaleAmountString, SplitError, splitInputsFromStored, splitInputsToStored, splitMembersFromInputs, resolveCategories, type CategoryOverride, type SplitMethod } from '@slytab/core';
import {
  api, ApiFailure, getCapabilities,
  type Balances, type Expense, type Group, type GroupTotals, type Member,
  type ActivityItem, type Comment, type ImportResult, type ParsedReceipt, type ReceiptResult,
  type SplitwiseGroup, type User,
} from '../api';
import { foldSummaryLines } from '@slytab/core';
import { CategoriesScreen } from './Categories';
import { cacheKey, swr } from '../cache';
import { Amount, Badge, CurrencyMultiPicker, Mark, Sheet, SkeletonRows } from '../ui';

export type ScanStage =
  | { stage: 'upload'; fraction: number }
  | { stage: 'read'; startedAt: number }
  /** Waiting for a turn at the model (#123): position 1 is next up. */
  | { stage: 'queued'; position: number; etaMs: number; startedAt: number };

export interface ScanEta { typicalMs: number; slowMs: number }

/** Cached historical estimate (issue #9: "look at historical timing"). */
let etaCache: ScanEta | null = null;
export function fetchEta(): void {
  api.receiptEta().then((e) => { if (e.samples > 0) etaCache = e; }).catch(() => {});
}

/**
 * Longer than this in line and the honest thing is to stop spinning and say
 * so: the photo is attached and Rescan is a tap away. Four minutes is a dozen
 * typical parses — if the line is that long, something upstream is wrong and
 * a progress dialog is not the place to find out.
 */
const MAX_QUEUE_WAIT_MS = 4 * 60 * 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ApiFailure({ code: 'CANCELED', message: 'scan canceled' }, 0));
    }, { once: true });
  });
}

/**
 * Wait out the line (#123, requirement 2). A scan that could not start
 * comes back `queued` with a ticket and a time to ask again; this keeps
 * asking — with the ticket, which is what holds the place — showing the
 * position each time, until it is our turn and the answer is a real parse.
 * Cancelling gives the place up so the people behind move up at once.
 *
 * Returns whatever the server finally said. Past MAX_QUEUE_WAIT_MS it returns
 * the queued answer as-is, whose `parseError` already reads correctly.
 */
export async function awaitTurn(
  first: ReceiptResult,
  currencyHint: string | undefined,
  onStage: (s: ScanStage) => void,
  signal?: AbortSignal,
): Promise<ReceiptResult> {
  const startedAt = Date.now();
  let r = first;
  while (r.queued) {
    const q = r.queued;
    if (Date.now() - startedAt > MAX_QUEUE_WAIT_MS) return r;
    onStage({ stage: 'queued', position: q.position, etaMs: q.etaMs, startedAt });
    try {
      await sleep(q.retryAfterMs, signal);
    } catch (e) {
      api.leaveScanQueue(q.ticket).catch(() => {});
      throw e;
    }
    // Next up: the answer to this ask is most likely the parse itself, which
    // takes a while — show "reading" rather than a frozen "1 ahead".
    if (q.ahead === 0) onStage({ stage: 'read', startedAt: Date.now() });
    r = await api.rescanReceipt(r.id, currencyHint, q.ticket);
  }
  return r;
}

/** Staged scan progress (issue #9): upload % → (in line →) reading with elapsed time. */
function BusyOverlay({ scan, onCancel }: { scan: ScanStage; onCancel?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = scan.stage !== 'upload' ? Math.round((Date.now() - scan.startedAt) / 1000) : 0;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14,
      background: 'rgba(8, 12, 22, 0.82)', WebkitBackdropFilter: 'blur(2px)', backdropFilter: 'blur(2px)',
    }} role="status" aria-live="polite">
      <style>{'@keyframes ss-spin { to { transform: rotate(360deg); } }'}</style>
      <div style={{ animation: 'ss-spin 1.2s linear infinite', lineHeight: 0 }}><Mark size={44} /></div>
      {scan.stage === 'upload' ? (
        <>
          <div style={{ fontSize: '0.875rem', color: 'var(--ss-text)' }}>
            Uploading photo… {Math.round(scan.fraction * 100)}%
          </div>
          <div style={{ width: 200, height: 6, borderRadius: 3, background: 'var(--ss-surface-2)' }}>
            <div style={{ width: `${Math.round(scan.fraction * 100)}%`, height: '100%',
              borderRadius: 3, background: 'var(--ss-brand)', transition: 'width .2s' }} />
          </div>
        </>
      ) : scan.stage === 'queued' ? (
        <div style={{ fontSize: '0.875rem', color: 'var(--ss-text)', textAlign: 'center', lineHeight: 1.5 }}>
          Photo saved — in line for the receipt reader
          <br />
          <span style={{ color: 'var(--ss-text-2)' }}>
            {scan.position <= 1 ? 'next up' : `${scan.position - 1} ahead of you`}
            {' · '}about {Math.max(1, Math.round(scan.etaMs / 1000))}s · waited {elapsed}s
          </span>
        </div>
      ) : (
        <div style={{ fontSize: '0.875rem', color: 'var(--ss-text)' }}>
          Reading the receipt… {elapsed}s{' '}
          <span style={{ color: 'var(--ss-text-2)' }}>
            {etaCache !== null && elapsed * 1000 > etaCache.slowMs
              ? '(taking longer than usual — still working)'
              : `(usually ~${Math.max(1, Math.round((etaCache?.typicalMs ?? 15000) / 1000))}s)`}
          </span>
        </div>
      )}
      {onCancel && <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

/** Human phrasing for the activity feed (issue #16). */
function activityText(ev: ActivityItem): string {
  const d = (ev.diff ?? {}) as { description?: string; amount?: number; currency?: string; source?: string };
  const what = d.description ? `"${d.description}"` : `a ${ev.entityType}`;
  switch (ev.verb) {
    case 'created': return 'started the group';
    case 'joined': return 'joined the group';
    case 'left': return 'left the group';
    case 'added': return ev.entityType === 'member' ? 'added a member' : `added ${what}`;
    case 'edited': return ev.entityType === 'group' ? 'updated the group settings' : `edited ${what}`;
    case 'deleted': return `deleted ${what}`;
    case 'restored': return `restored ${what}`;
    case 'settled': return 'recorded a payment';
    case 'received': return 'recorded a payment they were given';
    case 'locked': return 'locked the group for settling up';
    case 'unlocked': return 'unlocked the group';
    case 'confirmed': return 'confirmed a payment';
    case 'declined': return "couldn't find a payment (declined)";
    case 'imported': return `imported from Splitwise${d.source === 'splitwise-api' ? '' : ' (CSV)'}`;
    case 'commented': return `commented on ${what}`;
    default: return `${ev.verb} ${what}`;
  }
}

export function GroupScreen({ groupId, user, onBack }: {
  groupId: string;
  user: User;
  onBack: () => void;
}) {
  const [group, setGroup] = useState<Group | null>(null);
  const [tab, setTab] = useState<'expenses' | 'balances' | 'totals' | 'activity'>('expenses');
  // null until the first fetch lands: [] used to mean both "loading" and
  // "empty", so a group with expenses briefly claimed it had none (#68).
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [feed, setFeed] = useState<ActivityItem[] | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [showByCurrency, setShowByCurrency] = useState(false);
  const [totals, setTotals] = useState<GroupTotals | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [lastDeleted, setLastDeleted] = useState<Expense | null>(null);
  const [inviting, setInviting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Per-group category customisation (#18) — overrides ride on top of the
  // shipped taxonomy; an empty object simply means "all defaults".
  const [catOverrides, setCatOverrides] = useState<Record<string, CategoryOverride>>({});
  const [managingCategories, setManagingCategories] = useState(false);
  const [settling, setSettling] = useState<{ to: Member; suggested: number } | null>(null);
  // #120: tapping someone's balance opens what you can do about it.
  const [memberSheet, setMemberSheet] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Today's group-home → user-home rate, for the fine print under each
  // expense (the user thinks in their own currency, not the group's).
  const [homeRate, setHomeRate] = useState<number | null>(null);

  const groupHome = group?.homeCurrency;
  useEffect(() => {
    if (groupHome === undefined || user.defaultCurrency === groupHome) return;
    api.fxRate(groupHome, user.defaultCurrency)
      .then((r) => setHomeRate(r.rate))
      .catch(() => setHomeRate(null)); // fall back to group-home display
  }, [groupHome, user.defaultCurrency]);

  // Incremented by reload() so the expense list refetches exactly once per
  // refresh. It used to depend on `group` and `feed` — both of which reload()
  // sets — so a single refresh fetched the list three times: once on mount,
  // then again as each of those resolved. The two extras were discarded, and
  // because they were triggered BY earlier responses they cost sequential
  // round trips instead of running alongside the rest.
  const [rev, setRev] = useState(0);

  const ck = (name: string) => cacheKey(user.id, `${name}:${groupId}`);
  const reload = useCallback(() => {
    swr(ck('group'), setGroup, () => api.group(groupId)).catch((e) => setError(e.message));
    swr(ck('balances'), setBalances, () => api.balances(groupId)).catch(() => {});
    swr(ck('totals'), setTotals, () => api.groupTotals(groupId)).catch(() => {});
    swr(ck('feed'), (r) => setFeed(r.items), () => api.activity(groupId)).catch(() => {});
    swr(ck('cats'), (r) => setCatOverrides(r.overrides ?? {}), () => api.groupCategories(groupId))
      .catch(() => {});
    setRev((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, user.id]);
  useEffect(reload, [reload]);

  // Expenses refetch when search/filter change (server-side, debounced), and
  // once per reload via `rev`. Only the unfiltered list is cached: a cached
  // answer for someone else's search term would paint the wrong rows.
  useEffect(() => {
    const plain = search === '' && catFilter === '';
    const t = setTimeout(() => {
      const fetcher = () => api.expenses(groupId, { q: search, category: catFilter });
      const apply = (r: Awaited<ReturnType<typeof fetcher>>) => {
        setExpenses(r.items);
        setNextCursor(r.nextCursor);
      };
      (plain ? swr(ck('expenses'), apply, fetcher) : fetcher().then(apply))
        .catch(() => setExpenses([]));
    }, search !== '' ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, search, catFilter, rev, user.id]);

  const memberById = useMemo(
    () => new Map((group?.members ?? []).map((m) => [m.id, m])),
    [group],
  );
  const nameOf = (id: string) => memberById.get(id)?.displayName ?? 'Former member';
  const myNet = balances?.net[user.id] ?? 0;

  // "Category management can be a separate page" (owner, #18).
  if (group !== null && managingCategories) {
    return (
      <CategoriesScreen group={group} onBack={() => {
        setManagingCategories(false);
        reload();
      }} />
    );
  }

  if (group === null) {
    return <div className="shell"><div className="header"><button className="btn sm" onClick={onBack}><Icon name="back" size={16} /> Back</button></div>{error && <div className="error">{error}</div>}<p className="muted">Loading…</p></div>;
  }

  return (
    <div className="shell">
      <div className="header">
        <button className="btn sm" aria-label="Back" onClick={onBack}><Icon name="back" size={16} /></button>
        <span style={{ fontSize: '1.5rem' }} aria-hidden>{group.emoji || <Icon name="group" size={20} />}</span>
        <button onClick={() => { if (!group.isDirect) setSettingsOpen(true); }} title={group.isDirect ? undefined : 'Group settings'}
          style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0,
            cursor: group.isDirect ? 'default' : 'pointer', minWidth: 0, flex: '0 1 auto' }}>
          <h1 style={{ fontSize: '1.1875rem' }}>
            {group.isDirect
              ? group.members.find((m) => m.id !== user.id)?.displayName ?? 'Friend'
              : group.name}
            {!group.isDirect && <span className="muted" style={{ fontSize: '0.75rem' }}> ✎</span>}
          </h1>
          <div className="muted">
            {group.isDirect ? `just the two of you · ${group.homeCurrency}` : `${group.members.length} member${group.members.length === 1 ? '' : 's'} · ${group.homeCurrency}`}
          </div>
        </button>
        <div className="spacer" />
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {myNet === 0 ? <span className="muted">settled ✓</span> : <Amount minor={myNet} currency={group.homeCurrency} signed size={16} />}
          <div className="muted" style={{ fontSize: '0.65625rem' }}>your net</div>
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {/* #120: a locked trip looks different, because it behaves differently
          — the spending is over, the paying is not. */}
      {group.lockedAt && group.archivedAt === null && (
        <div className="row" style={{ borderColor: 'var(--ss-brand)' }}>
          <div className="grow" style={{ fontSize: '0.84375rem' }}>
            <b>Locked for settling up.</b>
            <div className="muted">No new expenses — record payments until everyone is square.</div>
          </div>
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'expenses'} className={tab === 'expenses' ? 'on' : ''} onClick={() => setTab('expenses')}>Expenses</button>
        <button role="tab" aria-selected={tab === 'balances'} className={tab === 'balances' ? 'on' : ''} onClick={() => setTab('balances')}>Balances</button>
        <button role="tab" aria-selected={tab === 'totals'} className={tab === 'totals' ? 'on' : ''} onClick={() => setTab('totals')}>Totals</button>
        <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
      </div>

      {tab === 'expenses' && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingBottom: 8 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search expenses…"
              style={{ flex: 1, minWidth: 140, background: 'var(--ss-surface-2)', color: 'var(--ss-text)',
                border: '1px solid var(--ss-outline)', borderRadius: 10, padding: '8px 12px',
                font: '400 0.84375rem var(--ss-font-body)' }} />
            {CATEGORY_HEADINGS.map((cat) => (
              <button key={cat} type="button" className="btn sm"
                onClick={() => setCatFilter(catFilter === cat ? '' : cat)}
                style={catFilter === cat ? { background: 'var(--ss-brand)', color: '#fff' } : {}}>
                {categoryLabel(cat, catOverrides)}
              </button>
            ))}
          </div>
          {lastDeleted !== null && (
            <div className="row" style={{ borderColor: 'var(--ss-owe)' }}>
              <div className="grow" style={{ fontSize: '0.8125rem' }}>Deleted "{lastDeleted.description}"</div>
              <button className="btn sm" onClick={() => {
                api.restoreExpense(lastDeleted.id).then(() => { setLastDeleted(null); reload(); })
                  .catch((err) => setError(err.message));
              }}>Undo</button>
            </div>
          )}
          {expenses === null && <SkeletonRows />}
          {expenses !== null && expenses.length === 0 && (
            <p className="muted" style={{ padding: 8 }}>No expenses yet — add the first one.</p>
          )}
          {(expenses ?? []).map((e) => {
            const paid = e.payers.filter((p) => p.userId === user.id).reduce((a, p) => a + p.amountMinor, 0);
            const owed = e.shares.filter((s) => s.userId === user.id).reduce((a, s) => a + s.amountMinor, 0);
            const effect = paid - owed;
            return (
              <button className="row" key={e.id} onClick={() => setEditing(e)}
                title="Edit expense" style={{ textAlign: 'left' }}>
                <div className="grow">
                  <div className="name">{e.description}</div>
                  <div className="meta">
                    {e.payers.map((p) => nameOf(p.userId)).join(' + ')} paid · {e.expenseDate} · {categoryLabel(e.category, catOverrides)}
                    {(() => {
                      // Fine print: the expense's value in the viewer's own
                      // home currency (via the group home rate stored on the
                      // expense, then today's cross rate). Falls back to the
                      // group home value when no cross rate is available.
                      const inGroupHome = e.fxRate !== null
                        ? convertAcrossMinor(e.amountMinor, e.fxRate, e.currency, group.homeCurrency)
                        : (e.currency === group.homeCurrency ? e.amountMinor : null);
                      if (inGroupHome === null) return null;
                      if (user.defaultCurrency !== group.homeCurrency && homeRate !== null
                        && e.currency !== user.defaultCurrency) {
                        const inUserHome = convertAcrossMinor(inGroupHome, homeRate, group.homeCurrency, user.defaultCurrency);
                        return ` · ≈ ${formatMinor(inUserHome, user.defaultCurrency)}`;
                      }
                      return e.fxRate !== null ? ` · ≈ ${formatMinor(inGroupHome, group.homeCurrency)}` : null;
                    })()}
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
          {nextCursor !== null && (
            <button type="button" className="btn block" onClick={() => {
              api.expenses(groupId, { q: search, category: catFilter }, nextCursor)
                .then((r) => { setExpenses([...(expenses ?? []), ...r.items]); setNextCursor(r.nextCursor); })
                .catch(() => {});
            }}>Show older expenses</button>
          )}
        </>
      )}

      {tab === 'activity' && (
        <>
          {feed === null && <SkeletonRows />}
          {feed !== null && feed.length === 0 && <p className="muted" style={{ padding: 8 }}>Nothing yet.</p>}
          {(feed ?? []).map((ev) => (
            <div className="row" key={ev.id}>
              <Badge id={ev.userId} name={nameOf(ev.userId)} sm />
              <div className="grow" style={{ fontSize: '0.8125rem' }}>
                <b>{ev.userId === user.id ? 'You' : nameOf(ev.userId)}</b>{' '}
                {activityText(ev)}
                <div className="meta">{ev.createdAt}</div>
              </div>
            </div>
          ))}
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
                  <div className="grow" style={{ fontSize: '0.84375rem' }}>{m.month}</div>
                  <Amount minor={m.minor} currency={group.homeCurrency} />
                </div>
              ))}
            </>
          )}
          <div className="sect">By category</div>
          {totals.byHeading.map((h) => (
            <div key={h.category}>
              <div className="row">
                <div className="grow" style={{ fontSize: '0.84375rem' }}>{categoryLabel(h.category, catOverrides)}</div>
                <Amount minor={h.minor} currency={group.homeCurrency} />
              </div>
              {/* Leaves under this heading, so the roll-up stays explorable. */}
              {totals.byCategory
                .filter((c) => c.category.startsWith(`${h.category}.`))
                .map((c) => (
                  <div className="row" key={c.category} style={{ paddingLeft: 18 }}>
                    <div className="grow muted" style={{ fontSize: '0.8125rem' }}>
                      {categoryLabel(c.category, catOverrides)}
                    </div>
                    <Amount minor={c.minor} currency={group.homeCurrency} />
                  </div>
                ))}
            </div>
          ))}
          <div className="sect">Who paid</div>
          {totals.byPayer.map((pr) => (
            <div className="row" key={pr.userId}>
              <Badge id={pr.userId} name={nameOf(pr.userId)} sm />
              <div className="grow" style={{ fontSize: '0.84375rem' }}>{pr.userId === user.id ? 'You' : nameOf(pr.userId)}</div>
              <Amount minor={pr.minor} currency={group.homeCurrency} />
            </div>
          ))}
          <div className="sect">Who consumed</div>
          {totals.byShare.map((sh) => (
            <div className="row" key={sh.userId}>
              <Badge id={sh.userId} name={nameOf(sh.userId)} sm />
              <div className="grow" style={{ fontSize: '0.84375rem' }}>{sh.userId === user.id ? 'You' : nameOf(sh.userId)}</div>
              <Amount minor={sh.minor} currency={group.homeCurrency} />
            </div>
          ))}
        </>
      )}

      {tab === 'balances' && balances !== null && (
        <>
          {/* #120: the balance is the button. Someone saying "here is $20
              toward my tab" happens at the table, not in a menu three taps
              down, and the person owed is the one holding the phone. */}
          {group.members.map((m) => {
            const row = (
              <>
                <Badge id={m.id} name={m.displayName} hasAvatar={m.hasAvatar} avatarVersion={m.avatarVersion} />
                <div className="grow"><div className="name">{m.id === user.id ? 'You' : m.displayName}</div></div>
                <div className="right">
                  {(balances.net[m.id] ?? 0) === 0
                    ? <span className="muted">settled ✓</span>
                    : <Amount minor={balances.net[m.id] ?? 0} currency={group.homeCurrency} signed />}
                </div>
              </>
            );
            return m.id === user.id || group.archivedAt !== null
              ? <div className="row" key={m.id}>{row}</div>
              : (
                // No aria-label: the row's own content (name + balance) is a
                // better accessible name than "settle up with Alice", which
                // drops the number a screen-reader user came for.
                <button className="row" key={m.id} onClick={() => setMemberSheet(m)}>
                  {row}
                </button>
              );
          })}
          {/* #106: what you owe in each currency, unconverted. Splitwise makes
              this the default and charges to convert; we convert by default,
              because one number to settle beats two — but someone who would
              rather settle each currency in its own should be able to see it. */}
          {balances.byCurrency && Object.keys(balances.byCurrency).length > 0 && (
            <>
              <button className="btn block" style={{ marginTop: 10 }}
                aria-expanded={showByCurrency}
                onClick={() => setShowByCurrency((v) => !v)}>
                {showByCurrency ? 'Hide' : 'Show'} balances per currency
              </button>
              {showByCurrency && Object.entries(balances.byCurrency).map(([cur, rows]) => (
                <div key={cur}>
                  <div className="sect">{cur} — as spent, not converted</div>
                  {group.members.filter((m) => (rows[m.id] ?? 0) !== 0).map((m) => (
                    <div className="row" key={`${cur}-${m.id}`}>
                      <Badge id={m.id} name={m.displayName} hasAvatar={m.hasAvatar} avatarVersion={m.avatarVersion} sm />
                      <div className="grow"><div className="name">
                        {m.id === user.id ? 'You' : m.displayName}</div></div>
                      <div className="right">
                        <Amount minor={rows[m.id] ?? 0} currency={cur} signed />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
          <div className="sect">Suggested settlements · {balances.plan.length} transfer{balances.plan.length === 1 ? '' : 's'}</div>
          {balances.plan.length === 0 && <p className="muted" style={{ padding: 8 }}>Everyone is settled up ✓</p>}
          {balances.plan.map((tr, i) => (
            <div className="row" key={i}>
              <Badge id={tr.from} name={nameOf(tr.from)} sm />
              <div className="grow" style={{ fontSize: '0.84375rem' }}>
                {tr.from === user.id ? 'You' : nameOf(tr.from)} → {tr.to === user.id ? 'you' : nameOf(tr.to)}{' '}
                <b><Amount minor={tr.amountMinor} currency={group.homeCurrency} /></b>
              </div>
              {tr.from === user.id && memberById.get(tr.to) && (
                <button className="btn primary sm" onClick={() => setSettling({ to: memberById.get(tr.to)!, suggested: tr.amountMinor })}>
                  Settle
                </button>
              )}
              {/* The other end of the same row: money owed to you is
                  something you can act on too (#120). */}
              {tr.to === user.id && memberById.get(tr.from) && group.archivedAt === null && (
                <button className="btn sm" onClick={() => setMemberSheet(memberById.get(tr.from)!)}>
                  {!group.lockedAt ? 'Received' : 'Settle up'}
                </button>
              )}
            </div>
          ))}
        </>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '16px 84px 90px 0' }}>
        {!group.isDirect && <button className="btn sm" onClick={() => setInviting(true)}>Invite</button>}
        <a className="btn sm" style={{ textDecoration: 'none', lineHeight: '32px' }}
          href={`${import.meta.env.BASE_URL}api/v1/groups/${group.id}/export.csv`}>Export CSV</a>
        {group.archivedAt === null && !group.lockedAt && (
          <button className="btn sm" onClick={() => setImporting(true)}>Import from Splitwise</button>
        )}
        <button className="btn sm" onClick={() => setManagingCategories(true)}>Categories</button>
      </div>

      {group.archivedAt === null && !group.lockedAt && (
        <button className="fab" aria-label="Add expense" onClick={() => setAdding(true)}>+</button>
      )}
      {adding && (
        <AddExpenseSheet group={group} user={user} onClose={() => setAdding(false)}
          lastCurrency={expenses?.[0]?.currency}
          onSaved={() => { setAdding(false); reload(); }} />
      )}
      {editing !== null && (
        <AddExpenseSheet group={group} user={user} editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
          onDeleted={() => { setLastDeleted(editing); setEditing(null); reload(); }} />
      )}
      {inviting && <InviteSheet group={group} user={user} onClose={() => setInviting(false)} onChanged={reload} />}
      {settingsOpen && (
        <GroupSettingsSheet group={group} onClose={() => setSettingsOpen(false)}
          // Best guess at "nothing here": an unfiltered empty page. The server
          // has the real say — it also counts deleted expenses, which this
          // cannot see — so the offer is hidden on a guess but refused on fact.
          looksEmpty={expenses !== null && expenses.length === 0 && search === '' && catFilter === ''}
          onSaved={() => { setSettingsOpen(false); reload(); }}
          onDeleted={onBack} />
      )}
      {importing && (
        <ImportSheet group={group} user={user} onClose={() => setImporting(false)}
          onDone={() => { setImporting(false); reload(); }} />
      )}
      {settling && (
        <SettleSheet group={group} to={settling.to} suggested={settling.suggested}
          onClose={() => setSettling(null)} onDone={() => { setSettling(null); reload(); }} />
      )}
      {memberSheet && balances !== null && (
        <MemberSheet group={group} user={user} member={memberSheet} balances={balances}
          onClose={() => setMemberSheet(null)}
          onDone={() => { setMemberSheet(null); reload(); }}
          onPay={(suggested) => { setSettling({ to: memberSheet, suggested }); setMemberSheet(null); }} />
      )}
    </div>
  );
}

// ---- Add expense (ui_requirements §2.5, split math from @slytab/core) ----
// Exported so Home can open it directly for the quick-add flow (issue #20).

export function AddExpenseSheet({ group, user, onClose, onSaved, editing = null, onDeleted, lastCurrency }: {
  group: Group; user: User; onClose: () => void; onSaved: () => void;
  editing?: Expense | null; onDeleted?: () => void; lastCurrency?: string;
}) {
  const [description, setDescription] = useState(editing?.description ?? '');
  const [notes, setNotes] = useState((editing as (Expense & { notes?: string | null }) | null)?.notes ?? '');
  // This sheet opens from Home's quick-add as well as the group screen, so
  // it fetches the group's category overrides itself (#18).
  const [catOverrides, setCatOverrides] = useState<Record<string, CategoryOverride>>({});
  useEffect(() => {
    let live = true;
    api.groupCategories(group.id)
      .then((r) => live && setCatOverrides(r.overrides ?? {}))
      .catch(() => {}); // defaults are a fine fallback
    return () => { live = false; };
  }, [group.id]);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentText, setCommentText] = useState('');
  const [amountStr, setAmountStr] = useState(editing ? minorToAmountString(editing.amountMinor, editing.currency) : '');
  // New expenses start in whatever currency the group used last — mid-trip
  // you keep paying in the local currency (user feedback).
  const [currency, setCurrency] = useState(editing?.currency ?? lastCurrency ?? group.homeCurrency);
  const [date, setDate] = useState(editing?.expenseDate ?? new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<string>(editing?.category ?? 'dining');
  const [payerId, setPayerId] = useState(editing?.payers[0]?.userId ?? user.id);
  // FR-3.3 (issue #14): an expense can be paid by several people. Single
  // payer stays the default; "Multiple people…" swaps the select for
  // per-member amount inputs that must sum to the total (same
  // reconciliation rule as the exact split). Editing a multi-payer
  // expense re-opens in that mode instead of collapsing to payers[0].
  const [multiPayer, setMultiPayer] = useState((editing?.payers.length ?? 0) > 1);
  const [payerAmounts, setPayerAmounts] = useState<Record<string, string>>(() => {
    if (!editing) return {};
    const out: Record<string, string> = {};
    for (const p of editing.payers) out[p.userId] = minorToAmountString(p.amountMinor, editing.currency);
    return out;
  });
  // FR-3.2 (issue #13): all five split methods. Editing re-opens on the
  // stored method; shares/percent/adjustment restore their form inputs
  // from the persisted splitInput (legacy rows without one fall back to
  // the data-faithful exact view).
  const [method, setMethod] = useState<SplitMethod>(() => {
    if (!editing) return 'equal';
    const m = editing.splitMethod as SplitMethod;
    if (m === 'equal' || m === 'exact') return m;
    return editing.splitInput ? m : 'exact';
  });
  const [included, setIncluded] = useState<Set<string>>(() =>
    editing && editing.splitMethod === 'equal'
      ? new Set(editing.shares.map((sh) => sh.userId))
      : new Set(group.members.map((m) => m.id)));
  const [exact, setExact] = useState<Record<string, string>>(() => {
    if (!editing) return {};
    const out: Record<string, string> = {};
    for (const sh of editing.shares) out[sh.userId] = minorToAmountString(sh.amountMinor, editing.currency);
    return out;
  });
  // Per-member form inputs for the weighted methods, kept separately so
  // flipping between tabs doesn't reinterpret 33.3 shares as 33.3%.
  const [weights, setWeights] = useState<Record<string, Record<string, string>>>(() => {
    const m = editing?.splitMethod as SplitMethod | undefined;
    if (editing?.splitInput && (m === 'shares' || m === 'percent' || m === 'adjustment')) {
      return { [m]: splitInputsFromStored(m, editing.splitInput, editing.currency) };
    }
    return {};
  });
  const [fxOverride, setFxOverride] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsRate, setNeedsRate] = useState(false);
  // Save is disabled while a create is in flight, and once the server says
  // this looks like a duplicate the button becomes an explicit confirm (#76).
  const [saving, setSaving] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  // Seed from the expense being edited so a previously scanned receipt
  // stays linked on save and can be viewed/rescanned here.
  const [receiptId, setReceiptId] = useState<string | null>(editing?.receiptId ?? null);
  const [extraReceiptIds, setExtraReceiptIds] = useState<string[]>(
    editing ? (editing.receiptIds ?? []).filter((id) => id !== editing.receiptId) : [],
  );
  const [viewing, setViewing] = useState<{ ids: string[]; idx: number; url: string | null } | null>(null);
  const [scan, setScan] = useState<ScanStage | null>(null);
  const scanAbort = useRef<AbortController | null>(null);
  // Receipt scanning depends on a self-hosted vision model, so it is a capability
  // rather than a constant (#123). Shown DISABLED WITH A REASON rather than hidden
  // (owner, 2026-09-01): a button that vanishes teaches nobody the feature exists.
  // Starts available so the control never flickers out from under a tap on the
  // common path where the service is up.
  const [scanCap, setScanCap] = useState<{ available: boolean; reason: string | null }>(
    { available: true, reason: null },
  );
  useEffect(() => {
    let alive = true;
    void getCapabilities().then((c) => { if (alive) setScanCap(c.receiptScanning); });
    return () => { alive = false; };
  }, []);
  const scanOff = !scanCap.available;
  const [assigning, setAssigning] = useState<ParsedReceipt | null>(null);
  // Kept so "Split by item" stays available without re-scanning. A scan
  // fills the form directly now: it used to drop you into item assignment,
  // so every receipt cost an extra decision before it could be saved
  // (owner, 2026-07-27).
  const [lastParsed, setLastParsed] = useState<ParsedReceipt | null>(null);
  /** What the scan could not do, shown where the scan happened (owner, 2026-08-01). */
  const [scanNote, setScanNote] = useState<{ tone: 'warn' | 'bad'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scanBusy = scan !== null;

  const amountMinor = parseAmount(amountStr, currency);

  useEffect(() => {
    if (editing) api.comments(editing.id).then((r) => setComments(r.items)).catch(() => {});
  }, [editing]);

  async function onScanFile(file: File) {
    setScan({ stage: 'upload', fraction: 0 });
    scanAbort.current = new AbortController();
    setError(null);
    fetchEta();
    try {
      // Issue #32: PDFs (emailed receipts) render to a JPEG first, then
      // ride the normal image pipeline.
      const pdf = await import('../pdf');
      if (pdf.isPdf(file)) file = await pdf.pdfFirstPageToJpeg(file);
      // Issue #21 (and #9 item 1): the photo's EXIF GPS knows what
      // country the receipt is from — a better currency hint than the
      // form's current pick. Must read the ORIGINAL bytes (shrinking
      // strips EXIF); screenshots/PNGs just yield null.
      const gps = gpsFromJpeg(await file.arrayBuffer());
      const localCurrency = gps !== null ? currencyForLocation(gps.lat, gps.lon) : null;
      const hint = localCurrency ?? currency;
      const r = await awaitTurn(await api.uploadReceipt(group.id, file, {
        onUploadProgress: (fraction) => setScan({ stage: 'upload', fraction }),
        onUploaded: () => setScan({ stage: 'read', startedAt: Date.now() }),
        signal: scanAbort.current.signal,
      }, hint), hint, setScan, scanAbort.current.signal);
      setReceiptId(r.id);
      if (r.parsed === null) {
        setError(r.parseError ?? 'could not read this receipt — enter it manually (photo attached)');
      } else {
        // Pin the parse to a definite currency before any math on it: a
        // parse without one is scaled at 100, which is 100x off for
        // zero-decimal currencies (the 95,000,000-peso Boragó).
        applyParse(r.parsed);
      }
    } catch (err) {
      if (!(err instanceof ApiFailure && err.error.code === 'CANCELED')) {
        setError((err as Error).message);
      }
    } finally {
      setScan(null);
    }
  }

  /** Re-run the parser on the stored photo — no re-photographing. */
  async function onRescan() {
    if (receiptId === null) return;
    setScan({ stage: 'read', startedAt: Date.now() });
    scanAbort.current = new AbortController();
    setError(null);
    fetchEta();
    try {
      const r = await awaitTurn(await api.rescanReceipt(receiptId, currency), currency, setScan, scanAbort.current.signal);
      if (r.parsed === null) {
        setError(r.parseError ?? 'could not read this receipt');
      } else {
        applyParse(r.parsed);
      }
    } catch (err) {
      if (!(err instanceof ApiFailure && err.error.code === 'CANCELED')) {
        setError((err as Error).message);
      }
    } finally {
      setScan(null);
    }
  }

  async function openReceiptView(idx: number) {
    const ids = [receiptId, ...extraReceiptIds].filter((x): x is string => x !== null);
    if (ids.length === 0) return;
    const i = ((idx % ids.length) + ids.length) % ids.length;
    setViewing((v) => {
      if (v?.url) URL.revokeObjectURL(v.url);
      return { ids, idx: i, url: null };
    });
    try {
      const url = await api.receiptImageUrl(ids[i]!);
      setViewing((v) => (v === null ? v : { ...v, url }));
    } catch (err) {
      setViewing(null);
      setError((err as Error).message);
    }
  }

  function closeReceiptView() {
    setViewing((v) => {
      if (v?.url) URL.revokeObjectURL(v.url);
      return null;
    });
  }

  /**
   * Put a parse into the form: merchant, total, currency, date. The split
   * is deliberately left alone, so it stays on the default equal split and
   * the next thing the user does is press Save.
   */
  function applyParse(parsed: ParsedReceipt) {
    const cur = parsed.currency && /^[A-Z]{3}$/.test(parsed.currency) ? parsed.currency : currency;
    const raw = normalizeParsedReceipt(parsed, cur);
    // A card slip prints its totals as line items. Move those into the fields
    // they belong in before anything reads the item list, or the assign-items
    // screen offers to split "IVA" between four people.
    const fold = foldSummaryLines(raw.items, raw.taxMinor, raw.tipMinor);
    const pinned = { ...raw, items: fold.items, taxMinor: fold.taxMinor, tipMinor: fold.tipMinor };
    setLastParsed(pinned);

    // A parse that finds the lines but not the printed total used to set no
    // amount at all and say nothing, so the form sat at zero looking like the
    // scan had simply failed. receiptBill already reconstructs the bill from
    // the items — use it, and say plainly that is what happened, because a
    // number we added up ourselves deserves more suspicion than one we read.
    const bill = receiptBill(pinned);
    const total = pinned.totalMinor ?? (pinned.items.length > 0 ? bill.billTotal : null);
    if (total !== null) setAmountStr(minorToAmountString(total, cur));

    const money = (m: number) => `${minorToAmountString(m, cur)}${cur ? ` ${cur}` : ''}`;
    setScanNote(
      fold.allSummary && total !== null
        ? {
          tone: 'warn',
          text: `This looks like a card slip rather than an itemised bill — every line on it was a `
            + `summary (${fold.removed.map((r) => r.name.replace(/[:\s]+$/, '')).join(', ')}), so there is `
            + `nothing to split by item. The total of ${money(total)} is what it says.`,
        }
        : pinned.items.length === 0 && total === null
          ? { tone: 'bad', text: 'We could not read anything usable from that photo. Enter the amount yourself, or take another picture with the whole receipt in frame.' }
          : pinned.totalMinor === null
            ? {
              tone: 'warn',
              text: `We could not find a printed total, so we added up the ${pinned.items.length} `
                + `line${pinned.items.length === 1 ? '' : 's'} we did read: ${money(bill.billTotal)}. `
                + 'Check that against the receipt before saving — anything we missed is missing from that number too.',
            }
            : pinned.confidence === 'low'
              ? {
                tone: 'warn',
                text: `We read a total of ${money(pinned.totalMinor)}, but the lines we found only come to `
                  + `${money(bill.itemsSum)}. Worth a look before saving.`,
              }
              : null,
    );

    if (pinned.currency && /^[A-Z]{3}$/.test(pinned.currency)) setCurrency(pinned.currency);
    if (pinned.merchant) setDescription(pinned.merchant);
    if (pinned.date && /^\d{4}-\d{2}-\d{2}$/.test(pinned.date)) setDate(pinned.date);
  }

  function applyAssignment(result: {
    totalMinor: number; currency: string | null; merchant: string | null;
    date: string | null; shares: Record<string, number>; receiptIds: string[];
  }) {
    setAssigning(null);
    setExtraReceiptIds(result.receiptIds);
    const cur = result.currency && /^[A-Z]{3}$/.test(result.currency) ? result.currency : currency;
    setAmountStr(minorToAmountString(result.totalMinor, cur));
    if (result.currency && /^[A-Z]{3}$/.test(result.currency)) setCurrency(result.currency);
    if (result.merchant) setDescription(result.merchant);
    if (result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date)) setDate(result.date);
    setMethod('exact');
    const next: Record<string, string> = {};
    for (const [uid, v] of Object.entries(result.shares)) next[uid] = minorToAmountString(v, cur);
    setExact(next);
  }

  // Split result per member, plus the SplitError message as the form
  // hint when the inputs don't reconcile yet.
  const { shares, splitHint } = useMemo((): { shares: Record<string, number> | null; splitHint: string | null } => {
    if (amountMinor <= 0) return { shares: null, splitHint: null };
    try {
      if (method === 'exact') {
        const out: Record<string, number> = {};
        for (const m of group.members) {
          const v = parseAmount(exact[m.id] ?? '', currency);
          if (v > 0) out[m.id] = v;
        }
        return { shares: out, splitHint: null }; // "remaining" line covers the hint
      }
      const ids = method === 'equal'
        ? group.members.filter((m) => included.has(m.id)).map((m) => m.id)
        : group.members.map((m) => m.id);
      if (ids.length === 0) return { shares: null, splitHint: 'pick at least one person' };
      const computed = computeSplit(method, amountMinor,
        splitMembersFromInputs(method, ids, weights[method] ?? {}, currency));
      const out: Record<string, number> = {};
      for (const [id, v] of Object.entries(computed)) if (v > 0) out[id] = v;
      return { shares: out, splitHint: null };
    } catch (err) {
      return { shares: null, splitHint: err instanceof SplitError ? err.message : null };
    }
  }, [method, group.members, included, exact, weights, amountMinor, currency]);

  const sharesSum = Object.values(shares ?? {}).reduce((a, b) => a + b, 0);
  const remaining = amountMinor - sharesSum;

  const payers = useMemo((): { userId: string; amountMinor: number }[] => {
    if (!multiPayer) return [{ userId: payerId, amountMinor }];
    const out: { userId: string; amountMinor: number }[] = [];
    for (const m of group.members) {
      const v = parseAmount(payerAmounts[m.id] ?? '', currency);
      if (v > 0) out.push({ userId: m.id, amountMinor: v });
    }
    return out;
  }, [multiPayer, payerId, amountMinor, payerAmounts, group.members, currency]);
  const payersRemaining = amountMinor - payers.reduce((a, p) => a + p.amountMinor, 0);

  const valid = amountMinor > 0 && description.trim() !== '' && shares !== null
    && Object.keys(shares).length > 0 && remaining === 0
    && payers.length > 0 && payersRemaining === 0;

  /**
   * Why can Save not go through? Every reason `valid` covers, in the order the
   * form reads, in words.
   *
   * Until this existed the button was simply disabled and said nothing, so a
   * form that looked complete just did not respond. Reported 2026-09-03 on the
   * phone: a scan whose merchant came back empty left Description blank behind
   * its grey placeholder, and Save was dead with no way to find out why. The
   * "remaining:" counters only appear for some split methods, and only above
   * the fold.
   */
  const saveHint = useMemo((): string | null => {
    if (amountMinor <= 0) return 'enter an amount';
    if (description.trim() === '') return 'a description is required';
    if (shares === null || Object.keys(shares).length === 0) {
      return splitHint ?? 'pick who is in the split';
    }
    if (remaining !== 0) {
      return `the shares are ${minorToAmountString(Math.abs(remaining), currency)} `
        + `${remaining > 0 ? 'short of' : 'over'} the amount`;
    }
    if (payers.length === 0) return 'pick who paid';
    if (payersRemaining !== 0) {
      return `what the payers put in is ${minorToAmountString(Math.abs(payersRemaining), currency)} `
        + `${payersRemaining > 0 ? 'short of' : 'over'} the amount`;
    }
    return null;
  }, [amountMinor, description, shares, splitHint, remaining, payers.length, payersRemaining, currency]);
  // Shown once Save has been pressed, not while the form is still being filled
  // in — a hint that appears before you have done anything is nagging.
  const [saveTried, setSaveTried] = useState(false);
  const descRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Say what is missing rather than going quiet: the press is the moment
    // the question gets asked, so it is the moment to answer it.
    if (saveHint !== null) {
      setSaveTried(true);
      if (amountMinor > 0 && description.trim() === '') descRef.current?.focus();
      return;
    }
    // Ignore a second submit while the first is still in flight: a
    // double-tapped Save is exactly what filed the same expense twice
    // (issue #76).
    if (!valid || shares === null || saving) return;
    setError(null);
    setSaving(true);
    try {
      const payload = {
        description: description.trim(),
        amountMinor,
        currency: currency.toUpperCase(),
        expenseDate: date,
        category,
        splitMethod: method,
        payers,
        shares: Object.entries(shares).map(([userId, v]) => ({ userId, amountMinor: v })),
        ...(() => {
          const stored = splitInputsToStored(method, group.members.map((m) => m.id), weights[method] ?? {}, currency);
          return stored !== null ? { splitInput: stored } : {};
        })(),
        ...(notes.trim() !== '' ? { notes: notes.trim() } : {}),
        ...(fxOverride !== '' ? { fxRateOverride: parseFloat(fxOverride) } : {}),
        ...(receiptId !== null || extraReceiptIds.length > 0
          ? { receiptIds: [...(receiptId !== null ? [receiptId] : []), ...extraReceiptIds] }
          : {}),
      };
      await (editing
        ? api.updateExpense(editing.id, payload)
        : api.addExpense(group.id, { ...payload, ...(allowDuplicate ? { allowDuplicate: true } : {}) }));
      onSaved();
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'FX_RATE_UNAVAILABLE') {
        setNeedsRate(true);
      }
      // The server found the same expense already in this group. Say so
      // and let the user decide, rather than filing it silently (#76).
      if (err instanceof ApiFailure && err.error.code === 'DUPLICATE_EXPENSE') {
        setAllowDuplicate(true);
      }
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet title={editing ? 'Edit expense' : 'New expense'} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="error" role="alert">{error}</div>}
        {/* Directly under the amount, because it is about the amount. This
            used to live at the foot of the sheet, past the split tabs and the
            member list, where a narrow window put it below the fold — and it
            was reported as no warning at all while it was rendering fine. */}
        {scanNote !== null && (
          <div className="error" role="status" style={{
            borderColor: scanNote.tone === 'bad' ? 'var(--ss-owe)' : 'var(--ss-brand)',
          }}>
            {scanNote.text}
            <button type="button" className="btn sm" style={{ marginTop: 8 }}
              onClick={() => setScanNote(null)}>Got it</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="field" style={{ flex: 2 }}><span>Amount</span>
            <input className="amt" inputMode="decimal" value={amountStr} placeholder="0.00"
              onChange={(e) => setAmountStr(e.target.value)} required />
          </label>
          <label className="field" style={{ flex: 1 }}><span>Currency</span>
            <select value={currency} onChange={(e) => {
              // Keep the number the user sees when the scale changes:
              // "950000.00" reparsed as CLP would become 95,000,000.
              const next = e.target.value;
              setAmountStr((s) => rescaleAmountString(s, currency, next));
              // Exact shares and payer amounts have to keep summing to the
              // total, so they rescale as a set rather than one at a time
              // (issue #74) — otherwise each rounds half-up on its own and
              // Save locks behind a "remaining: -1" nobody typed.
              setExact((m) => rescaleAmountFields(m, amountStr, currency, next));
              setPayerAmounts((m) => rescaleAmountFields(m, amountStr, currency, next));
              // Adjustment offsets are amounts too; share counts and
              // percents are scale-free.
              setWeights((w) => w.adjustment === undefined ? w : { ...w,
                adjustment: Object.fromEntries(Object.entries(w.adjustment).map(([id, v]) =>
                  [id, v.startsWith('-') ? `-${rescaleAmountString(v.slice(1), currency, next)}` : rescaleAmountString(v, currency, next)])) });
              setCurrency(next);
            }}>
              <optgroup label="This group">
                {[group.homeCurrency, ...group.currencies].map((c) => (
                  <option key={c} value={c}>{c} — {CURRENCY_NAMES[c as keyof typeof CURRENCY_NAMES] ?? c}</option>
                ))}
              </optgroup>
              <optgroup label="All currencies">
                {CURRENCIES.filter((c) => c !== group.homeCurrency && !group.currencies.includes(c))
                  .map((c) => <option key={c} value={c}>{c} — {CURRENCY_NAMES[c]}</option>)}
              </optgroup>
            </select>
          </label>
        </div>
        {(needsRate || (currency.toUpperCase() !== group.homeCurrency && fxOverride !== '')) && (
          <label className="field"><span>Exchange rate to {group.homeCurrency} (1 {currency.toUpperCase()} = ?)</span>
            <input className="amt" inputMode="decimal" value={fxOverride} onChange={(e) => setFxOverride(e.target.value)} />
          </label>
        )}
        <label className="field"><span>Description</span>
          <input ref={descRef} value={description} onChange={(e) => setDescription(e.target.value)}
            maxLength={200} placeholder="Groceries" />
        </label>
        {/* Issue #37 speed entry: the happy path is amount → description →
            save. Date (today), category, who-paid (you), and notes are
            sensible defaults tucked behind "More options"; the summary line
            shows the current values and turns amber if anything is
            non-default so nothing is silently hidden. */}
        <details className="more" open={multiPayer || payerId !== user.id || notes.trim() !== ''}>
          <summary>
            More options
            <span className="muted" style={{ marginLeft: 6, fontSize: '0.75rem' }}>
              {multiPayer
                ? `${payers.length > 1 ? `${payers.length} people` : 'multiple people'} paid`
                : payerId === user.id ? 'you paid' : `${group.members.find((m) => m.id === payerId)?.displayName ?? 'someone'} paid`}
              {date !== new Date().toISOString().slice(0, 10) ? ` · ${date}` : ''}
              {` · ${categoryLabel(category, catOverrides)}`}
              {notes.trim() !== '' ? ' · note' : ''}
            </span>
          </summary>
          {!multiPayer ? (
            <label className="field"><span>Paid by</span>
              <select value={payerId} onChange={(e) => {
                if (e.target.value === '__multi__') {
                  // Seed the current payer with the full amount so the user
                  // only moves the other contributions off it — unless edit
                  // state already holds per-payer amounts.
                  setPayerAmounts((m) => {
                    const hasAny = group.members.some((mm) => parseAmount(m[mm.id] ?? '', currency) > 0);
                    return hasAny || amountMinor <= 0 ? m
                      : { ...m, [payerId]: minorToAmountString(amountMinor, currency) };
                  });
                  setMultiPayer(true);
                } else {
                  setPayerId(e.target.value);
                }
              }}>
                {group.members.map((m) => (
                  <option key={m.id} value={m.id}>{m.id === user.id ? 'You' : m.displayName}</option>
                ))}
                <option value="__multi__">Multiple people…</option>
              </select>
            </label>
          ) : (
            <>
              <div className="sect" style={{ paddingLeft: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span>Paid by</span>
                <button type="button" className="btn sm" onClick={() => setMultiPayer(false)}>Single payer</button>
              </div>
              {group.members.map((m) => (
                <div className="checkrow" key={m.id}>
                  <Badge id={m.id} name={m.displayName} hasAvatar={m.hasAvatar} avatarVersion={m.avatarVersion} sm />
                  {m.id === user.id ? 'You' : m.displayName}
                  <label className="field amt-in" style={{ margin: 0 }}>
                    <input className="amt" inputMode="decimal" placeholder="0.00"
                      value={payerAmounts[m.id] ?? ''}
                      onChange={(e) => setPayerAmounts({ ...payerAmounts, [m.id]: e.target.value })} />
                  </label>
                </div>
              ))}
              <p className="muted" style={{ padding: '4px 2px', color: payersRemaining === 0 ? 'var(--ss-owed)' : 'var(--ss-owe)' }}>
                remaining: {minorToAmountString(payersRemaining, currency)}
              </p>
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <label className="field" style={{ flex: 1 }}><span>Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className="field" style={{ flex: 1 }}><span>Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                {resolveCategories(catOverrides).map((h) => (
                  // A hidden category still appears if this expense already
                  // uses it — otherwise editing would silently reassign it.
                  <optgroup key={h.slug} label={h.label}>
                    {[h, ...h.children]
                      .filter((c) => !c.hidden || c.slug === category)
                      .map((c) => (
                        <option key={c.slug} value={c.slug}>
                          {c.slug === h.slug ? h.label : `${c.emoji} ${c.label}`}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          <label className="field"><span>Notes (optional)</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000}
              placeholder="e.g. includes the corkage fee" />
          </label>
        </details>

        <div className="sect" style={{ paddingLeft: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span>Split</span>
          {method === 'equal' && (
            <span className="muted" style={{ fontSize: '0.75rem', letterSpacing: 0, textTransform: 'none', fontWeight: 400 }}>
              {included.size === group.members.length
                ? `equally between everyone (${group.members.length})`
                : `equally between ${included.size} of ${group.members.length}`}
            </span>
          )}
          {method === 'adjustment' && (
            <span className="muted" style={{ fontSize: '0.75rem', letterSpacing: 0, textTransform: 'none', fontWeight: 400 }}>
              equal after per-person + / − offsets
            </span>
          )}
        </div>
        {/* FR-3.2: all five split methods */}
        <div className="tabs">
          {([['equal', 'Equal'], ['exact', 'Exact'], ['shares', 'Shares'], ['percent', '%'], ['adjustment', '+/−']] as const).map(([m, label]) => (
            <button key={m} type="button" className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>{label}</button>
          ))}
        </div>
        {method === 'equal' && (
          <div style={{ display: 'flex', gap: 8, padding: '2px 0 6px' }}>
            <button type="button" className="btn sm"
              onClick={() => setIncluded(new Set(group.members.map((m) => m.id)))}>Everyone</button>
            <button type="button" className="btn sm"
              onClick={() => setIncluded(new Set([user.id]))}>Just me</button>
          </div>
        )}

        {group.members.map((m) => (
          <div className="checkrow" key={m.id}>
            {method === 'equal' && (
              <input type="checkbox" checked={included.has(m.id)}
                onChange={(e) => {
                  const next = new Set(included);
                  e.target.checked ? next.add(m.id) : next.delete(m.id);
                  setIncluded(next);
                }} />
            )}
            <Badge id={m.id} name={m.displayName} hasAvatar={m.hasAvatar} avatarVersion={m.avatarVersion} sm />
            {m.id === user.id ? 'You' : m.displayName}
            {method === 'equal' && (
              <span className="amount muted" style={{ marginLeft: 'auto', fontSize: '0.8125rem' }}>
                {shares?.[m.id] !== undefined ? minorToAmountString(shares[m.id]!, currency) : '—'}
              </span>
            )}
            {method === 'exact' && (
              <label className="field amt-in" style={{ margin: 0 }}>
                <input className="amt" inputMode="decimal" placeholder="0.00"
                  value={exact[m.id] ?? ''} onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })} />
              </label>
            )}
            {(method === 'shares' || method === 'percent' || method === 'adjustment') && (
              <>
                <span className="amount muted" style={{ marginLeft: 'auto', fontSize: '0.8125rem' }}>
                  {shares?.[m.id] !== undefined ? minorToAmountString(shares[m.id]!, currency) : '—'}
                </span>
                <label className="field amt-in" style={{ margin: 0 }}>
                  <input className="amt" inputMode={method === 'shares' ? 'numeric' : 'decimal'}
                    placeholder={method === 'shares' ? '0' : method === 'percent' ? '0%' : '±0.00'}
                    value={weights[method]?.[m.id] ?? ''}
                    onChange={(e) => setWeights({ ...weights,
                      [method]: { ...(weights[method] ?? {}), [m.id]: e.target.value } })} />
                </label>
              </>
            )}
          </div>
        ))}
        {method === 'exact' && (
          <p className="muted" style={{ padding: '4px 2px', color: remaining === 0 ? 'var(--ss-owed)' : 'var(--ss-owe)' }}>
            remaining: {minorToAmountString(remaining, currency)}
          </p>
        )}
        {splitHint !== null && amountMinor > 0 && (
          <p className="muted" style={{ padding: '4px 2px', color: 'var(--ss-owe)' }}>{splitHint}</p>
        )}
        {receiptId !== null && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn" style={{ flex: 1 }} disabled={scanBusy}
              onClick={() => void openReceiptView(0)}>
              🧾 View receipt{extraReceiptIds.length > 0 ? 's' : ''}
            </button>
            <button type="button" className="btn" style={{ flex: 1 }} disabled={scanBusy || scanOff}
              title={scanOff ? (scanCap.reason ?? undefined) : undefined}
              onClick={() => void onRescan()}>
              ↻ Rescan
            </button>
          </div>
        )}
        {/* Splitting item by item is a choice now, not a toll gate: a
            scanned receipt lands filled in and splittable equally, and this
            is here for the times somebody only ate the starter. */}
        {lastParsed !== null && lastParsed.items.length > 0 && (
          <button type="button" className="btn block" style={{ marginTop: 8 }} disabled={scanBusy}
            onClick={() => setAssigning(lastParsed)}>
            🍽 Split by item ({lastParsed.items.length})
          </button>
        )}
        {scanOff && (
          <p className="muted" style={{ padding: '4px 2px' }}>
            {scanCap.reason ?? 'Receipt scanning is offline right now'} — you can still add
            this expense by hand.
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" className="btn" disabled={scanBusy || scanOff}
            title={scanOff ? (scanCap.reason ?? undefined) : undefined}
            style={{ flex: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            onClick={() => fileInput.current?.click()}>
            {scanBusy ? 'Reading…' : receiptId ? '📷 New photo' : '📷 Scan receipt'}
          </button>
          {/* Pressable even when the form is short of something, so that
              pressing it can say what: a disabled button answers "why not?"
              with silence. submit() is what refuses, and it explains itself. */}
          <button className="btn primary" style={{ flex: 2 }} disabled={saving}>
            {saving ? 'Saving…' : allowDuplicate ? 'Add it anyway' : editing ? 'Save changes' : 'Save expense'}
          </button>
        </div>
        {saveTried && saveHint !== null && (
          <p role="alert" aria-live="assertive" className="muted"
            style={{ padding: '4px 2px', color: 'var(--ss-owe)' }}>{saveHint}</p>
        )}
        {editing && (
          <div style={{ marginTop: 10 }}>
            <div className="sect" style={{ paddingLeft: 0 }}>Comments</div>
            {(comments ?? []).map((cm) => (
              <div key={cm.id} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: '0.8125rem' }}>
                <Badge id={cm.userId} name={group.members.find((m) => m.id === cm.userId)?.displayName ?? '?'} sm />
                <div>
                  <b>{cm.userId === user.id ? 'You' : group.members.find((m) => m.id === cm.userId)?.displayName ?? 'Former member'}</b>{' '}
                  {cm.body}
                  <div className="meta">{cm.createdAt}</div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={commentText} onChange={(e) => setCommentText(e.target.value)}
                placeholder="Add a comment…" maxLength={1000}
                style={{ flex: 1, background: 'var(--ss-surface-2)', color: 'var(--ss-text)',
                  border: '1px solid var(--ss-outline)', borderRadius: 10, padding: '8px 12px',
                  font: '400 0.84375rem var(--ss-font-body)' }} />
              <button type="button" className="btn sm" disabled={commentText.trim() === ''}
                onClick={() => {
                  api.addComment(editing.id, commentText.trim())
                    .then((cm) => { setComments([...(comments ?? []), cm]); setCommentText(''); })
                    .catch((err) => setError((err as Error).message));
                }}>Send</button>
            </div>
          </div>
        )}
        {editing && onDeleted && (
          <button type="button" className="btn block" style={{ marginTop: 8, color: 'var(--ss-owe)' }}
            onClick={() => {
              api.deleteExpense(editing.id).then(onDeleted).catch((err) => setError(err.message));
            }}>
            Delete this expense
          </button>
        )}
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onScanFile(f); e.target.value = ''; }} />
      </form>
      {assigning !== null && (
        <AssignItemsSheet parsed={assigning} group={group} members={group.members} user={user}
          onCancel={() => setAssigning(null)} onDone={applyAssignment} />
      )}
      {scan !== null && <BusyOverlay scan={scan} onCancel={() => scanAbort.current?.abort()} />}
      {viewing !== null && (
        <div role="dialog" aria-label="Receipt photo" style={{
          position: 'fixed', inset: 0, zIndex: 70, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 10,
          background: 'rgba(8, 12, 22, 0.9)',
        }} onClick={closeReceiptView}>
          {viewing.url === null
            ? <p className="muted">Loading photo…</p>
            : <img src={viewing.url} alt="Receipt"
                style={{ maxWidth: '92vw', maxHeight: '78vh', borderRadius: 10, objectFit: 'contain' }}
                onClick={(e) => e.stopPropagation()} />}
          <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
            {viewing.ids.length > 1 && (
              <>
                <button type="button" className="btn sm" onClick={() => void openReceiptView(viewing.idx - 1)}><Icon name="back" size={16} /></button>
                <span className="muted" style={{ alignSelf: 'center', fontSize: '0.8125rem' }}>
                  {viewing.idx + 1} / {viewing.ids.length}
                </span>
                <button type="button" className="btn sm" onClick={() => void openReceiptView(viewing.idx + 1)}><Icon name="forward" size={16} /></button>
              </>
            )}
            <button type="button" className="btn sm"
              onClick={() => { closeReceiptView(); fileInput.current?.click(); }}>📷 New photo</button>
            <button type="button" className="btn sm" onClick={closeReceiptView}>Close</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ---- Receipt item assignment (ui_requirements §2.6 step 4) ----

function AssignItemsSheet({ parsed, group, members, user, onCancel, onDone }: {
  parsed: ParsedReceipt;
  group: Group;
  members: Member[];
  user: User;
  onCancel: () => void;
  onDone: (r: {
    totalMinor: number; currency: string | null; merchant: string | null;
    date: string | null; shares: Record<string, number>; receiptIds: string[];
  }) => void;
}) {
  const [assign, setAssign] = useState<Record<number, Set<string>>>({});
  const rcur = parsed.currency && /^[A-Z]{3}$/.test(parsed.currency) ? parsed.currency : group.homeCurrency;
  const [slip, setSlip] = useState<{ tipMinor: number; receiptId: string } | null>(null);
  const [slipScan, setSlipScan] = useState<ScanStage | null>(null);
  const slipAbort = useRef<AbortController | null>(null);
  const [slipError, setSlipError] = useState<string | null>(null);
  // The card slip is a scan too (#123): same capability, same disabled-with-reason.
  const [slipCap, setSlipCap] = useState<{ available: boolean; reason: string | null }>({ available: true, reason: null });
  useEffect(() => {
    let alive = true;
    void getCapabilities().then((c) => { if (alive) setSlipCap(c.receiptScanning); });
    return () => { alive = false; };
  }, []);
  const slipInput = useRef<HTMLInputElement>(null);
  const slipBusy = slipScan !== null;

  // Issue #23: parsed lines that aren't part of the bill (loyalty
  // credits, promo blurbs) can be ignored — they then count toward
  // nothing and don't block Continue.
  const [ignoredItems, setIgnoredItems] = useState<Set<number>>(new Set());
  const { itemsSum, totalMinor, extraMinor: extra } =
    receiptBill(parsed, ignoredItems, slip?.tipMinor ?? 0);
  const billTotal = totalMinor - (slip?.tipMinor ?? 0);

  /** Issue #9: the card slip carries the final total with tip — scan it,
   *  take the difference over the bill as the tip, prorate like tax. */
  async function onSlipFile(file: File) {
    setSlipScan({ stage: 'upload', fraction: 0 });
    slipAbort.current = new AbortController();
    setSlipError(null);
    fetchEta();
    try {
      const r = await awaitTurn(await api.uploadReceipt(group.id, file, {
        onUploadProgress: (fraction) => setSlipScan({ stage: 'upload', fraction }),
        onUploaded: () => setSlipScan({ stage: 'read', startedAt: Date.now() }),
        signal: slipAbort.current.signal,
      }, rcur), rcur, setSlipScan, slipAbort.current.signal);
      // Slip amounts arrive in the slip parse's own scale — bridge to the
      // bill's currency before comparing totals.
      const slipTotal = r.parsed === null ? null
        : normalizeParsedReceipt(r.parsed, rcur).totalMinor;
      if (slipTotal === null) {
        setSlipError('could not read a total on that slip — you can still adjust the amount after Continue');
        return;
      }
      const tip = slipTotal - billTotal;
      if (tip < 0) {
        setSlipError('the card slip total is lower than the bill — check you scanned the right photos');
        return;
      }
      setSlip({ tipMinor: tip, receiptId: r.id });
    } catch (err) {
      if (!(err instanceof ApiFailure && err.error.code === 'CANCELED')) {
        setSlipError((err as Error).message);
      }
    } finally {
      setSlipScan(null);
    }
  }
  const allAssigned = allItemsAssigned(parsed.items, assign, ignoredItems);

  function toggle(itemIndex: number, memberId: string) {
    if (ignoredItems.has(itemIndex)) return;
    setAssign((prev) => {
      const next = { ...prev };
      const set = new Set(next[itemIndex] ?? []);
      set.has(memberId) ? set.delete(memberId) : set.add(memberId);
      next[itemIndex] = set;
      return next;
    });
  }

  function toggleIgnored(itemIndex: number) {
    setIgnoredItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemIndex)) {
        next.delete(itemIndex);
      } else {
        next.add(itemIndex);
        setAssign((a) => ({ ...a, [itemIndex]: new Set() }));
      }
      return next;
    });
  }

  function splitRestEqually() {
    setAssign((prev) => {
      const next = { ...prev };
      parsed.items.forEach((_, i) => {
        if (!ignoredItems.has(i) && (next[i]?.size ?? 0) === 0) {
          next[i] = new Set(members.map((m) => m.id));
        }
      });
      return next;
    });
  }

  /** Shared math (@slytab/core): equal split per item, extra prorated. */
  const perMember = useMemo(
    () => assignedShares(parsed.items, assign, ignoredItems, extra),
    [assign, parsed.items, ignoredItems, extra],
  );

  return (
    <Sheet title="Assign items" onClose={onCancel}>
      {parsed.confidence === 'low' && (
        <div className="error" style={{ borderColor: 'var(--ss-owe)' }}>
          The numbers on this receipt don't quite add up — double-check before saving.
        </div>
      )}
      <p className="muted" style={{ paddingBottom: 8 }}>
        {parsed.merchant ?? 'Receipt'}{parsed.date ? ` · ${parsed.date}` : ''} ·
        total {minorToAmountString(totalMinor, rcur)}{parsed.currency ? ` ${parsed.currency}` : ''}
        {extra !== 0 && ` (incl. ${minorToAmountString(extra, rcur)} tax/tip, prorated)`}
      </p>
      {parsed.items.map((item, i) => {
        const off = ignoredItems.has(i);
        return (
          <div className="row" key={i} style={{ flexWrap: 'wrap', opacity: off ? 0.45 : 1 }}>
            <div className="grow">
              <div className="name" style={off ? { textDecoration: 'line-through' } : undefined}>{item.name}</div>
              <div className="meta">
                {item.quantity !== 1 ? `${item.quantity} × ` : ''}{minorToAmountString(item.totalMinor, rcur)}
                {off && ' · ignored — not part of the bill'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {!off && members.map((m) => {
                const on = assign[i]?.has(m.id) ?? false;
                return (
                  <button key={m.id} type="button" onClick={() => toggle(i, m.id)}
                    aria-pressed={on}
                    style={{ background: 'none', border: 'none', padding: 2, opacity: on ? 1 : 0.35,
                      outline: on ? '2px solid var(--ss-brand)' : 'none', borderRadius: '50%' }}>
                    <Badge id={m.id} name={m.displayName} hasAvatar={m.hasAvatar} avatarVersion={m.avatarVersion} sm />
                  </button>
                );
              })}
              <button type="button" className="btn sm" onClick={() => toggleIgnored(i)}
                title={off ? 'Put this line back on the bill' : 'Not part of the bill (loyalty credit, promo) — ignore it'}
                aria-label={off ? `Restore ${item.name}` : `Ignore ${item.name}`}>
                {off ? '↩' : '✕'}
              </button>
            </div>
          </div>
        );
      })}
      {!allAssigned && (
        <button type="button" className="btn block" onClick={splitRestEqually}>
          Split the rest equally
        </button>
      )}
      {slipError && <div className="error" role="alert">{slipError}</div>}
      {!slipCap.available && (
        <p className="muted" style={{ padding: '4px 2px' }}>
          {slipCap.reason ?? 'Receipt scanning is offline right now'} — you can still adjust the tip after Continue.
        </p>
      )}
      <button type="button" className="btn block" style={{ marginTop: 8 }} disabled={slipBusy || !slipCap.available}
        title={!slipCap.available ? (slipCap.reason ?? undefined) : undefined}
        onClick={() => slipInput.current?.click()}>
        {slip !== null
          ? `Tip from card slip: ${minorToAmountString(slip.tipMinor, rcur)} ✓ — rescan`
          : slipBusy ? 'Reading the card slip…' : 'Scan card slip (adds the tip)'}
      </button>
      <input ref={slipInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onSlipFile(f); e.target.value = ''; }} />
      <p className="muted" style={{ padding: '10px 2px' }}>
        {members
          .filter((m) => (perMember[m.id] ?? 0) !== 0)
          .map((m) => `${m.id === user.id ? 'You' : m.displayName} ${minorToAmountString(perMember[m.id] ?? 0, rcur)}`)
          .join(' · ') || 'Tap items, then people.'}
      </p>
      <button type="button" className="btn primary block" disabled={!allAssigned}
        onClick={() => onDone({
          totalMinor, currency: parsed.currency, merchant: parsed.merchant,
          date: parsed.date, shares: perMember,
          receiptIds: slip !== null ? [slip.receiptId] : [],
        })}>
        Continue
      </button>
      {slipScan !== null && <BusyOverlay scan={slipScan} onCancel={() => slipAbort.current?.abort()} />}
    </Sheet>
  );
}

// ---- Group settings (name, emoji, favorite currencies) ----

const GROUP_EMOJI_IMPORT = GROUP_EMOJI;

function GroupSettingsSheet({ group, onClose, onSaved, looksEmpty = false, onDeleted }: {
  group: Group; onClose: () => void; onSaved: () => void;
  looksEmpty?: boolean; onDeleted?: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState(group.emoji);
  const [favorites, setFavorites] = useState<Set<string>>(new Set(group.currencies));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateGroup(group.id, { name, emoji, currencies: [...favorites] });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Group settings" onClose={onClose}>
      <form onSubmit={save}>
        {error && <div className="error" role="alert">{error}</div>}
        <label className="field"><span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <div className="field"><span>Emoji</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {GROUP_EMOJI_IMPORT.map((e) => (
              <button type="button" key={e} onClick={() => setEmoji(e === emoji ? '' : e)}
                style={{ fontSize: '1.25rem', padding: 4, background: 'none', borderRadius: 8,
                  border: e === emoji ? '2px solid var(--ss-brand)' : '2px solid transparent' }}>
                {e}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Often-used currencies (quick picks in expenses; home is always {group.homeCurrency})</span>
          <CurrencyMultiPicker selected={[...favorites]} exclude={group.homeCurrency}
            onChange={(next) => setFavorites(new Set(next))} />
        </div>
        <button className="btn primary block" disabled={busy || name.trim() === ''}>Save</button>
      </form>
      {/* A group that never held money can simply go. #35 established that
          groups archive rather than delete, so balances stay honest — that
          still holds for every group with a history. It should never have
          applied to one made by accident, where "archive" files away
          something that never meant anything and leaves it in the list for
          ever. The server decides: it counts deleted expenses too, so a group
          that once had an expense stays archivable-only. */}
      {looksEmpty && (
        <button type="button" className="btn block" style={{ marginTop: 10, color: 'var(--ss-owe)' }}
          disabled={busy}
          onClick={() => {
            if (!window.confirm(
              `Delete "${group.name}"? It has no expenses, so there is nothing to keep. `
              + 'This removes it for everyone in it and cannot be undone.',
            )) return;
            setBusy(true);
            api.deleteGroup(group.id)
              .then(() => (onDeleted ?? onSaved)())
              .catch((err) => { setError((err as Error).message); setBusy(false); });
          }}>
          Delete this group…
        </button>
      )}
      {/* #120: the trip is over, the paying is not. Locking freezes the
          expenses so the numbers hold still while everyone squares up —
          which is exactly what archiving cannot do, since an archived group
          refuses settlements too. */}
      <button type="button" className="btn block" style={{ marginTop: 10 }}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          (!group.lockedAt ? api.lockGroup(group.id) : api.unlockGroup(group.id))
            .then(onSaved)
            .catch((err) => { setError((err as Error).message); setBusy(false); });
        }}>
        {!group.lockedAt ? 'Lock for settling up…' : 'Unlock — we are still spending'}
      </button>
      {!group.lockedAt && (
        <p className="muted" style={{ padding: '6px 8px 0', fontSize: '0.75rem' }}>
          Stops new expenses. Payments and reminders carry on, and anyone can unlock it.
        </p>
      )}

      {/* Issue #35: a group with a history archives rather than deletes —
          balances must stay honest — and collapses on the home page. */}
      <button type="button" className="btn block" style={{ marginTop: 10, color: 'var(--ss-owe)' }}
        disabled={busy}
        onClick={() => {
          if (!window.confirm(
            `Archive "${group.name}"? It becomes read-only — no new expenses — and moves under `
            + '"Show archived groups" on Home. History and balances stay visible. This can\'t be undone from the app.',
          )) return;
          setBusy(true);
          api.archiveGroup(group.id)
            .then(onSaved)
            .catch((err) => { setError((err as Error).message); setBusy(false); });
        }}>
        Archive this group…
      </button>
      {/* Issue #84: the way out. Anyone can add you to a group by email
          without your agreeing, and until now only they could remove you.
          The server refuses while a balance is outstanding, so say that
          plainly rather than letting it read as a failure. */}
      <button type="button" className="btn block" style={{ marginTop: 10, color: 'var(--ss-owe)' }}
        disabled={busy}
        onClick={() => {
          if (!window.confirm(
            `Leave "${group.name}"? You stop seeing it and stop getting updates about it. `
            + "Past expenses stay so nobody else's balance changes. You can be added back later.",
          )) return;
          setBusy(true);
          api.leaveGroup(group.id)
            .then(onSaved)
            .catch((err) => {
              const msg = (err as Error).message;
              setError(msg.includes('settle')
                ? 'Settle up first — you still have a balance in this group.'
                : msg);
              setBusy(false);
            });
        }}>
        Leave this group…
      </button>
    </Sheet>
  );
}

// ---- Invite ----

function InviteSheet({ group, user, onClose, onChanged }: {
  group: Group; user: User; onClose: () => void; onChanged: () => void;
}) {
  const groupId = group.id;
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Issue #24: people from your other groups are one tap away.
  const [people, setPeople] = useState<Member[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [addBusy, setAddBusy] = useState<string | null>(null);
  useEffect(() => {
    api.createInvite(groupId).then((i) => {
      setLink(`${location.origin}${import.meta.env.BASE_URL}join/${i.token}`);
    });
    api.groups().then((r) => {
      const inGroup = new Set(group.members.map((m) => m.id));
      const seen = new Map<string, Member>();
      for (const g of r.items) {
        for (const m of g.members) {
          if (m.id !== user.id && !inGroup.has(m.id) && !seen.has(m.id)) seen.set(m.id, m);
        }
      }
      setPeople([...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)));
    }).catch(() => setPeople([]));
  }, [groupId, group.members, user.id]);

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
      {people !== null && people.length > 0 && (
        <>
          <div className="sect" style={{ paddingLeft: 0 }}>People you know</div>
          {people.map((p) => (
            <div className="row" key={p.id}>
              <Badge id={p.id} name={p.displayName} />
              <div className="grow"><div className="name">{p.displayName}</div></div>
              <button type="button" className="btn sm" disabled={addBusy !== null || added.has(p.id)}
                onClick={() => {
                  setAddBusy(p.id);
                  setError(null);
                  api.addKnownMember(groupId, p.id)
                    .then(() => { setAdded((s) => new Set(s).add(p.id)); onChanged(); })
                    .catch((err) => setError((err as Error).message))
                    .finally(() => setAddBusy(null));
                }}>
                {added.has(p.id)
                  ? <><Icon name="check" size={14} /> Added</>
                  : addBusy === p.id ? '…'
                  : <><Icon name="add" size={14} /> Add</>}
              </button>
            </div>
          ))}
          <div className="sect" style={{ paddingLeft: 0 }}>Or someone new</div>
        </>
      )}
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
          <p style={{ fontSize: '0.8125rem', wordBreak: 'break-all', background: 'var(--ss-surface-2)', padding: 12, borderRadius: 10 }}>{link}</p>
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

function ImportSheet({ group, user, onClose, onDone }: {
  group: Group; user: User; onClose: () => void; onDone: () => void;
}) {
  const [source, setSource] = useState<'api' | 'csv'>('api');
  const [apiKey, setApiKey] = useState('');
  const [swGroups, setSwGroups] = useState<SplitwiseGroup[] | null>(null);
  const [swGroupId, setSwGroupId] = useState<number | null>(null);
  const [apiMapping, setApiMapping] = useState<Record<string, string>>({});
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<Awaited<ReturnType<typeof api.inspectSplitwise>> | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Issue #44: people from your other groups can be mapped directly —
  // same consent model as the invite sheet's "people you know" (#24).
  const [people, setPeople] = useState<Member[]>([]);
  useEffect(() => {
    api.groups().then((r) => {
      const inGroup = new Set(group.members.map((m) => m.id));
      const seen = new Map<string, Member>();
      for (const g of r.items) {
        for (const m of g.members) {
          if (m.id !== user.id && !inGroup.has(m.id) && !seen.has(m.id)) seen.set(m.id, m);
        }
      }
      setPeople([...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)));
    }).catch(() => setPeople([]));
  }, [group.members, user.id]);

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
    if (swGroupId === null || swGroup === null) return;
    setBusy(true);
    setError(null);
    try {
      const mapping: Record<string, string | { email: string; name: string } | { userId: string }> = {};
      for (const m of swGroup.members) {
        const v = apiMapping[String(m.id)] ?? '';
        mapping[String(m.id)] = v === '__invite'
          ? { email: (inviteEmails[String(m.id)] ?? '').trim(), name: m.name }
          : v.startsWith('__known:')
            ? { userId: v.slice('__known:'.length) }
            : v;
      }
      setResult(await api.splitwiseApiImport(group.id, apiKey.trim(), swGroupId, mapping));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const apiComplete = swGroup !== null
    && swGroup.members.every((m) => {
      const v = apiMapping[String(m.id)] ?? '';
      if (v === '__invite') return /.+@.+\..+/.test((inviteEmails[String(m.id)] ?? '').trim());
      return v !== '';
    })
    && new Set(swGroup.members.map((m) => {
      const v = apiMapping[String(m.id)] ?? '';
      return v === '__invite' ? `email:${(inviteEmails[String(m.id)] ?? '').trim().toLowerCase()}` : v;
    })).size === swGroup.members.length;

  const complete = inspect !== null
    && inspect.members.every((m) => (mapping[m] ?? '') !== '')
    && new Set(Object.values(mapping)).size === inspect.members.length;

  return (
    <Sheet title="Import from Splitwise" onClose={onClose}>
      {error && <div className="error" role="alert">{error}</div>}

      {result !== null ? (
        <>
          <p style={{ fontSize: '0.875rem', paddingBottom: 8 }}>
            Imported <b>{result.imported.expenses}</b> expenses and{' '}
            <b>{result.imported.settlements}</b> settlements
            {result.imported.skipped > 0 && <> · {result.imported.skipped} personal expenses skipped</>}
            {(result.imported.duplicates ?? 0) > 0 && (
              <> · <b>{result.imported.duplicates}</b> already in this group, not added again</>
            )}.
          </p>
          {(result.invited ?? []).length > 0 && (
            <p className="muted" style={{ fontSize: '0.8125rem', paddingBottom: 8 }}>
              Invitations sent to {result.invited!.join(', ')} — their share of the
              history is saved and appears under their name the moment they join.
            </p>
          )}
          {result.errors.length > 0 && (
            <div className="error">
              {result.errors.length} rows could not be imported:
              <ul style={{ paddingLeft: 18 }}>
                {result.errors.slice(0, 5).map((e, i) => <li key={i} style={{ fontSize: '0.75rem' }}>{e}</li>)}
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
                To connect your Splitwise account, get a one-time code:
              </p>
              <ol className="muted" style={{ fontSize: '0.8125rem', paddingLeft: 20, paddingBottom: 8, lineHeight: 1.7 }}>
                <li>In a browser, sign in at <b>secure.splitwise.com/apps</b></li>
                <li>Choose <b>Register your application</b> — the name can be anything (e.g. "SlyTab")</li>
                <li>Copy the long code Splitwise shows (labelled "API key") and paste it below</li>
              </ol>
              <p className="muted" style={{ fontSize: '0.75rem', paddingBottom: 8 }}>
                SlyTab uses the code once to read your groups — it is never stored.
              </p>
              <label className="field"><span>Splitwise code</span>
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
                    <div key={m.id}>
                      <label className="field">
                        <span>Splitwise: "{m.name}"</span>
                        <select value={apiMapping[String(m.id)] ?? ''}
                          onChange={(e) => setApiMapping({ ...apiMapping, [String(m.id)]: e.target.value })}>
                          <option value="">— who is this? —</option>
                          {group.members.map((gm) => (
                            <option key={gm.id} value={gm.id}>{gm.displayName}</option>
                          ))}
                          {people.length > 0 && (
                            <optgroup label="From your other groups">
                              {people.map((p) => (
                                <option key={p.id} value={`__known:${p.id}`}>{p.displayName}</option>
                              ))}
                            </optgroup>
                          )}
                          <option value="__invite">Not here yet — invite by email…</option>
                        </select>
                      </label>
                      {apiMapping[String(m.id)] === '__invite' && (
                        <label className="field" style={{ marginTop: -6 }}>
                          <span>{m.name}'s email — we'll invite them and keep their share ready</span>
                          <input type="email" value={inviteEmails[String(m.id)] ?? ''}
                            onChange={(e) => setInviteEmails({ ...inviteEmails, [String(m.id)]: e.target.value })}
                            placeholder="them@example.com" />
                        </label>
                      )}
                    </div>
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

/**
 * What you can do about one person's balance (#120).
 *
 * The lock decides what this offers, because the lock is what changes the
 * question. While the trip runs, money arrives in pieces — someone hands you
 * $20 against a tab that is still growing — so the sheet records part
 * payments and the amount is yours to type. Once the trip is locked the
 * total has stopped moving, so what is left is closing it out, or asking.
 *
 * Recording money you were handed is the one direction that needs no
 * confirmation: you are the person who would have confirmed it.
 */
function MemberSheet({ group, user, member, balances, onClose, onDone, onPay }: {
  group: Group; user: User; member: Member; balances: Balances;
  onClose: () => void; onDone: () => void; onPay: (suggestedMinor: number) => void;
}) {
  // Truthiness, not `!== null`: an API that predates the lock omits the
  // field, and `undefined !== null` would report every group as locked.
  const locked = Boolean(group.lockedAt);
  // The plan is what both of you are looking at on this screen, so it is the
  // first answer to "how much?". Simplify can route a debt through a third
  // person and leave the plan silent about the two of you, though — and the
  // money can still change hands directly — so the raw pairwise figure is
  // the fallback rather than nothing.
  const between = (from: string, to: string) =>
    balances.plan.find((t) => t.from === from && t.to === to)?.amountMinor
    ?? balances.pairwise.find((t) => t.from === from && t.to === to)?.amountMinor
    ?? 0;
  const owedToMe = between(member.id, user.id);
  const iOwe = between(user.id, member.id);

  const [amountStr, setAmountStr] = useState(minorToAmountString(owedToMe, group.homeCurrency));
  const [method, setMethod] = useState('cash');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const amountMinor = parseAmount(amountStr, group.homeCurrency);

  async function recordReceived() {
    setBusy(true);
    setError(null);
    try {
      await api.recordReceived(group.id, member.id, amountMinor, method);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function remind() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.remind(group.id, member.id);
      setNote(reminderNote(r, member.displayName));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={member.displayName} onClose={onClose}>
      {error && <div className="error" role="alert">{error}</div>}
      {note && <p className="muted" style={{ padding: '0 8px 8px' }}>{note}</p>}
      <p style={{ padding: '0 8px 8px', fontSize: '0.9375rem' }}>
        {owedToMe > 0
          ? <>{member.displayName} owes you <b><Amount minor={owedToMe} currency={group.homeCurrency} /></b>.</>
          : iOwe > 0
            ? <>You owe {member.displayName} <b><Amount minor={iOwe} currency={group.homeCurrency} /></b>.</>
            : <>You and {member.displayName} are settled up ✓</>}
      </p>

      {owedToMe > 0 && (
        <>
          <label className="field"><span>{locked ? 'Amount they paid' : 'Amount received'} ({group.homeCurrency})</span>
            <input className="amt" inputMode="decimal" value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)} />
          </label>
          <label className="field"><span>How</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="interac">Interac e-Transfer</option>
              <option value="paypal">PayPal</option>
              <option value="venmo">Venmo</option>
              <option value="other">Something else</option>
            </select>
          </label>
          <button className="btn primary block" disabled={busy || amountMinor <= 0} onClick={recordReceived}>
            {locked ? 'Record their payment' : 'Record money received'}
          </button>
          {!locked && (
            <p className="muted" style={{ padding: '8px 8px 0' }}>
              Part payments are fine — put in what they actually handed you, and
              the rest stays on their tab.
            </p>
          )}
          {/* Asking belongs to the settling-up phase: mid-trip the tab is
              still growing and there is nothing to chase yet (owner, #120). */}
          {locked && !member.isPlaceholder && (
            <button className="btn block" style={{ marginTop: 10 }} disabled={busy} onClick={remind}>
              Remind {member.displayName}
            </button>
          )}
          {locked && member.isPlaceholder && (
            <p className="muted" style={{ padding: '10px 8px 0' }}>
              {member.displayName} hasn't joined SlyTab yet, so there is nowhere to send a reminder.
            </p>
          )}
        </>
      )}

      {iOwe > 0 && (
        <button className="btn primary block" onClick={() => onPay(iOwe)}>
          Settle up with {member.displayName}
        </button>
      )}
    </Sheet>
  );
}

/** What came back from a nudge, said out loud. */
function reminderNote(r: { sent: boolean; reason: string }, name: string): string {
  if (r.sent) return `Reminder sent to ${name}.`;
  switch (r.reason) {
    case 'too_soon': return `${name} was reminded in the last few days — give it a moment before asking again.`;
    case 'muted': return `${name} has turned off SlyTab emails, so this one would not arrive.`;
    case 'unreachable': return `${name} hasn't joined SlyTab yet, so there is nowhere to send it.`;
    case 'no_debt': return `Nothing to remind ${name} about — you two are square.`;
    default: return `Could not remind ${name} just now.`;
  }
}

// ---- Settle up (FR-7.x — deep links, never holds money) ----

function SettleSheet({ group, to, suggested, onClose, onDone }: {
  group: Group; to: Member; suggested: number; onClose: () => void; onDone: () => void;
}) {
  const [amountStr, setAmountStr] = useState(minorToAmountString(suggested, group.homeCurrency));
  const [error, setError] = useState<string | null>(null);
  const amountMinor = parseAmount(amountStr, group.homeCurrency);
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

  const amountMajor = minorToAmountString(amountMinor, group.homeCurrency);
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
      {handles.venmo && (
        <a className="btn block" style={{ textDecoration: 'none', marginBottom: 8 }}
          href={`https://venmo.com/${handles.venmo}?txn=pay&amount=${amountMajor}&note=${encodeURIComponent(group.name + ' (via SlyTab)')}`}
          target="_blank" rel="noreferrer" onClick={() => record('venmo')}>
          Venmo
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
