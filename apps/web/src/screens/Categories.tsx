/**
 * Manage categories (issue #18) — its own page, per the owner's request.
 *
 * The shipped taxonomy lives in @slytab/core; a group may rename any entry
 * (keep the snark or drop it), hide the ones it never uses, and move a
 * heading up or down. Only the differences are sent to the API, so a group
 * that changes nothing stores nothing and keeps inheriting improvements to
 * the defaults.
 */

import { useEffect, useMemo, useState } from 'react';

import { resolveCategories, type CategoryOverride } from '@slytab/core';

import { api, type Group } from '../api';

type Overrides = Record<string, CategoryOverride>;

/** Drop entries that no longer differ from the shipped defaults. */
function prune(overrides: Overrides): Overrides {
  const out: Overrides = {};
  for (const [slug, o] of Object.entries(overrides)) {
    const entry: CategoryOverride = {};
    if (typeof o.label === 'string' && o.label.trim() !== '') entry.label = o.label.trim();
    if (o.hidden === true) entry.hidden = true;
    if (typeof o.sortOrder === 'number') entry.sortOrder = o.sortOrder;
    if (Object.keys(entry).length > 0) out[slug] = entry;
  }
  return out;
}

export function CategoriesScreen({ group, onBack }: { group: Group; onBack: () => void }) {
  const [overrides, setOverrides] = useState<Overrides | null>(null);
  const [saved, setSaved] = useState<Overrides>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.groupCategories(group.id)
      .then((r) => {
        if (!live) return;
        setOverrides(r.overrides ?? {});
        setSaved(r.overrides ?? {});
      })
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [group.id]);

  const tree = useMemo(() => resolveCategories(overrides ?? {}), [overrides]);
  const dirty = useMemo(
    () => JSON.stringify(prune(overrides ?? {})) !== JSON.stringify(prune(saved)),
    [overrides, saved],
  );
  const visibleCount = useMemo(
    () => tree.flatMap((h) => [h, ...h.children]).filter((c) => !c.hidden).length,
    [tree],
  );

  function patch(slug: string, change: CategoryOverride) {
    setOverrides((prev) => ({ ...(prev ?? {}), [slug]: { ...(prev?.[slug] ?? {}), ...change } }));
  }

  /** Pin the current display order, then swap this heading with its neighbour. */
  function moveHeading(slug: string, delta: -1 | 1) {
    const order = tree.map((h) => h.slug);
    const from = order.indexOf(slug);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= order.length) return;
    const moved = order[from]!;
    order[from] = order[to]!;
    order[to] = moved;
    setOverrides((prev) => {
      const next = { ...(prev ?? {}) };
      order.forEach((s, i) => { next[s] = { ...(next[s] ?? {}), sortOrder: i }; });
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = prune(overrides ?? {});
      const r = await api.saveGroupCategories(group.id, body);
      setOverrides(r.overrides ?? {});
      setSaved(r.overrides ?? {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (overrides === null) {
    return (
      <div className="shell">
        <div className="header">
          <button className="btn sm" onClick={onBack} aria-label="Back">‹</button>
          <h1 style={{ fontSize: '1.1875rem' }}>Categories</h1>
        </div>
        <p className="muted">{error ?? 'Loading…'}</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="header">
        <button className="btn sm" onClick={onBack} aria-label="Back">‹</button>
        <h1 style={{ fontSize: '1.1875rem' }}>Categories</h1>
        <span className="grow" />
        {dirty && (
          <button className="btn primary sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>

      <p className="muted" style={{ padding: '0 2px 8px', fontSize: '0.8125rem' }}>
        Rename anything to suit {group.name}, and hide what you never use — hidden
        categories stay on any expense already filed under them.
      </p>
      {error !== null && (
        <p style={{ color: 'var(--ss-owe)', padding: '0 2px 8px', fontSize: '0.8125rem' }}>{error}</p>
      )}

      {tree.map((heading, i) => (
        <section key={heading.slug} style={{ paddingBottom: 10 }}>
          <div className="sect" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="grow">{heading.emoji} {heading.label}</span>
            <button className="btn sm" onClick={() => moveHeading(heading.slug, -1)}
              disabled={i === 0} aria-label={`Move ${heading.label} up`}>↑</button>
            <button className="btn sm" onClick={() => moveHeading(heading.slug, 1)}
              disabled={i === tree.length - 1} aria-label={`Move ${heading.label} down`}>↓</button>
          </div>
          {[heading, ...heading.children].map((cat) => (
            <div className="row" key={cat.slug}
              style={{ gap: 8, opacity: cat.hidden ? 0.55 : 1, flexWrap: 'wrap' }}>
              <span aria-hidden="true">{cat.emoji}</span>
              <label className="grow" style={{ minWidth: 140 }}>
                <input
                  value={cat.label}
                  onChange={(e) => patch(cat.slug, { label: e.target.value })}
                  maxLength={60}
                  aria-label={`Label for ${cat.defaultLabel}`}
                  style={{
                    width: '100%', background: 'var(--ss-surface-2)', color: 'var(--ss-text)',
                    border: '1px solid var(--ss-outline)', borderRadius: 8, padding: '6px 10px',
                    font: '400 0.84375rem var(--ss-font-body)',
                  }} />
              </label>
              {cat.renamed && (
                <button className="btn sm" onClick={() => patch(cat.slug, { label: '' })}
                  title={`Reset to "${cat.defaultLabel}"`}>Reset</button>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.8125rem' }}>
                <input type="checkbox" checked={!cat.hidden}
                  disabled={!cat.hidden && visibleCount === 1}
                  onChange={(e) => patch(cat.slug, { hidden: !e.target.checked })} />
                Show
              </label>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
