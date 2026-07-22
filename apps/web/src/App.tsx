import { useEffect, useState, type FormEvent } from 'react';
import { api, getToken, setToken, type User } from './api';
import { Auth } from './screens/Auth';
import { Home } from './screens/Home';
import { GroupScreen } from './screens/Group';
import { Mark } from './ui';

type Nav = { screen: 'home' } | { screen: 'group'; groupId: string };

/** Pull a pending invite token from /join/<token> URLs (SPA fallback). */
function pendingJoinToken(): string | null {
  const m = location.pathname.match(/\/join\/([a-f0-9]{32})$/);
  return m?.[1] ?? null;
}

/** Pull a password-reset token from /reset/<token> URLs. */
function pendingResetToken(): string | null {
  const m = location.pathname.match(/\/reset\/([a-f0-9]{64})$/);
  return m?.[1] ?? null;
}

function ResetScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="center">
      <Mark size={48} />
      <h1 style={{ font: '600 26px var(--ss-font-display)' }}>Choose a new password</h1>
      {done ? (
        <>
          <p style={{ color: 'var(--ss-text-2)' }}>Password updated. Sign in with it now.</p>
          <button className="btn primary" onClick={onDone}>Go to sign in</button>
        </>
      ) : (
        <form onSubmit={submit} style={{ width: 'min(340px, 100%)', textAlign: 'left' }}>
          {error && <div className="error" role="alert">{error}</div>}
          <label className="field"><span>New password (10+ characters)</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required minLength={10} autoComplete="new-password" />
          </label>
          <button className="btn primary block">Set password</button>
        </form>
      )}
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [nav, setNav] = useState<Nav>({ screen: 'home' });
  const [joinToken, setJoinToken] = useState<string | null>(pendingJoinToken);
  const [resetToken, setResetToken] = useState<string | null>(pendingResetToken);

  // Restore the session on load.
  useEffect(() => {
    if (getToken() === null) {
      setChecked(true);
      return;
    }
    api.me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setChecked(true));
  }, []);

  // Accept a pending invite once signed in.
  useEffect(() => {
    if (user === null || joinToken === null) return;
    api.join(joinToken)
      .then((group) => setNav({ screen: 'group', groupId: group.id }))
      .catch(() => { /* expired invite — land on Home */ })
      .finally(() => {
        setJoinToken(null);
        history.replaceState(null, '', import.meta.env.BASE_URL);
      });
  }, [user, joinToken]);

  if (!checked) return null;

  if (resetToken !== null) {
    return (
      <ResetScreen token={resetToken} onDone={() => {
        setResetToken(null);
        history.replaceState(null, '', import.meta.env.BASE_URL);
      }} />
    );
  }

  if (user === null) {
    return (
      <Auth
        joinPending={joinToken !== null}
        onSignedIn={(token, u) => { setToken(token); setUser(u); }}
      />
    );
  }

  if (nav.screen === 'group') {
    return (
      <GroupScreen
        groupId={nav.groupId}
        user={user}
        onBack={() => setNav({ screen: 'home' })}
      />
    );
  }

  return (
    <Home
      user={user}
      onUserUpdated={setUser}
      onOpenGroup={(groupId) => setNav({ screen: 'group', groupId })}
      onSignOut={() => {
        api.logout().catch(() => {});
        setToken(null);
        setUser(null);
      }}
    />
  );
}
