import { useCallback, useEffect, useState, type FormEvent, useRef } from 'react';
import { CURRENCIES, CURRENCY_NAMES, formatMinor, GROUP_EMOJI } from '@slytab/core';
import { api, type Group, type HomeBalances, type Session, type User, shrinkImage } from '../api';
import { GetTheApp, TESTFLIGHT_URL } from '../GetTheApp';
import { Icon } from '../Icon';
import { setPref, storedPref, type ThemePref } from '../theme';
import { AddExpenseSheet } from './Group';
import { Amount, Badge, CurrencyMultiPicker, Mark, Sheet } from '../ui';

// Quick-add remembers where you last added an expense (per device) so the
// picker defaults to the group you're living in right now (issue #20).
const LAST_GROUP_KEY = 'slytab.lastGroup';

export function Home({ user, onOpenGroup, onSignOut, onUserUpdated, onMyExpenses }: {
  user: User;
  onOpenGroup: (groupId: string) => void;
  onSignOut: () => void;
  onUserUpdated: (u: User) => void;
  onMyExpenses: () => void;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [friendEmail, setFriendEmail] = useState('');
  const [friendBusy, setFriendBusy] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [verifySent, setVerifySent] = useState(false);
  const [picking, setPicking] = useState(false);
  const [quickAdd, setQuickAdd] = useState<{ group: Group; lastCurrency?: string } | null>(null);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.homeBalances().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const total = data?.total ?? null;
  const incoming = (data?.pendingSettlements ?? []).filter((s) => s.toUserId === user.id);
  const friends = (data?.items ?? []).filter((i) => i.group.isDirect);
  const liveGroups = (data?.items ?? []).filter((i) => !i.group.isDirect && !i.group.archivedAt);
  const archivedGroups = (data?.items ?? []).filter((i) => !i.group.isDirect && i.group.archivedAt);
  const [showArchived, setShowArchived] = useState(false);

  function rememberGroup(id: string) {
    try { localStorage.setItem(LAST_GROUP_KEY, id); } catch { /* private mode */ }
  }
  function openGroup(id: string) {
    rememberGroup(id);
    onOpenGroup(id);
  }

  // Archived groups are read-only, so they can't take new expenses.
  const activeItems = (data?.items ?? []).filter((i) => !i.group.archivedAt);
  const lastGroupId = (() => {
    try { return localStorage.getItem(LAST_GROUP_KEY); } catch { return null; }
  })();
  const pickerItems = [...activeItems].sort((a, b) =>
    Number(b.group.id === lastGroupId) - Number(a.group.id === lastGroupId));

  // Add expense in one tap: single group goes straight to the sheet, else
  // ask which group (most recently used first). The sheet opens in the
  // group's last-used currency — same mid-trip behaviour as in the group.
  const startQuickAdd = useCallback((group: Group) => {
    setQuickBusy(group.id);
    rememberGroup(group.id);
    api.expenses(group.id)
      .then((r) => setQuickAdd({ group, lastCurrency: r.items[0]?.currency }))
      .catch(() => setQuickAdd({ group }))
      .finally(() => { setQuickBusy(null); setPicking(false); });
  }, []);
  const onAddExpense = useCallback(() => {
    const only = activeItems.length === 1 ? activeItems[0] : undefined;
    if (only !== undefined) startQuickAdd(only.group);
    else setPicking(true); // includes the no-groups case (picker explains)
  }, [activeItems, startQuickAdd]);

  // ui_requirements §3: `n` = new expense on web.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (picking || quickAdd !== null || creating || addingFriend || profileOpen || data === null) return;
      onAddExpense();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, quickAdd, creating, addingFriend, profileOpen, data, onAddExpense]);

  return (
    <div className="shell">
      <div className="header">
        <Mark size={26} />
        <h1>Sly<span style={{ color: 'var(--ss-text-2)' }}>Tab</span></h1>
        <div className="spacer" />
        <button className="btn sm" onClick={() => setProfileOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Badge id={user.id} name={user.displayName} hasAvatar={user.hasAvatar} sm /> Profile
        </button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {/* Getting testers onto TestFlight is the bottleneck while the apps
          are in testing — this only shows on iPhone/iPad browsers. */}
      <GetTheApp user={user} />

      {user.emailVerifiedAt === null && (
        <div className="row" style={{ borderColor: 'var(--ss-owe)' }}>
          <div className="grow" style={{ fontSize: '0.8125rem' }}>
            {verifySent
              ? <>Confirmation email sent to <b>{user.email}</b> — check your inbox and junk folder.</>
              : <>Confirm your email — press Resend to get a link at <b>{user.email}</b>.</>}
          </div>
          <button className="btn sm" disabled={verifySent} onClick={() => {
            api.resendVerification()
              .then(() => { setError(null); setVerifySent(true); })
              .catch((e) => setError(e.message));
          }}>{verifySent ? 'Sent ✓' : 'Resend'}</button>
        </div>
      )}

      <div className="hero">
        <div className="cap">Your balance</div>
        <div className="big">
          {total === null ? '…' : (
            total.owedMinor === 0 && total.oweMinor === 0
              ? <span style={{ color: 'var(--ss-text-2)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  All settled up <Icon name="check" size={14} />
                </span>
              : <>
                  {total.approximate && <span style={{ color: 'var(--ss-text-2)', fontWeight: 400 }}>≈ </span>}
                  <Amount minor={total.minor} currency={total.currency} signed size={32} />
                </>
          )}
        </div>
        {total !== null && (total.owedMinor > 0 || total.oweMinor > 0) && (
          <div className="split">
            {total.owedMinor > 0 && (
              <span>you're owed <b style={{ color: 'var(--ss-owed)' }}>
                {formatMinor(total.owedMinor, total.currency)}</b></span>
            )}
            {total.oweMinor > 0 && (
              <span>you owe <b style={{ color: 'var(--ss-owe)' }}>
                {formatMinor(total.oweMinor, total.currency)}</b></span>
            )}
          </div>
        )}
        <div className="sub">
          {total === null ? 'Loading'
            : `Across ${data!.items.length} group${data!.items.length === 1 ? '' : 's'}`
              + (total.approximate ? ` · converted to ${total.currency} at today's rate` : '')
              + (total.excluded.length > 0 ? ` · no rate for ${total.excluded.join(', ')}` : '')}
        </div>
      </div>

      {incoming.length > 0 && (
        <>
          <div className="sect">Waiting for your confirmation</div>
          {incoming.map((s) => (
            <div className="row" key={s.id}>
              <div className="grow" style={{ fontSize: '0.84375rem' }}>
                Payment of <b><Amount minor={s.amountMinor} currency={s.currency} /></b> sent to you
              </div>
              <button className="btn primary sm" onClick={() => api.confirmSettlement(s.id).then(reload)}>
                Confirm
              </button>
              <button className="btn sm" onClick={() => api.declineSettlement(s.id).then(reload)}>
                Didn't get it
              </button>
            </div>
          ))}
        </>
      )}

      {friends.length > 0 && (
        <>
          <div className="sect">Friends <span className="count">· {friends.length}</span></div>
          {friends.map(({ group, netMinor, currency }) => {
            const other = group.members.find((m) => m.id !== user.id);
            return (
              <button className="row" key={group.id} onClick={() => openGroup(group.id)}>
                <Badge id={other?.id ?? group.id} name={other?.displayName ?? '?'} />
                <div className="grow">
                  <div className="name">{other?.displayName ?? 'Friend'}</div>
                </div>
                <div className="right">
                  {netMinor === 0
                    ? <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        settled <Icon name="check" size={13} />
                      </span>
                    : <>
                        <Amount minor={netMinor} currency={currency} signed />
                        <span className="dir">{netMinor > 0 ? 'owes you' : 'you owe'}</span>
                      </>}
                </div>
              </button>
            );
          })}
        </>
      )}
      <div className="sect">Groups {liveGroups.length > 0 && <span className="count">· {liveGroups.length}</span>}</div>
      {data !== null && data.items.length === 0 && (
        <p className="muted" style={{ padding: '8px 4px' }}>
          No expenses yet. Start a group and invite your people.
        </p>
      )}
      {liveGroups.map((item) => <GroupCard key={item.group.id} item={item} userId={user.id} onOpen={openGroup} />)}
      {archivedGroups.length > 0 && (
        showArchived
          ? archivedGroups.map((item) => <GroupCard key={item.group.id} item={item} userId={user.id} onOpen={openGroup} />)
          : (
            <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setShowArchived(true)}>
              Show {archivedGroups.length} archived group{archivedGroups.length === 1 ? '' : 's'}
            </button>
          )
      )}

      <div style={{ display: 'flex', gap: 8, padding: '10px 0 80px' }}>
        <button className="btn sm" onClick={() => setCreating(true)}>New group</button>
        <button className="btn sm" onClick={() => setAddingFriend(true)}>Split with a friend</button>
      </div>
      {addingFriend && (
        <Sheet title="Split with a friend" onClose={() => setAddingFriend(false)}>
          <p className="muted" style={{ paddingBottom: 10 }}>
            One-on-one expenses, no group needed. If they're not on SlyTab yet
            we'll email an invite — anything you add is waiting when they join.
          </p>
          <form onSubmit={(e) => {
            e.preventDefault();
            setFriendBusy(true);
            api.addFriend(friendEmail.trim())
              .then((g) => { setAddingFriend(false); setFriendEmail(''); openGroup(g.id); })
              .catch((err) => setError((err as Error).message))
              .finally(() => setFriendBusy(false));
          }}>
            <label className="field"><span>Their email</span>
              <input type="email" value={friendEmail} onChange={(e) => setFriendEmail(e.target.value)}
                required placeholder="friend@example.com" />
            </label>
            <button className="btn primary block" disabled={friendBusy}>
              {friendBusy ? '…' : 'Start splitting'}
            </button>
          </form>
        </Sheet>
      )}
      <button className="fab wide" onClick={onAddExpense} disabled={data === null}>
        <Icon name="add" size={18} /> Add expense
      </button>
      {picking && (
        <Sheet title="Add an expense" onClose={() => setPicking(false)}>
          {pickerItems.length === 0 ? (
            <>
              <p className="muted" style={{ paddingBottom: 10 }}>
                Every expense lives in a group or a one-on-one tab — start
                one and you're seconds away from splitting.
              </p>
              <button className="btn primary block" onClick={() => { setPicking(false); setCreating(true); }}>
                New group
              </button>
              <button className="btn block" style={{ marginTop: 8 }}
                onClick={() => { setPicking(false); setAddingFriend(true); }}>
                Split with a friend
              </button>
            </>
          ) : (
            <>
              <p className="muted" style={{ paddingBottom: 8 }}>Where did this expense happen?</p>
              {pickerItems.map(({ group }) => {
                const other = group.isDirect ? group.members.find((m) => m.id !== user.id) : undefined;
                return (
                  <button className="row" key={group.id} disabled={quickBusy !== null}
                    onClick={() => startQuickAdd(group)}>
                    {group.isDirect
                      ? <Badge id={other?.id ?? group.id} name={other?.displayName ?? '?'} />
                      : <span className="tile" aria-hidden>
                          {group.emoji || <Icon name="group" size={20} />}
                        </span>}
                    <div className="grow">
                      <div className="name">{group.isDirect ? other?.displayName ?? 'Friend' : group.name}</div>
                      {!group.isDirect && (
                        <div className="meta">{group.members.map((m) => m.displayName).join(', ')}</div>
                      )}
                    </div>
                    <div className="right">
                      {quickBusy === group.id ? <span className="muted">…</span>
                        : group.id === lastGroupId && <span className="muted">recent</span>}
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </Sheet>
      )}
      {quickAdd !== null && (
        <AddExpenseSheet group={quickAdd.group} user={user} lastCurrency={quickAdd.lastCurrency}
          onClose={() => setQuickAdd(null)}
          onSaved={() => { setQuickAdd(null); reload(); }} />
      )}
      {profileOpen && (
        <ProfileSheet user={user} onClose={() => setProfileOpen(false)} onSignOut={onSignOut}
          onMyExpenses={() => { setProfileOpen(false); onMyExpenses(); }}
          onSaved={(u) => { onUserUpdated(u); setProfileOpen(false); }} />
      )}
      {creating && (
        <CreateGroupSheet
          defaultCurrency={user.defaultCurrency}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); openGroup(id); }}
        />
      )}
    </div>
  );
}

/**
 * Home group card (issue #20 design pass): emoji tile, group name, and
 * up to two per-person ledger lines ("Jon owes you US$180.50") so the
 * card answers "who owes whom" without opening the group.
 */
function GroupCard({ item, userId, onOpen }: {
  item: HomeBalances['items'][number];
  userId: string;
  onOpen: (groupId: string) => void;
}) {
  const { group, netMinor, currency, myPairs } = item;
  const pairs = myPairs ?? [];
  const nameOf = (id: string) =>
    group.members.find((m) => m.id === id)?.displayName?.split(' ')[0] ?? 'Former member';
  const others = group.members.filter((m) => m.id !== userId);
  return (
    <button className="row" onClick={() => onOpen(group.id)}>
      <span className="tile" aria-hidden>{group.emoji || '👥'}</span>
      <div className="grow">
        <div className="name">{group.name}{group.archivedAt ? ' (archived)' : ''}</div>
        {pairs.length === 0 ? (
          <div className="pairline">
            {others.length > 0
              ? <>all square with {others.map((m) => m.displayName.split(' ')[0]).join(', ')} ✓</>
              : 'just you so far — invite your people'}
          </div>
        ) : (
          <>
            {pairs.slice(0, 2).map((p) => (
              <div className="pairline" key={p.userId}>
                {p.amountMinor > 0
                  ? <>{nameOf(p.userId)} owes you <b style={{ color: 'var(--ss-owed)' }}>
                      {formatMinor(p.amountMinor, currency)}</b></>
                  : <>you owe {nameOf(p.userId)} <b style={{ color: 'var(--ss-owe)' }}>
                      {formatMinor(-p.amountMinor, currency)}</b></>}
              </div>
            ))}
            {pairs.length > 2 && (
              <div className="pairline" style={{ color: 'var(--ss-text-3)' }}>
                plus {pairs.length - 2} more balance{pairs.length - 2 === 1 ? '' : 's'}
              </div>
            )}
          </>
        )}
      </div>
      <div className="right">
        {netMinor === 0
          ? <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              settled <Icon name="check" size={13} />
            </span>
          : <>
              <Amount minor={netMinor} currency={currency} signed />
              <span className="dir">{netMinor > 0 ? 'you are owed' : 'you owe'}</span>
            </>}
      </div>
    </button>
  );
}

/** "2 hours ago" style timestamps for the devices list. */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso + 'Z').getTime()) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function deviceName(label: string): string {
  if (label === 'web') return 'Web browser';
  if (label === 'mobile') return 'Android app';
  return label || 'Unknown device';
}

/** Report a bug (profile page): comment + optional screenshot. */
function BugReportSection() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null); // tracking code
  const [error, setError] = useState<string | null>(null);

  if (sent !== null) {
    return (
      <p className="muted" style={{ padding: '8px 2px' }}>
        Thanks — your report is in as <b>{sent}</b>. We read every one,
        and you'll get an email when it's fixed. 🐛✓
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" className="btn block" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>
        🐛 Report a bug
      </button>
    );
  }
  return (
    <div style={{ marginTop: 8, border: '1px solid var(--ss-outline)', borderRadius: 12, padding: 12 }}>
      {error && <div className="error" role="alert">{error}</div>}
      <label className="field"><span>What went wrong?</span>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
          maxLength={2000} placeholder="What did you do, what did you expect, what happened instead?" />
      </label>
      <label className="field"><span>Screenshot (optional)</span>
        <input type="file" accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" style={{ flex: 1 }} disabled={busy}
          onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
        <button type="button" className="btn primary" style={{ flex: 1 }}
          disabled={busy || message.trim() === ''}
          onClick={() => {
            setBusy(true);
            setError(null);
            api.reportBug(message.trim(), image)
              .then((r) => setSent(r.tracking ?? 'received'))
              .catch((e) => setError((e as Error).message))
              .finally(() => setBusy(false));
          }}>
          {busy ? 'Sending…' : 'Send report'}
        </button>
      </div>
    </div>
  );
}

