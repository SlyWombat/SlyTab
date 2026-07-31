/**
 * Activity (§2.9, FR-8.1) — the destination web never had (#103).
 *
 * The global feed was reachable only on the phone, so a MUST requirement was
 * unmet on half the product. Built the same way mobile builds it: a
 * client-side merge of the per-group feeds, because there is still no global
 * endpoint. That is an N+1 and it is called out in the mobile audit; it is
 * the same trade here, and the fix is one endpoint on the server rather than
 * two different workarounds.
 *
 * "My expenses" lives here as a segmented control, matching mobile. It sat
 * under Profile on web only because there was no Activity to put it in — a
 * compromise this screen exists to undo (#101).
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type ActivityItem } from '../api';
import { Badge, SkeletonRows } from '../ui';
import { MyExpenses } from './MyExpenses';

type Row = ActivityItem & { groupId: string; groupLabel: string; who: string };

/** Human phrasing for the feed — mirrors the mobile wording (issue #16). */
function activityText(ev: ActivityItem): string {
  const d = (ev.diff ?? {}) as { description?: string };
  const what = d.description ? `“${d.description}”` : `a ${ev.entityType}`;
  switch (ev.verb) {
    case 'created': return 'started the group';
    case 'joined': return 'joined the group';
    case 'left': return 'left the group';
    case 'added': return ev.entityType === 'member' ? 'added a member' : `added ${what}`;
    case 'edited': return ev.entityType === 'group' ? 'updated the group settings' : `edited ${what}`;
    case 'deleted': return `deleted ${what}`;
    case 'restored': return `restored ${what}`;
    case 'settled': return 'recorded a payment';
    case 'confirmed': return 'confirmed a payment';
    case 'declined': return "couldn't find a payment (declined)";
    case 'imported': return 'imported from Splitwise';
    case 'commented': return `commented on ${what}`;
    default: return `${ev.verb} ${what}`;
  }
}

export function Activity({ userId, onOpenGroup }: {
  userId: string;
  onOpenGroup: (groupId: string) => void;
}) {
  const [view, setView] = useState<'activity' | 'mine'>('activity');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.homeBalances().then(async (r) => {
      const feeds = await Promise.all(r.items.map(async ({ group }) => {
        try {
          const f = await api.activity(group.id);
          return f.items.map((ev): Row => ({
            ...ev,
            groupId: group.id,
            groupLabel: group.name,
            who: ev.userId === userId
              ? 'You'
              : group.members.find((m) => m.id === ev.userId)?.displayName ?? 'Someone',
          }));
        } catch {
          return [] as Row[]; // one unreachable group must not blank the feed
        }
      }));
      setRows(feeds.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100));
    }).catch((e) => setError((e as Error).message));
  }, [userId]);

  useEffect(() => { if (view === 'activity') load(); }, [view, load]);

  return (
    <div className="shell">
      <div className="header">
        <h1>{view === 'activity' ? 'Activity' : 'My expenses'}</h1>
      </div>

      <div className="tabs" role="tablist">
        {([['activity', 'Activity'], ['mine', 'My expenses']] as const).map(([v, label]) => (
          <button key={v} role="tab" aria-selected={view === v}
            className={`tab${view === v ? ' on' : ''}`}
            onClick={() => setView(v)}>{label}</button>
        ))}
      </div>

      {view === 'mine' ? (
        <MyExpenses embedded onOpenGroup={onOpenGroup} />
      ) : error !== null ? (
        <div className="error" role="alert">{error}</div>
      ) : rows === null ? (
        <SkeletonRows count={6} />
      ) : rows.length === 0 ? (
        <div className="row">
          <span className="muted">Nothing yet — activity from all your groups lands here.</span>
        </div>
      ) : rows.map((ev, i) => {
        const day = ev.createdAt.slice(0, 10);
        const newDay = i === 0 || rows[i - 1]!.createdAt.slice(0, 10) !== day;
        return (
          <div key={ev.id}>
            {newDay && <div className="sect">{day}</div>}
            <button className="row rowbtn" style={{ width: '100%', textAlign: 'left' }}
              onClick={() => onOpenGroup(ev.groupId)}>
              <Badge id={ev.userId} name={ev.who} sm />
              <div className="grow">
                <div style={{ fontSize: '0.8125rem' }}>
                  <b>{ev.who}</b> {activityText(ev)}
                  <span className="muted"> · {ev.groupLabel}</span>
                </div>
                <div className="meta">{ev.createdAt.slice(0, 16).replace('T', ' ')}</div>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}
