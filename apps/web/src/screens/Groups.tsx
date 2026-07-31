/**
 * Groups (§2.3) — one of the four destinations web never had (#103).
 *
 * Cards carry the emoji, name, member badges and your net in that group.
 * Archived groups collapse below, because a finished ski trip should not
 * crowd the one you are on.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type HomeBalances } from '../api';
import { Amount, Badge, SkeletonRows } from '../ui';
import { Icon } from '../Icon';

export function Groups({ onOpenGroup, onNewGroup }: {
  onOpenGroup: (groupId: string) => void;
  onNewGroup: () => void;
}) {
  const [data, setData] = useState<HomeBalances | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.homeBalances().then(setData).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const all = data?.items ?? [];
  const live = all.filter((i) => i.group.archivedAt == null);
  const archived = all.filter((i) => i.group.archivedAt != null);

  return (
    <div className="shell">
      <div className="header">
        <h1>Groups</h1>
        <div className="spacer" />
        <button className="btn sm" onClick={onNewGroup}>
          <Icon name="add" size={15} /> New group
        </button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {data === null ? <SkeletonRows count={4} /> : live.length === 0 ? (
        <div className="row">
          <span className="muted">No groups yet — create one and invite your people.</span>
        </div>
      ) : live.map(({ group, netMinor }) => (
        <button key={group.id} className="row rowbtn" style={{ width: '100%', textAlign: 'left' }}
          onClick={() => onOpenGroup(group.id)}>
          <span className="tile" aria-hidden>
            {group.emoji || <Icon name="group" size={20} />}
          </span>
          <div className="grow">
            <div className="name">{group.name}</div>
            <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {group.members.slice(0, 5).map((m) => (
                <Badge key={m.id} id={m.id} name={m.displayName} sm />
              ))}
              {group.members.length > 5 && <span>+{group.members.length - 5}</span>}
            </div>
          </div>
          {netMinor === 0
            ? <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                settled <Icon name="check" size={13} />
              </span>
            : <Amount minor={netMinor} currency={group.homeCurrency} signed />}
        </button>
      ))}

      {archived.length > 0 && (
        <>
          <button className="btn block" style={{ marginTop: 10 }}
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide' : 'Show'} archived groups ({archived.length})
          </button>
          {showArchived && archived.map(({ group, netMinor }) => (
            <button key={group.id} className="row rowbtn" style={{ width: '100%', textAlign: 'left', opacity: 0.75 }}
              onClick={() => onOpenGroup(group.id)}>
              <span className="tile" aria-hidden>
                {group.emoji || <Icon name="group" size={20} />}
              </span>
              <div className="grow">
                <div className="name">{group.name}</div>
                <div className="meta">archived — read-only</div>
              </div>
              {netMinor !== 0 && <Amount minor={netMinor} currency={group.homeCurrency} signed />}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
