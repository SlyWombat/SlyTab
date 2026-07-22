import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type HomeBalances, type User } from '../api';
import { Amount, Badge, Mark, Sheet } from '../ui';

export function Home({ user, onOpenGroup, onSignOut }: {
  user: User;
  onOpenGroup: (groupId: string) => void;
  onSignOut: () => void;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    api.homeBalances().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const total = (data?.items ?? [])
    .filter((i) => i.currency === user.defaultCurrency)
    .reduce((a, i) => a + i.netMinor, 0);
  const incoming = (data?.pendingSettlements ?? []).filter((s) => s.toUserId === user.id);

  return (
    <div className="shell">
      <div className="header">
        <Mark size={26} />
        <h1>Sly<span style={{ color: 'var(--ss-text-2)' }}>Tab</span></h1>
        <div className="spacer" />
        <button className="btn sm" onClick={onSignOut}>Sign out</button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="hero">
        <div className="cap">Your balance</div>
        <div className="big">
          {data === null ? '…' : (
            total === 0
              ? <span style={{ color: 'var(--ss-text-2)' }}>All settled up ✓</span>
              : <Amount minor={total} currency={user.defaultCurrency} signed size={32} />
          )}
        </div>
        <div className="sub">
          {data === null ? 'Loading' : `Across ${data.items.length} group${data.items.length === 1 ? '' : 's'}`}
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
        <label className="field"><span>Emoji (optional)</span>
          <input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} placeholder="🏕️" />
        </label>
        <label className="field"><span>Home currency</span>
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} pattern="[A-Za-z]{3}" />
        </label>
        <button className="btn primary block">Create group</button>
      </form>
    </Sheet>
  );
}

export { Badge };
