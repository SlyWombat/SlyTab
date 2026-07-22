import { useState, type FormEvent } from 'react';
import { api, ApiFailure, type User } from '../api';
import { Mark } from '../ui';

export function Auth({ onSignedIn, joinPending }: {
  onSignedIn: (token: string, user: User) => void;
  joinPending: boolean;
}) {
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = mode === 'create'
        ? await api.register(email, password, displayName)
        : await api.login(email, password);
      onSignedIn(result.token, result.user);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'something went wrong — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <Mark size={56} />
      <h1 style={{ font: '600 32px/1.2 var(--ss-font-display)', letterSpacing: '-0.02em' }}>
        Sly<span style={{ color: 'var(--ss-text-2)' }}>Tab</span>
      </h1>
      <p style={{ color: 'var(--ss-text-2)', maxWidth: '36ch' }}>
        Split expenses with the people you actually share life with.
      </p>
      {joinPending && <p className="muted">Sign in to accept your group invite.</p>}

      <form onSubmit={submit} style={{ width: 'min(340px, 100%)', textAlign: 'left' }}>
        {error && <div className="error" role="alert">{error}</div>}
        {mode === 'create' && (
          <label className="field"><span>Your name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} />
          </label>
        )}
        <label className="field"><span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label className="field"><span>Password{mode === 'create' ? ' (10+ characters)' : ''}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            required minLength={mode === 'create' ? 10 : 1} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} />
        </label>
        <button className="btn primary block" disabled={busy}>
          {busy ? '…' : mode === 'create' ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <button className="link-btn" onClick={() => { setMode(mode === 'create' ? 'signin' : 'create'); setError(null); }}>
        {mode === 'create' ? 'Already have an account? Sign in' : 'New here? Create an account'}
      </button>
    </div>
  );
}