export function ProfileSheet({ user, onClose, onSaved, onSignOut, onMyExpenses, chrome = true }: {
  user: User;
  onClose: () => void;
  onSaved: (u: User) => void;
  onSignOut: () => void;
  onMyExpenses: () => void;
  /** false renders the contents bare, for the Profile destination (#103). */
  chrome?: boolean;
}) {
  const [theme, setTheme] = useState<ThemePref>(() => storedPref());
  const [deleting, setDeleting] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  async function onPickAvatar(file: File) {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      // Shrunk client-side first, exactly as receipts are: the server squares
      // and resizes anyway, and there is no reason to push several megabytes
      // over a slow link to draw a circle the size of a fingernail.
      const { blob, name } = await shrinkImage(file, 512);
      await api.setAvatar(blob, name);
      onSaved(await api.me());
    } catch (e) {
      setAvatarError((e as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  }

  async function onClearAvatar() {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      await api.clearAvatar();
      onSaved(await api.me());
    } catch (e) {
      setAvatarError((e as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  }
  const [confirmEmail, setConfirmEmail] = useState('');
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currency, setCurrency] = useState(user.defaultCurrency);
  const [notifyLevel, setNotifyLevel] = useState<'all' | 'important' | 'none'>(user.notifyLevel ?? 'all');
  const [interac, setInterac] = useState(user.paymentHandles.interacEmail ?? '');
  const [paypal, setPaypal] = useState(user.paymentHandles.paypalMe ?? '');
  const [venmo, setVenmo] = useState(user.paymentHandles.venmo ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listSessions().then((r) => setSessions(r.items)).catch(() => {});
  }, []);

  // Issue #22: closing with unsaved edits warns instead of discarding.
  const dirty = displayName !== user.displayName
    || currency !== user.defaultCurrency
    || notifyLevel !== (user.notifyLevel ?? 'all')
    || interac !== (user.paymentHandles.interacEmail ?? '')
    || paypal !== (user.paymentHandles.paypalMe ?? '')
    || venmo !== (user.paymentHandles.venmo ?? '');
  function guardedClose() {
    if (!dirty || window.confirm('Discard your unsaved profile changes?')) onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const updated = await api.patchMe({
        displayName,
        defaultCurrency: currency.toUpperCase(),
        notifyLevel,
        paymentHandles: {
          ...(interac ? { interacEmail: interac } : {}),
          ...(paypal ? { paypalMe: paypal } : {}),
          ...(venmo ? { venmo } : {}),
        },
      });
      onSaved(updated);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // The contents are identical either way; only the wrapper differs. The
  // Profile destination (#103) renders them bare, the legacy sheet wraps
  // them. Re-typing several hundred lines to move a wrapper would be a
  // fine way to break the screen that deletes accounts.
  const body = (
    <>
      <form onSubmit={submit}>
        {error && <div className="error" role="alert">{error}</div>}
        <label className="field"><span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} />
        </label>
        <label className="field"><span>Default currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c} — {CURRENCY_NAMES[c]}</option>)}
          </select>
        </label>
        {/* #92: the palette existed all along and nothing selected it, so the
            app was hard-dark by accident. System follows the OS and keeps
            following it. */}
        <label className="field"><span>Theme</span>
          <select value={theme} onChange={(e) => {
            const v = e.target.value as ThemePref;
            setTheme(v);
            setPref(v);
          }}>
            <option value="system">Match my device</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label className="field"><span>Notifications (app and email)</span>
          <select value={notifyLevel} onChange={(e) => setNotifyLevel(e.target.value as typeof notifyLevel)}>
            <option value="all">Everything (expenses, payments, comments)</option>
            <option value="important">Important only (payments and joins)</option>
            <option value="none">Nothing</option>
          </select>
        </label>
        <div className="sect" style={{ paddingLeft: 0 }}>How people pay you</div>
        <label className="field"><span>Interac e-Transfer email</span>
          <input type="email" value={interac} onChange={(e) => setInterac(e.target.value)} placeholder="you@example.com" />
        </label>
        <label className="field"><span>PayPal.Me username</span>
          <input value={paypal} onChange={(e) => setPaypal(e.target.value)} placeholder="yourname" />
        </label>
        <label className="field"><span>Venmo username</span>
          <input value={venmo} onChange={(e) => setVenmo(e.target.value)} placeholder="yourname" />
        </label>
        <button className="btn primary block">Save profile</button>
      </form>
      {/* #101: the cross-group view of your own spending. Profile is where
          people look for "my stuff", so it lives beside the account rows. */}
      {/* #112: a photo instead of an initial. Kept next to the name, which is
          the other thing that identifies you to everyone else. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <Badge id={user.id} name={user.displayName} hasAvatar={user.hasAvatar} />
        <input ref={avatarInput} type="file" accept="image/*" hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onPickAvatar(f);
          }} />
        <button type="button" className="btn sm" disabled={avatarBusy}
          onClick={() => avatarInput.current?.click()}>
          {avatarBusy ? 'Uploading…' : user.hasAvatar ? 'Change photo' : 'Add a photo'}
        </button>
        {user.hasAvatar && (
          <button type="button" className="btn sm" disabled={avatarBusy}
            onClick={() => void onClearAvatar()}>Remove</button>
        )}
      </div>
      {avatarError !== null && (
        <p className="muted" style={{ color: 'var(--ss-owe)', padding: '4px 2px' }}>{avatarError}</p>
      )}

      {/* #104: the manual, reachable from inside the app rather than only from
          a marketing page nobody visits. */}
      <a className="btn block" style={{ marginTop: 8, textAlign: 'center', textDecoration: 'none' }}
        href={`${import.meta.env.BASE_URL}guide/`} target="_blank" rel="noreferrer">
        <Icon name="receipt" size={16} /> How SlyTab works
      </a>
      <button className="btn block" style={{ marginTop: 8 }} onClick={onMyExpenses}>
        <Icon name="wallet" size={16} /> My expenses
      </button>
      {/* Issue #27: the phone apps, for people using the web app. Both rows
          are ALWAYS shown — the banner above guesses at your platform, and
          when that guess was wrong a tester had no way to find the app at
          all. This is the path that never depends on detection. */}
      <a className="btn block" style={{ marginTop: 8, textAlign: 'center', textDecoration: 'none' }}
        href={TESTFLIGHT_URL} target="_blank" rel="noreferrer">
        <Icon name="apple" size={16} /> Get the iPhone app (TestFlight)
      </a>
      {/* Straight to the APK, the way the row above goes straight to
          TestFlight. It used to point at marketing/apps/, so choosing Android
          here landed you on a page listing all three options and asking you to
          choose Android a second time — the iPhone row never did that. The one
          thing that page said which you genuinely need is repeated below;
          nothing else on it was worth a second click (reported by the owner,
          2026-08-01). */}
      <a className="btn block" style={{ marginTop: 8, textAlign: 'center', textDecoration: 'none' }}
        href={`${import.meta.env.BASE_URL}downloads/slytab-latest.apk`}>
        <Icon name="android" size={16} /> Get the Android app (APK)
      </a>
      <p className="muted" style={{ padding: '6px 4px 0', textAlign: 'center' }}>
        Downloads straight away. The first time, your browser will ask you to allow
        installing unknown apps. <a href={`${import.meta.env.BASE_URL}marketing/apps/`}
          target="_blank" rel="noreferrer" style={{ color: 'var(--ss-brand)' }}>Other ways to install</a>
      </p>
      <BugReportSection />
      <button className="btn block" style={{ marginTop: 8 }} onClick={onSignOut}>Sign out</button>
      {!deleting ? (
        <button className="btn block" style={{ marginTop: 8, color: 'var(--ss-owe)' }}
          onClick={() => setDeleting(true)}>
          Delete my account…
        </button>
      ) : (
        <div style={{ marginTop: 8, border: '1px solid var(--ss-owe)', borderRadius: 12, padding: 12 }}>
          <p style={{ fontSize: '0.8125rem', paddingBottom: 8 }}>
            This signs you out everywhere and anonymizes you as "Deleted user"
            in shared groups (past expenses stay so nobody's balance changes).
            It cannot be undone. Type your email to confirm.
          </p>
          <label className="field"><span>Your email</span>
            <input type="email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder={user.email} autoComplete="off" />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" style={{ flex: 1 }} onClick={() => { setDeleting(false); setConfirmEmail(''); }}>
              Keep my account
            </button>
            <button className="btn" style={{ flex: 1, color: 'var(--ss-owe)' }}
              disabled={confirmEmail.trim().toLowerCase() !== user.email}
              onClick={() => {
                api.deleteAccount(confirmEmail.trim()).then(onSignOut).catch((e) => setError(e.message));
              }}>
              Delete forever
            </button>
          </div>
        </div>
      )}
      {/* Loads async, so it lives below every button: inserted higher up it
          shifted the layout and moved the button being pressed (#42). */}
      {sessions !== null && sessions.length > 0 && (
        <>
          <div className="sect" style={{ paddingLeft: 0 }}>Where you're signed in</div>
          {sessions.map((sess) => (
            <div className="row" key={sess.id}>
              <div className="grow">
                <div className="name" style={{ fontSize: '0.84375rem' }}>
                  {deviceName(sess.deviceLabel)}{sess.current && <span className="muted"> · this device</span>}
                </div>
                <div className="meta">last active {ago(sess.lastSeenAt)}</div>
              </div>
              {!sess.current && (
                <button className="btn sm" onClick={() => {
                  api.revokeSession(sess.id)
                    .then(() => setSessions(sessions.filter((x) => x.id !== sess.id)))
                    .catch((e) => setError(e.message));
                }}>Sign out</button>
              )}
            </div>
          ))}
        </>
      )}
      <p className="muted" style={{ textAlign: 'center', paddingTop: 10 }}>
        Account: {user.email} · <a href={`${import.meta.env.BASE_URL}marketing/privacy/`} style={{ color: 'var(--ss-brand)' }}>Privacy</a>
      </p>
    </>
  );

  if (!chrome) return body;
  return (
    <Sheet title="Profile" onClose={guardedClose}>
      {body}
    </Sheet>
  );
}

