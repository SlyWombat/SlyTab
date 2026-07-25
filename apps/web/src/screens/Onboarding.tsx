import { useState, type FormEvent } from 'react';
import { CURRENCIES, CURRENCY_NAMES } from '@slytab/core';
import { api, type User } from '../api';
import { Mark } from '../ui';

/**
 * Issue #36: first-run welcome. Shown once (server `onboardedAt` is null),
 * it greets the user and captures the key things the app needs — their
 * name and home/base currency — plus optional payment handles, then marks
 * onboarding complete. Invite-joins flow straight into their group after.
 */
export function Onboarding({ user, onDone }: { user: User; onDone: (u: User) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currency, setCurrency] = useState(user.defaultCurrency || guessCurrency());
  const [interac, setInterac] = useState(user.paymentHandles.interacEmail ?? '');
  const [showHandles, setShowHandles] = useState(false);
  const [paypal, setPaypal] = useState(user.paymentHandles.paypalMe ?? '');
  const [venmo, setVenmo] = useState(user.paymentHandles.venmo ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patchMe({
        displayName: displayName.trim(),
        defaultCurrency: currency.toUpperCase(),
        paymentHandles: {
          ...(interac ? { interacEmail: interac } : {}),
          ...(paypal ? { paypalMe: paypal } : {}),
          ...(venmo ? { venmo } : {}),
        },
        onboarded: true,
      });
      onDone(updated);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="center" style={{ padding: '32px 20px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <Mark size={44} />
        <h1 style={{ font: '600 1.5rem var(--ss-font-display)', letterSpacing: '-0.01em' }}>
          Welcome to SlyTab
        </h1>
        <p className="muted" style={{ textAlign: 'center', maxWidth: 380 }}>
          Split expenses with family and friends — no math, no awkward reminders.
          Two quick things and you're set.
        </p>
      </div>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 380, marginTop: 8 }}>
        {error && <div className="error" role="alert">{error}</div>}
        <label className="field"><span>What should we call you?</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            required maxLength={80} placeholder="Your name" />
        </label>
        <label className="field">
          <span>Your home currency — your overall balance shows in this</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c} — {CURRENCY_NAMES[c]}</option>)}
          </select>
        </label>
        {!showHandles ? (
          <button type="button" className="btn block" style={{ marginBottom: 8 }}
            onClick={() => setShowHandles(true)}>
            ＋ Add how people pay you (optional)
          </button>
        ) : (
          <>
            <label className="field"><span>Interac e-Transfer email</span>
              <input type="email" value={interac} onChange={(e) => setInterac(e.target.value)} placeholder="you@example.com" />
            </label>
            <label className="field"><span>PayPal.Me username</span>
              <input value={paypal} onChange={(e) => setPaypal(e.target.value)} placeholder="yourname" />
            </label>
            <label className="field"><span>Venmo username</span>
              <input value={venmo} onChange={(e) => setVenmo(e.target.value)} placeholder="yourname" />
            </label>
          </>
        )}
        <button className="btn primary block" disabled={busy || displayName.trim() === ''}>
          {busy ? 'Setting up…' : 'Get started'}
        </button>
        <p className="muted" style={{ textAlign: 'center', fontSize: '0.75rem', paddingTop: 8 }}>
          You can change any of this later in Profile.
        </p>
      </form>
    </div>
  );
}

/** Best-effort home currency from the browser locale (overridable). */
function guessCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region ?? '';
    const byRegion: Record<string, string> = {
      CA: 'CAD', US: 'USD', GB: 'GBP', AU: 'AUD', NZ: 'NZD',
      CL: 'CLP', AR: 'ARS', MX: 'MXN', JP: 'JPY', IN: 'INR',
    };
    const c = byRegion[region];
    if (c && CURRENCIES.includes(c as never)) return c;
  } catch { /* fall through */ }
  return 'USD';
}
