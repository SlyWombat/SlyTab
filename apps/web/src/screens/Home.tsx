import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CURRENCIES, GROUP_EMOJI } from '@slytab/core';
import { api, type HomeBalances, type User } from '../api';
import { Amount, Badge, Mark, Sheet } from '../ui';

export function Home({ user, onOpenGroup, onSignOut, onUserUpdated }: {
  user: User;
  onOpenGroup: (groupId: string) => void;
  onSignOut: () => void;
  onUserUpdated: (u: User) => void;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [verifySent, setVerifySent] = useState(false);

  const reload = useCallback(() => {
    api.homeBalances().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const total = data?.total ?? null;
  const incoming = (data?.pendingSettlements ?? []).filter((s) => s.toUserId === user.id);

  return (
    <div className="shell">
      <div className="header">
        <Mark size={26} />
        <h1>Sly<span style={{ color: 'var(--ss-text-2)' }}>Tab</span></h1>
        <div className="spacer" />
        <button className="btn sm" onClick={() => setProfileOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Badge id={user.id} name={user.displayName} sm /> Profile
        </button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {user.emailVerifiedAt === null && (
        <div className="row" style={{ borderColor: 'var(--ss-owe)' }}>
          <div className="grow" style={{ fontSize: 13 }}>
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
            total.minor === 0
              ? <span style={{ color: 'var(--ss-text-2)' }}>All settled up ✓</span>
              : <>
                  {total.approximate && <span style={{ color: 'var(--ss-text-2)', fontWeight: 400 }}>≈ </span>}
                  <Amount minor={total.minor} currency={total.currency} signed size={32} />
                </>
          )}
        </div>
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
              <div className="grow" style={{ fontSize: 13.5 }}>
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

      <div className="sect">Groups</div>
      {data !== null && data.items.length === 0 && (
        <p className="muted" style={{ padding: '8px 4px' }}>
          No expenses yet. Start a group and invite your people.
        </p>
      )}
      {(data?.items ?? []).map(({ group, netMinor, currency }) => (
        <button className="row" key={group.id} onClick={() => onOpenGroup(group.id)}>
          <span style={{ fontSize: 22 }} aria-hidden>{group.emoji || '👥'}</span>
          <div className="grow">
            <div className="name">{group.name}{group.archivedAt ? ' (archived)' : ''}</div>
            <div className="meta">{group.members.map((m) => m.displayName).join(', ')}</div>
          </div>
          <div className="right">
            {netMinor === 0
              ? <span className="muted">settled ✓</span>
              : <>
                  <Amount minor={netMinor} currency={currency} signed />
                  <span className="dir">{netMinor > 0 ? 'you are owed' : 'you owe'}</span>
                </>}
          </div>
        </button>
      ))}

      <button className="fab" aria-label="New group" onClick={() => setCreating(true)}>+</button>
      {profileOpen && (
        <ProfileSheet user={user} onClose={() => setProfileOpen(false)} onSignOut={onSignOut}
          onSaved={(u) => { onUserUpdated(u); setProfileOpen(false); }} />
      )}
      {creating && (
        <CreateGroupSheet
          defaultCurrency={user.defaultCurrency}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onOpenGroup(id); }}
        />
      )}
    </div>
  );
}

function ProfileSheet({ user, onClose, onSaved, onSignOut }: {
  user: User;
  onClose: () => void;
  onSaved: (u: User) => void;
  onSignOut: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currency, setCurrency] = useState(user.defaultCurrency);
  const [interac, setInterac] = useState(user.paymentHandles.interacEmail ?? '');
  const [paypal, setPaypal] = useState(user.paymentHandles.paypalMe ?? '');
  const [venmo, setVenmo] = useState(user.paymentHandles.venmo ?? '');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const updated = await api.patchMe({
        displayName,
        defaultCurrency: currency.toUpperCase(),
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

  return (
    <Sheet title="Profile" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <div className="error" role="alert">{error}</div>}
        <label className="field"><span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} />
        </label>
        <label className="field"><span>Default currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
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
      <button className="btn block" style={{ marginTop: 8 }} onClick={onSignOut}>Sign out</button>
      {!deleting ? (
        <button className="btn block" style={{ marginTop: 8, color: 'var(--ss-owe)' }}
          onClick={() => setDeleting(true)}>
          Delete my account…
        </button>
      ) : (
        <div style={{ marginTop: 8, border: '1px solid var(--ss-owe)', borderRadius: 12, padding: 12 }}>
          <p style={{ fontSize: 13, paddingBottom: 8 }}>
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
      <p className="muted" style={{ textAlign: 'center', paddingTop: 10 }}>
        {user.email} · <a href={`${import.meta.env.BASE_URL}marketing/privacy/`} style={{ color: 'var(--ss-brand)' }}>Privacy</a>
      </p>
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
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const g = await api.createGroup(name, emoji, currency.toUpperCase());
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
                style={{ fontSize: 20, padding: 4, background: 'none', borderRadius: 8,
                  border: e === emoji ? '2px solid var(--ss-brand)' : '2px solid transparent' }}>
                {e}
              </button>
            ))}
          </div>
        </div>
        <label className="field"><span>Home currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button className="btn primary block">Create group</button>
      </form>
    </Sheet>
  );
}

export { Badge };