function CreateGroupSheet({ defaultCurrency, onClose, onCreated }: {
  defaultCurrency: string;
  onClose: () => void;
  onCreated: (groupId: string) => void;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const g = await api.createGroup(name, emoji, currency.toUpperCase(), [...favorites]);
      onCreated(g.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Sheet title="New group" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="error">{error}</div>}
        <label className="field"><span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Cottage Trip" />
        </label>
        <div className="field"><span>Emoji</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {GROUP_EMOJI.map((e) => (
              <button type="button" key={e} onClick={() => setEmoji(e === emoji ? '' : e)}
                style={{ fontSize: '1.25rem', padding: 4, background: 'none', borderRadius: 8,
                  border: e === emoji ? '2px solid var(--ss-brand)' : '2px solid transparent' }}>
                {e}
              </button>
            ))}
          </div>
        </div>
        <label className="field"><span>Home currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c} — {CURRENCY_NAMES[c]}</option>)}
          </select>
        </label>
        <div className="field"><span>Also often used (quick picks in expenses — optional)</span>
          <CurrencyMultiPicker selected={[...favorites]} exclude={currency}
            onChange={(next) => setFavorites(new Set(next))} />
        </div>
        <button className="btn primary block">Create group</button>
      </form>
    </Sheet>
  );
}

export { Badge };
